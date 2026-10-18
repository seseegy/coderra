import 'dart:io';

import 'package:andropi/agent/agent_fs.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fs_contract.dart';

void main() {
  fsContract('LocalFs', () async {
    final root = Directory.systemTemp.createTempSync('local_fs_');
    return (fs: const LocalFs(), root: root.path, close: () async => root.deleteSync(recursive: true));
  });

  group('LocalFs specifics', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('local_fs_extra_'));
    tearDown(() => dir.deleteSync(recursive: true));

    test('toPhoneFile is the path itself, since the files are already on the phone', () async {
      File('${dir.path}/a.txt').writeAsStringSync('x');
      expect(await const LocalFs().toPhoneFile('${dir.path}/a.txt'), '${dir.path}/a.txt');
    });

    test('the conflict message names the file', () {
      expect(const FsConflictException('/a/b/notes.md').toString(), 'notes.md changed since it was opened');
    });
  });

  group('path helpers', () {
    test('baseName', () {
      expect(baseName('/a/b/c.txt'), 'c.txt');
      expect(baseName('/a/b/'), 'b');
      expect(baseName('/'), '', reason: 'the root has no name; callers show "/" themselves');
      expect(baseName('plain'), 'plain');
    });

    test('parentPath', () {
      expect(parentPath('/a/b/c.txt'), '/a/b');
      expect(parentPath('/a/b/'), '/a');
      expect(parentPath('/a'), '/');
      expect(parentPath('/'), '/');
      expect(parentPath('plain'), '.');
    });

    test('joinPath', () {
      expect(joinPath('/a', 'b'), '/a/b');
      expect(joinPath('/a/', 'b'), '/a/b');
      expect(joinPath('/', 'b'), '/b');
    });

    test('decodeLenient never throws on bad UTF-8', () {
      expect(decodeLenient([104, 105]), 'hi');
      expect(decodeLenient([104, 0xff, 105]), contains('h'));
    });
  });
}
