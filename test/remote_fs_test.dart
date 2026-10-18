import 'dart:io';
import 'dart:typed_data';

import 'package:andropi/agent/agent_client.dart' show AgentError;
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/agent/remote_fs.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fs_contract.dart';
import 'support/fs_server.dart';

/// RemoteFs against the real Node implementation (agent/src/fs.ts) over a JSONL pipe: the Dart and Node halves of
/// the protocol are tested against each other, not against a mock of one of them.
void main() {
  final unavailable = FsServer.unavailable;
  if (unavailable != null) {
    // CI sets CODERRA_REQUIRE_NODE_SIDE so that a broken setup fails instead of quietly skipping these tests.
    if (Platform.environment['CODERRA_REQUIRE_NODE_SIDE'] != null) {
      test('RemoteFs against the Node host', () => fail('the Node side is required here but unavailable: $unavailable'));
    } else {
      test('RemoteFs against the Node host', () {}, skip: 'needs the Node side: $unavailable');
    }
    return;
  }

  /// A base folder with a workspace root, a read-only root, and a folder next to them that is not a root.
  late Directory base;
  late Directory cache;

  setUpAll(() {
    base = Directory.systemTemp.createTempSync('remote_fs_');
    for (final d in ['ws', 'skills', 'outside']) {
      Directory('${base.path}/$d').createSync();
    }
    File('${base.path}/skills/SKILL.md').writeAsStringSync('skill');
    File('${base.path}/outside/secret.txt').writeAsStringSync('TOP SECRET');
    cache = Directory('${base.path}/cache')..createSync();
  });
  tearDownAll(() => base.deleteSync(recursive: true));

  Future<({FsServer server, RemoteFs fs})> open({int chunk = 64 * 1024, Map<String, Object?> limits = const {}}) async {
    final server = await FsServer.start(
      roots: [
        {'path': '${base.path}/ws'},
        {'path': '${base.path}/skills', 'readOnly': true},
      ],
      limits: limits,
    );
    return (server: server, fs: RemoteFs(server.call, phoneCache: cache, chunkSize: chunk));
  }

  // Small chunks so that the 300 KB test files need several round trips in both directions.
  fsContract('RemoteFs', () async {
    final s = await open();
    return (fs: s.fs, root: '${base.path}/ws', close: s.server.close);
  });

  group('RemoteFs specifics', () {
    late FsServer server;
    late RemoteFs fs;
    setUp(() async {
      final s = await open();
      server = s.server;
      fs = s.fs;
    });
    tearDown(() => server.close());

    Future<String?> codeOf(Future<Object?> f) async {
      try {
        await f;
        return 'ok';
      } on AgentError catch (e) {
        return e.code;
      }
    }

    String ws(String rel) => '${base.path}/ws/$rel';

    test('errors carry the host\'s reason', () async {
      expect(await codeOf(fs.read(ws('missing'))), 'ENOENT');
      expect(await codeOf(fs.list(ws('missing'))), 'ENOENT');
      Directory(ws('d')).createSync();
      expect(await codeOf(fs.read(ws('d'))), 'EISDIR');
      expect(await codeOf(fs.mkdir(ws('d/../d/x/../..'))), 'ok');
      File(ws('taken')).writeAsStringSync('x');
      expect(await codeOf(fs.rename(ws('taken'), ws('d'))), 'EEXIST');
      expect(await codeOf(fs.copy(ws('taken'), ws('d'))), 'EEXIST');
      await File(ws('d/inner')).create();
      expect(await codeOf(fs.delete(ws('d'))), 'ENOTEMPTY');
      File(ws('d/inner')).deleteSync();
      File(ws('taken')).deleteSync();
      Directory(ws('d')).deleteSync();
    });

    test('nothing outside the roots can be reached, and the message does not depend on whether it exists', () async {
      for (final path in ['${base.path}/outside/secret.txt', '${base.path}/outside', '/etc/passwd', '/nope/nope', '${base.path}/ws/../outside/secret.txt']) {
        expect(await codeOf(fs.read(path)), 'outside_root', reason: path);
        expect(await codeOf(fs.list(path)), 'outside_root', reason: path);
        expect(await codeOf(fs.stat(path)), 'outside_root', reason: path);
        expect(await codeOf(fs.writeString(path, 'x')), 'outside_root', reason: path);
        expect(await codeOf(fs.delete(path, recursive: true)), 'outside_root', reason: path);
      }
      expect(File('${base.path}/outside/secret.txt').readAsStringSync(), 'TOP SECRET');
    });

    test('a link out of the workspace is listed as unusable and cannot be followed', () async {
      Link(ws('escape')).createSync('${base.path}/outside');
      addTearDown(() => Link(ws('escape')).deleteSync());
      final entry = (await fs.list('${base.path}/ws')).singleWhere((e) => e.name == 'escape');
      expect(entry.type, FsType.missing);
      expect(entry.isLink, isTrue);
      expect(await codeOf(fs.read(ws('escape/secret.txt'))), 'outside_root');
      expect(await codeOf(fs.writeString(ws('escape/new.txt'), 'x')), 'outside_root');
      expect(File('${base.path}/outside/new.txt').existsSync(), isFalse);
    });

    test('the read-only root can be read and copied from, never changed', () async {
      final skill = '${base.path}/skills/SKILL.md';
      expect(await fs.readString(skill), 'skill');
      expect(await codeOf(fs.writeString(skill, 'hacked')), 'read_only');
      expect(await codeOf(fs.delete(skill)), 'read_only');
      expect(await codeOf(fs.mkdir('${base.path}/skills/new')), 'read_only');
      await fs.copy(skill, ws('SKILL.copy.md'));
      expect(File(ws('SKILL.copy.md')).readAsStringSync(), 'skill');
      File(ws('SKILL.copy.md')).deleteSync();
      expect(File(skill).readAsStringSync(), 'skill');
    });

    test('a file over the host\'s size limit is refused and nothing is left on the server', () async {
      await server.close();
      final s = await open(chunk: 8, limits: {'maxWrite': 20, 'chunk': 8});
      server = s.server;
      await expectLater(s.fs.write(ws('big'), Uint8List(100)), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'too_large')));
      expect(Directory('${base.path}/ws').listSync().where((e) => e.path.contains('.coderra-up-')), isEmpty);
      expect(File(ws('big')).existsSync(), isFalse);
    });

    test('reading a file that is too large for memory is refused up front', () async {
      File(ws('huge')).writeAsBytesSync(Uint8List(5000));
      addTearDown(() => File(ws('huge')).deleteSync());
      final small = RemoteFs(server.call, phoneCache: cache, maxRead: 1000);
      await expectLater(small.read(ws('huge')), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'too_large')));
    });

    test('toPhoneFile reuses what it already fetched, and fetches again when the file changed', () async {
      File(ws('doc.txt')).writeAsStringSync('v1');
      addTearDown(() => File(ws('doc.txt')).deleteSync());
      final first = await fs.toPhoneFile(ws('doc.txt'));
      File(first).writeAsStringSync('v1'); // same size; pretend nothing needed fetching
      final modified = File(first).lastModifiedSync();
      expect(await fs.toPhoneFile(ws('doc.txt')), first);
      expect(File(first).lastModifiedSync(), modified, reason: 'not downloaded a second time');

      File(ws('doc.txt')).writeAsStringSync('version two');
      File(ws('doc.txt')).setLastModifiedSync(DateTime.now().add(const Duration(seconds: 5)));
      final second = await fs.toPhoneFile(ws('doc.txt'));
      expect(second, isNot(first));
      expect(File(second).readAsStringSync(), 'version two');
    });
  });
}
