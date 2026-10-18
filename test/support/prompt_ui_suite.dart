import 'dart:convert';
import 'dart:io';

import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/ui/chat_extras.dart';
import 'package:andropi/ui/new_chat_sheet.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'files_ui_suite.dart';

/// Sending a prompt with attachments, and starting a chat in a new project folder, per [FsVariant]: with the agent on
/// this phone the files are copied into the project; with a server agent they are uploaded to it.
void promptAndNewChatSuite(FsVariant variant) {
  late Directory dir;
  late Directory phone; // what is on the phone itself: photos and files picked for attaching

  setUp(() {
    dir = variant.makeDir();
    phone = Directory.systemTemp.createTempSync('phone_files_');
  });
  tearDown(() {
    for (final d in [dir, phone]) {
      try {
        d.deleteSync(recursive: true);
      } catch (_) {}
    }
  });

  String p(String rel) => '${dir.path}/$rel';

  group('preparePrompt', () {
    test('sends pictures as base64 and copies other files into .attachments', () async {
            File('${phone.path}/shot.png').writeAsBytesSync([1, 2, 3]);
      File('${phone.path}/notes.pdf').writeAsStringSync('pdf');
      Directory(p('project')).createSync();

      final prompt = await preparePrompt(
        'look at these',
        [Attachment('${phone.path}/shot.png', 'shot.png', mime: 'image/png'), Attachment('${phone.path}/notes.pdf', 'notes.pdf')],
        p('project'),
        await variant.makeFs(),
      );

      expect(prompt.images, [
        {'type': 'image', 'data': base64Encode([1, 2, 3]), 'mimeType': 'image/png'},
      ]);
      expect(File(p('project/.attachments/notes.pdf')).readAsStringSync(), 'pdf');
      expect(prompt.text, 'look at these\n\nAttached files:\n- ${p('project/.attachments/notes.pdf')}');
      // Pictures are not copied into the project.
      expect(File(p('project/.attachments/shot.png')).existsSync(), isFalse);
    });

    test('tells which file it is sending and how far it is, and can be stopped before it has sent anything half-way', () async {
      File('${phone.path}/a.pdf').writeAsBytesSync(List.filled(300 * 1024, 1));
      File('${phone.path}/b.txt').writeAsStringSync('bee');
      Directory(p('project')).createSync();
      final labels = <String>[];
      final progress = <(int, int)>[];
      final prompt = await preparePrompt(
        'two files',
        [Attachment('${phone.path}/a.pdf', 'a.pdf'), Attachment('${phone.path}/b.txt', 'b.txt')],
        p('project'),
        await variant.makeFs(),
        onFile: labels.add,
        onProgress: (d, t) => progress.add((d, t)),
      );
      expect(labels, ['a.pdf · 1 of 2', 'b.txt · 2 of 2']);
      expect(progress.last, (3, 3), reason: 'the last file is done');
      expect(progress.any((e) => e == (300 * 1024, 300 * 1024)), isTrue, reason: 'and the first one was reported complete');
      expect(prompt.text, contains('.attachments/a.pdf'));
      expect(File(p('project/.attachments/a.pdf')).lengthSync(), 300 * 1024);

      final stop = CancelToken()..cancel();
      await expectLater(
        preparePrompt('x', [Attachment('${phone.path}/b.txt', 'c.txt')], p('project'), await variant.makeFs(), cancel: stop),
        throwsA(isA<Cancelled>()),
      );
      expect(File(p('project/.attachments/c.txt')).existsSync(), isFalse);
    });

    test('skips attachments that no longer exist and adds no note when nothing was copied', () async {
      Directory(p('project')).createSync();
      final prompt = await preparePrompt('hi', [Attachment(p('gone.txt'), 'gone.txt')], p('project'), await variant.makeFs());
      expect(prompt.text, 'hi');
      expect(prompt.images, isEmpty);
      expect(Directory(p('project/.attachments')).existsSync(), isFalse);
    });
  });

  group('new chat sheet', () {
    late AgentController agent;

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 12; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
        await tester.pump(const Duration(milliseconds: 50));
      }
      await tester.pump(const Duration(milliseconds: 500));
    }

    Future<void> openSheet(WidgetTester tester) async {
      agent = await variant.makeAgent(tester, dir);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTheme(Brightness.light),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(onPressed: () => showNewChatSheet(context, agent), child: const Text('new')),
            ),
          ),
        ),
      );
      await tester.tap(find.text('new'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
    }

    Future<void> createProject(WidgetTester tester, String name) async {
      // The field starts with a suggested name; the "workspace/" prefix is not part of the text.
      await tester.enterText(find.byType(TextField), name);
      await tester.tap(find.text('Create and start'));
      await settle(tester);
    }

    testWidgets('creates the project folder in the workspace and closes the sheet', (tester) async {
      await openSheet(tester);
      await createProject(tester, 'my app');

      expect(Directory(p('my-app')).existsSync(), isTrue, reason: 'spaces become dashes');
      expect(find.text('Create and start'), findsNothing, reason: 'the sheet is gone');
    });

    testWidgets('refuses a folder that already has files and leaves it alone', (tester) async {
      File(p('busy/keep.txt')).createSync(recursive: true);
      await openSheet(tester);
      await createProject(tester, 'busy');

      expect(find.textContaining('"busy" already exists'), findsOneWidget);
      expect(find.text('Create and start'), findsOneWidget, reason: 'the sheet stays open');
      expect(File(p('busy/keep.txt')).existsSync(), isTrue);
    });

    testWidgets('reuses an existing empty folder', (tester) async {
      Directory(p('empty')).createSync();
      await openSheet(tester);
      await createProject(tester, 'empty');

      expect(find.textContaining('already exists'), findsNothing);
      expect(find.text('Create and start'), findsNothing);
    });
  });
}
