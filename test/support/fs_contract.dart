import 'dart:io';
import 'dart:typed_data';

import 'package:andropi/agent/agent_fs.dart';
import 'package:flutter_test/flutter_test.dart';

/// What every [AgentFs] must do the same way, whether the files are on this phone ([LocalFs]) or behind the host
/// ([RemoteFs]). Run once per implementation.
///
/// [start] returns the file system under test and a folder it can use, which this machine can also reach with
/// `dart:io` (for [LocalFs] that is any folder; for [RemoteFs] it is the root the server was given). Each test gets its
/// own folder inside it. [bigFile] is a size that needs several chunks.
void fsContract(
  String label,
  Future<({AgentFs fs, String root, Future<void> Function() close})> Function() start, {
  int bigFile = 300 * 1024,
  Directory? phoneDir,
}) {
  group('$label (contract)', () {
    late AgentFs fs;
    late String root;
    late Future<void> Function() close;
    late Directory dir;
    late Directory phone;
    var counter = 0;

    setUpAll(() async {
      final s = await start();
      fs = s.fs;
      root = s.root;
      close = s.close;
    });
    tearDownAll(() => close());

    setUp(() {
      dir = Directory('$root/t${counter++}')..createSync();
      phone = Directory.systemTemp.createTempSync('phone_');
    });
    tearDown(() {
      dir.deleteSync(recursive: true);
      phone.deleteSync(recursive: true);
    });

    String p(String rel) => '${dir.path}/$rel';

    group('list', () {
      test('reports type, size and modification time', () async {
        File(p('a.txt')).writeAsStringSync('hello');
        Directory(p('sub')).createSync();
        final entries = {for (final e in await fs.list(dir.path)) e.name: e};
        expect(entries.keys, unorderedEquals(['a.txt', 'sub']));
        expect(entries['a.txt']!.type, FsType.file);
        expect(entries['a.txt']!.size, 5);
        expect(entries['a.txt']!.path, p('a.txt'));
        expect(entries['sub']!.isDir, isTrue);
        expect(DateTime.now().difference(entries['a.txt']!.modified).inMinutes.abs(), lessThan(2));
      });

      test('a link to a folder lists as a folder and is marked as a link', () async {
        Directory(p('real')).createSync();
        Link(p('alias')).createSync(p('real'));
        final entries = {for (final e in await fs.list(dir.path)) e.name: e};
        expect(entries['alias']!.isDir, isTrue);
        expect(entries['alias']!.isLink, isTrue);
        expect(entries['real']!.isLink, isFalse);
      });

      test('a broken link is reported as missing', () async {
        Link(p('dangling')).createSync(p('nowhere'));
        final e = (await fs.list(dir.path)).single;
        expect(e.type, FsType.missing);
        expect(e.isLink, isTrue);
      });

      test('detectGit marks only folders that contain .git, and only when asked', () async {
        Directory(p('repo/.git')).createSync(recursive: true);
        Directory(p('plain')).createSync();
        File(p('file.txt')).writeAsStringSync('x');
        final asked = {for (final e in await fs.list(dir.path, detectGit: true)) e.name: e.isGit};
        expect(asked, {'repo': true, 'plain': false, 'file.txt': false});
        expect((await fs.list(dir.path)).any((e) => e.isGit), isFalse);
      });

      test('fails for a folder that does not exist', () async {
        await expectLater(fs.list(p('missing')), throwsA(anything));
      });
    });

    group('stat and exists', () {
      test('stat tells files, folders and nothing apart', () async {
        File(p('a.txt')).writeAsStringSync('abc');
        Directory(p('d')).createSync();
        final file = await fs.stat(p('a.txt'));
        expect([file.type, file.size], [FsType.file, 3]);
        expect(file.modified!.difference(DateTime.now()).inMinutes.abs(), lessThan(2));
        expect((await fs.stat(p('d'))).isDir, isTrue);
        final none = await fs.stat(p('nope'));
        expect(none.exists, isFalse);
        expect(none.modified, isNull);
      });

      test('exists covers files and folders, but not a broken link or a path below a file', () async {
        File(p('a.txt')).writeAsStringSync('x');
        Directory(p('d')).createSync();
        Link(p('dangling')).createSync(p('nowhere'));
        expect(await fs.exists(p('a.txt')), isTrue);
        expect(await fs.exists(p('d')), isTrue);
        expect(await fs.exists(p('nope')), isFalse);
        expect(await fs.exists(p('dangling')), isFalse);
        expect(await fs.exists(p('a.txt/inside')), isFalse);
      });
    });

    group('read and write', () {
      test('round-trips bytes and text, including non-ASCII', () async {
        final bytes = Uint8List.fromList([0, 1, 2, 250, 255]);
        await fs.write(p('bin'), bytes);
        expect(await fs.read(p('bin')), bytes);
        await fs.writeString(p('t.txt'), 'héllo ✓');
        expect(await fs.readString(p('t.txt')), 'héllo ✓');
        expect(File(p('t.txt')).readAsStringSync(), 'héllo ✓');
      });

      test('writing replaces what was there and returns the new stat', () async {
        await fs.writeString(p('t.txt'), 'a long first version');
        final stat = await fs.writeString(p('t.txt'), 'short');
        expect(await fs.readString(p('t.txt')), 'short');
        expect(stat.size, 5);
        expect(stat.modified!.millisecondsSinceEpoch, File(p('t.txt')).lastModifiedSync().millisecondsSinceEpoch);
      });

      test('an empty file round-trips', () async {
        await fs.write(p('empty'), Uint8List(0));
        expect(File(p('empty')).lengthSync(), 0);
        expect(await fs.read(p('empty')), isEmpty);
      });

      test('a file bigger than one chunk round-trips', () async {
        final data = Uint8List(bigFile);
        for (var i = 0; i < data.length; i++) {
          data[i] = (i * 7 + i ~/ 251) & 0xff;
        }
        final stat = await fs.write(p('big.bin'), data);
        expect(stat.size, bigFile);
        expect(File(p('big.bin')).readAsBytesSync(), data);
        expect(await fs.read(p('big.bin')), data);
      });

      test('reading a missing file fails', () async {
        await expectLater(fs.read(p('nope')), throwsA(anything));
        await expectLater(fs.readString(p('nope')), throwsA(anything));
      });

      test('writing where the folder is missing fails and leaves nothing behind', () async {
        await expectLater(fs.writeString(p('no/such/dir/f.txt'), 'x'), throwsA(anything));
        expect(Directory(p('no')).existsSync(), isFalse);
      });

      test('createFile makes parents, and leaves an existing file untouched', () async {
        await fs.createFile(p('a/b/new.txt'));
        expect(await fs.readString(p('a/b/new.txt')), '');
        await fs.writeString(p('a/b/new.txt'), 'kept');
        await fs.createFile(p('a/b/new.txt'));
        expect(await fs.readString(p('a/b/new.txt')), 'kept');
      });

      test('a save based on what was read goes through; one based on an older version is refused', () async {
        final first = await fs.writeString(p('t.txt'), 'v1');
        final second = await fs.writeString(p('t.txt'), 'v2', expectModified: first.modified);
        expect(await fs.readString(p('t.txt')), 'v2');

        // Someone else saves in between (the agent, in real life).
        File(p('t.txt')).writeAsStringSync('theirs');
        File(p('t.txt')).setLastModifiedSync(DateTime.now().add(const Duration(seconds: 5)));
        await expectLater(
          fs.writeString(p('t.txt'), 'mine', expectModified: second.modified),
          throwsA(isA<FsConflictException>()),
        );
        expect(File(p('t.txt')).readAsStringSync(), 'theirs');
      });

      test('a save based on a file that has since been deleted is refused', () async {
        final stat = await fs.writeString(p('t.txt'), 'v1');
        File(p('t.txt')).deleteSync();
        await expectLater(fs.writeString(p('t.txt'), 'v2', expectModified: stat.modified), throwsA(isA<FsConflictException>()));
        expect(File(p('t.txt')).existsSync(), isFalse);
      });

      test('a refused big save leaves no half-written file behind', () async {
        final first = await fs.write(p('big.bin'), Uint8List(bigFile));
        File(p('big.bin')).setLastModifiedSync(DateTime.now().add(const Duration(seconds: 5)));
        await expectLater(
          fs.write(p('big.bin'), Uint8List(bigFile)..fillRange(0, 100, 1), expectModified: first.modified),
          throwsA(isA<FsConflictException>()),
        );
        expect(File(p('big.bin')).readAsBytesSync().every((b) => b == 0), isTrue);
        expect(dir.listSync().map((e) => e.path.split('/').last), ['big.bin'], reason: 'no staging file');
      });
    });

    group('folders', () {
      test('mkdir is recursive and can be repeated', () async {
        await fs.mkdir(p('x/y/z'));
        await fs.mkdir(p('x/y/z'));
        expect((await fs.stat(p('x/y/z'))).isDir, isTrue);
      });

      test('rename moves a file and a folder', () async {
        File(p('a.txt')).writeAsStringSync('x');
        await fs.rename(p('a.txt'), p('b.txt'));
        expect(File(p('a.txt')).existsSync(), isFalse);
        expect(File(p('b.txt')).readAsStringSync(), 'x');

        File(p('d/inner.txt')).createSync(recursive: true);
        await fs.rename(p('d'), p('e'));
        expect(Directory(p('d')).existsSync(), isFalse);
        expect(File(p('e/inner.txt')).existsSync(), isTrue);
      });
    });

    group('copy', () {
      test('copies a file and leaves the original', () async {
        File(p('a.txt')).writeAsStringSync('x');
        await fs.copy(p('a.txt'), p('b.txt'));
        expect(File(p('a.txt')).readAsStringSync(), 'x');
        expect(File(p('b.txt')).readAsStringSync(), 'x');
      });

      test('copies a folder with everything inside it, links included', () async {
        File(p('src/a.txt')).createSync(recursive: true);
        File(p('src/a.txt')).writeAsStringSync('A');
        File(p('src/deep/er/b.txt')).createSync(recursive: true);
        File(p('src/deep/er/b.txt')).writeAsStringSync('B');
        Directory(p('src/empty')).createSync();
        Link(p('src/link')).createSync('a.txt');

        await fs.copy(p('src'), p('dst'));

        expect(File(p('dst/a.txt')).readAsStringSync(), 'A');
        expect(File(p('dst/deep/er/b.txt')).readAsStringSync(), 'B');
        expect(Directory(p('dst/empty')).existsSync(), isTrue);
        expect(Link(p('dst/link')).targetSync(), 'a.txt');
        expect(File(p('src/a.txt')).readAsStringSync(), 'A');
      });
    });

    group('delete', () {
      test('deletes a file', () async {
        File(p('a.txt')).writeAsStringSync('x');
        await fs.delete(p('a.txt'));
        expect(File(p('a.txt')).existsSync(), isFalse);
      });

      test('deletes a folder recursively, but refuses a non-empty one otherwise', () async {
        File(p('d/inner.txt')).createSync(recursive: true);
        await expectLater(fs.delete(p('d')), throwsA(anything));
        expect(File(p('d/inner.txt')).existsSync(), isTrue);
        await fs.delete(p('d'), recursive: true);
        expect(Directory(p('d')).existsSync(), isFalse);
      });

      test('deleting something that is not there fails', () async {
        await expectLater(fs.delete(p('nope')), throwsA(anything));
      });
    });

    group('between the phone and the agent', () {
      test('upload puts a phone file in place, small and bigger than a chunk', () async {
        File('${phone.path}/small.pdf').writeAsStringSync('pdf');
        final big = Uint8List(bigFile)..fillRange(0, bigFile, 9);
        File('${phone.path}/big.bin').writeAsBytesSync(big);
        File('${phone.path}/empty').writeAsBytesSync([]);
        await fs.mkdir(p('proj'));
        await fs.upload('${phone.path}/small.pdf', p('proj/small.pdf'));
        await fs.upload('${phone.path}/big.bin', p('proj/big.bin'));
        await fs.upload('${phone.path}/empty', p('proj/empty'));
        expect(File(p('proj/small.pdf')).readAsStringSync(), 'pdf');
        expect(File(p('proj/big.bin')).readAsBytesSync(), big);
        expect(File(p('proj/empty')).lengthSync(), 0);
      });

      test('toPhoneFile gives a path on the phone with the same contents', () async {
        final data = Uint8List(bigFile)..fillRange(0, bigFile, 3);
        File(p('report.bin')).writeAsBytesSync(data);
        final local = await fs.toPhoneFile(p('report.bin'));
        expect(local.endsWith('report.bin'), isTrue);
        expect(File(local).readAsBytesSync(), data);
      });

      test('toPhoneFile refuses a folder and a missing file', () async {
        Directory(p('d')).createSync();
        await expectLater(fs.toPhoneFile(p('d')), throwsA(anything));
        await expectLater(fs.toPhoneFile(p('nope')), throwsA(anything));
      });
    });
  });
}
