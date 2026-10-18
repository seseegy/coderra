import 'dart:io';
import 'dart:typed_data';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/agent/remote_fs.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/daemon.dart';
import 'support/fake_host.dart';

void main() {
  late Directory tmp;
  late Directory cache;
  late File phoneFile;
  late FakeHost host;
  late Uint8List data;

  RemoteFs fsOver(FakeHost h, {int chunk = 100, bool online = true, int maxRead = 64 * 1024 * 1024}) =>
      RemoteFs(h.call, phoneCache: cache, chunkSize: chunk, maxRead: maxRead, waitOnline: online ? h.waitOnline : null);

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('cr-transfer-');
    cache = Directory('${tmp.path}/cache')..createSync();
    data = bytes(1050);
    phoneFile = File('${tmp.path}/photo.bin')..writeAsBytesSync(data);
    host = FakeHost();
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  group('upload', () {
    test('reports its progress piece by piece, up to the total', () async {
      final seen = <(int, int)>[];
      await fsOver(host).upload(phoneFile.path, '/ws/a.bin', onProgress: (d, t) => seen.add((d, t)));
      expect(seen.map((e) => e.$1), [for (var i = 100; i < 1050; i += 100) i, 1050]);
      expect(seen.every((e) => e.$2 == 1050), isTrue);
      expect(host.files['/ws/a.bin'], data);
    });

    test('stopping it leaves nothing on the server: no file, and what was staged is thrown away', () async {
      final token = CancelToken();
      var calls = 0;
      final h = host..fault = (type, args) => type == 'fs_write' && args['abort'] != true && ++calls == 4 ? () { token.cancel(); return null; }() : null;
      await expectLater(fsOver(h).upload(phoneFile.path, '/ws/a.bin', cancel: token), throwsA(isA<Cancelled>()));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(host.files, isEmpty);
      expect(host.uploads, isEmpty, reason: 'the host was told to drop the partial upload');
    });

    test('a piece that never arrived is sent again after the connection is back', () async {
      var n = 0;
      host.fault = (type, args) => type == 'fs_write' && args['status'] != true && args['offset'] == 300 && ++n == 1 ? 'before' : null;
      await fsOver(host).upload(phoneFile.path, '/ws/a.bin');
      expect(host.files['/ws/a.bin'], data);
      expect(host.onlineCalls, 1);
      expect(host.log.where((l) => l.startsWith('fs_write@300') && !l.contains('status')).length, 2);
    });

    test('a piece that arrived but whose answer was lost is not sent twice', () async {
      var n = 0;
      host.fault = (type, args) => type == 'fs_write' && args['status'] != true && args['offset'] == 300 && ++n == 1 ? 'after' : null;
      await fsOver(host).upload(phoneFile.path, '/ws/a.bin');
      expect(host.files['/ws/a.bin'], data, reason: 'not a byte doubled or missing');
      expect(host.log.where((l) => l.startsWith('fs_write@300') && !l.contains('status')).length, 1);
    });

    test('the last piece arrived, the file is in place, only the answer was lost: that is success', () async {
      host.fault = (type, args) => type == 'fs_write' && args['final'] == true ? 'after' : null;
      var once = true;
      final fault = host.fault!;
      host.fault = (t, a) {
        if (a['status'] == true) return null;
        if (t == 'fs_write' && a['final'] == true && once) {
          once = false;
          return fault(t, a);
        }
        return null;
      };
      await fsOver(host).upload(phoneFile.path, '/ws/a.bin');
      expect(host.files['/ws/a.bin'], data);
      expect(host.log.where((l) => l.startsWith('fs_write@1000') && !l.contains('status')).length, 1, reason: 'the last piece was not sent again');
    });

    test('the last piece did not arrive, the host lost the upload, and an old file of the same size is there: sent again, not mistaken for done', () async {
      host
        ..wipeUploadsWhenBackOnline = true
        ..files['/ws/a.bin'] = bytes(1050, 9)
        ..mtimes['/ws/a.bin'] = 5;
      var once = true;
      host.fault = (t, a) {
        if (t == 'fs_write' && a['status'] != true && a['final'] == true && once) {
          once = false;
          return 'before';
        }
        return null;
      };
      await fsOver(host).upload(phoneFile.path, '/ws/a.bin');
      expect(host.files['/ws/a.bin'], data, reason: 'the new contents, not the old file');
    });

    test('a server that lost the upload (it restarted) gets the file again from the start', () async {
      var n = 0;
      host
        ..wipeUploadsWhenBackOnline = true
        ..fault = (t, a) => t == 'fs_write' && a['status'] != true && a['offset'] == 600 && ++n == 1 ? 'before' : null;
      await fsOver(host).upload(phoneFile.path, '/ws/a.bin');
      expect(host.files['/ws/a.bin'], data);
      expect(host.log.where((l) => l.startsWith('fs_write@0')).length, 2, reason: 'started over once');
    });

    test('it gives up if the server keeps losing it, and says so', () async {
      host
        ..wipeUploadsWhenBackOnline = true
        ..fault = (t, a) => t == 'fs_write' && a['status'] != true && a['offset'] == 200 ? 'before' : null;
      await expectLater(fsOver(host).upload(phoneFile.path, '/ws/a.bin'), throwsA(isA<AgentError>().having((e) => e.message, 'message', contains('kept being lost'))));
      expect(host.files, isEmpty);
    });

    test('without a way to wait for the connection, a drop ends the transfer (and the partial upload is dropped)', () async {
      host.fault = (t, a) => t == 'fs_write' && a['status'] != true && a['offset'] == 300 ? 'before' : null;
      await expectLater(fsOver(host, online: false).upload(phoneFile.path, '/ws/a.bin'), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'connection_lost')));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(host.uploads, isEmpty);
    });

    test('a connection that does not come back is an error the user can read', () async {
      host
        ..onlineError = AgentError('The connection to the server did not come back.', code: 'offline')
        ..fault = (t, a) => t == 'fs_write' && a['offset'] == 300 ? 'before' : null;
      await expectLater(fsOver(host).upload(phoneFile.path, '/ws/a.bin'), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'offline')));
      expect(host.files, isEmpty);
    });
  });

  group('download', () {
    setUp(() {
      host.files['/ws/big.bin'] = data;
      host.mtimes['/ws/big.bin'] = 7;
    });

    test('reports progress and leaves only the finished file', () async {
      final seen = <int>[];
      final path = await fsOver(host).toPhoneFile('/ws/big.bin', onProgress: (d, t) => seen.add(d));
      expect(File(path).readAsBytesSync(), data);
      expect(seen.last, 1050);
      expect(seen, orderedEquals([...seen]..sort()));
      expect(Directory(File(path).parent.path).listSync().map((e) => e.path.split('/').last), ['big.bin'], reason: 'no .part left');
    });

    test('a file bigger than what may be held in memory still downloads to disk', () async {
      final fs = fsOver(host, maxRead: 500);
      expect(File(await fs.toPhoneFile('/ws/big.bin')).lengthSync(), 1050);
      await expectLater(fs.read('/ws/big.bin'), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'too_large')));
    });

    test('an unchanged file is not fetched again, but still reports it is all there', () async {
      final fs = fsOver(host);
      await fs.toPhoneFile('/ws/big.bin');
      final reads = host.log.where((l) => l.startsWith('fs_read')).length;
      final seen = <int>[];
      await fs.toPhoneFile('/ws/big.bin', onProgress: (d, t) => seen.add(d));
      expect(host.log.where((l) => l.startsWith('fs_read')).length, reads);
      expect(seen, [1050]);
    });

    test('stopping it removes the partial file', () async {
      final token = CancelToken();
      await expectLater(
        fsOver(host).toPhoneFile('/ws/big.bin', onProgress: (d, t) => d >= 300 ? token.cancel() : null, cancel: token),
        throwsA(isA<Cancelled>()),
      );
      expect(cache.listSync(recursive: true).whereType<File>(), isEmpty);
    });

    test('a drop in the middle is waited out and the download goes on from the same place', () async {
      var n = 0;
      host.fault = (t, a) => t == 'fs_read' && a['offset'] == 500 && ++n == 1 ? 'before' : null;
      final path = await fsOver(host).toPhoneFile('/ws/big.bin');
      expect(File(path).readAsBytesSync(), data);
      expect(host.log.where((l) => l.startsWith('fs_read@0')).length, 1, reason: 'did not start over');
      expect(host.onlineCalls, 1);
    });

    test('two askers for the same file share one download', () async {
      final fs = fsOver(host);
      final results = await Future.wait([fs.toPhoneFile('/ws/big.bin'), fs.toPhoneFile('/ws/big.bin')]);
      expect(results[0], results[1]);
      expect(host.log.where((l) => l.startsWith('fs_read@0')).length, 1);
    });

    test('a file that is not there, or is a folder, is said so', () async {
      await expectLater(fsOver(host).toPhoneFile('/ws/nope'), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'ENOENT')));
    });
  });

  group('across a real dropped connection', () {
    final skip = TestDaemon.skip;
    late TestDaemon daemon;
    late ProcessBackend backend;
    late AgentClient client;
    late RemoteFs fs;

    setUp(() async {
      if (skip != null) return;
      daemon = await TestDaemon.start();
      backend = ProcessBackend();
      client = AgentClient(backend: backend)
        ..remote = daemon.launchSpec
        ..backoff = ((_) => const Duration(milliseconds: 50));
      await client.start();
      fs = RemoteFs(client.call, phoneCache: cache, chunkSize: 16 * 1024, waitOnline: client.whenConnected);
    });
    tearDown(() async {
      if (skip != null) return;
      await client.stop();
      await daemon.dispose();
    });

    test('an upload carries on after the link is cut, and the file arrives intact', () async {
      final big = bytes(12 * 1024 * 1024, 3);
      final src = File('${tmp.path}/big.bin')..writeAsBytesSync(big);
      var cut = false;
      final target = '${daemon.workspace}/uploaded.bin';
      await fs.upload(src.path, target, onProgress: (d, t) {
        if (!cut && d > t ~/ 10) {
          cut = true;
          backend.current!.kill();
        }
      });
      expect(backend.started.length, greaterThanOrEqualTo(2), reason: 'the link really was cut and remade');
      expect(File(target).readAsBytesSync().length, big.length);
      expect(File(target).readAsBytesSync(), orderedEquals(big));
      expect(Directory(daemon.workspace).listSync().map((e) => e.path.split('/').last).where((n) => n.startsWith('.coderra-up-')), isEmpty);
    }, skip: skip);

    test('a download carries on after the link is cut, and the file arrives intact', () async {
      final big = bytes(12 * 1024 * 1024, 4);
      File('${daemon.workspace}/served.bin').writeAsBytesSync(big);
      var cut = false;
      final path = await fs.toPhoneFile('${daemon.workspace}/served.bin', onProgress: (d, t) {
        if (!cut && d > t ~/ 10) {
          cut = true;
          backend.current!.kill();
        }
      });
      expect(backend.started.length, greaterThanOrEqualTo(2));
      expect(File(path).readAsBytesSync(), orderedEquals(big));
    }, skip: skip);

    test('stopping a real upload leaves nothing on the server', () async {
      final src = File('${tmp.path}/big.bin')..writeAsBytesSync(bytes(6 * 1024 * 1024, 5));
      final token = CancelToken();
      final target = '${daemon.workspace}/never.bin';
      await expectLater(fs.upload(src.path, target, cancel: token, onProgress: (d, t) => d > t ~/ 4 ? token.cancel() : null), throwsA(isA<Cancelled>()));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(File(target).existsSync(), isFalse);
      expect(Directory(daemon.workspace).listSync().map((e) => e.path.split('/').last).where((n) => n.startsWith('.coderra-up-')), isEmpty);
    }, skip: skip);

    test('waiting for the connection: at once when it is up, an error when nothing will bring it back', () async {
      await client.whenConnected();
      await client.stop();
      await expectLater(client.whenConnected(), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'offline')));
    }, skip: skip);
  });
}
