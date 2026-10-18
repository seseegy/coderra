import 'dart:io';

import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/ui/editor_screen.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:re_editor/re_editor.dart';

import 'files_ui_suite.dart';

/// The code editor, per [FsVariant]: saving, and above all not overwriting a file that changed underneath it.
void editorUiSuite(FsVariant variant) {
  late Directory dir;
  late AgentController agent;

  setUp(() => dir = variant.makeDir());
  tearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {}
  });

  String p(String rel) => '${dir.path}/$rel';

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 12; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<CodeLineEditingController> open(WidgetTester tester, String name) async {
    agent = await variant.makeAgent(tester, dir);
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: EditorScreen(agent: agent, path: p(name))));
    await settle(tester);
    return tester.widget<CodeEditor>(find.byType(CodeEditor)).controller!;
  }

  /// Something else (the agent, say) changes the file: new content, and a modification time that certainly differs.
  void changeBehindTheEditor(String name, String text) {
    final f = File(p(name))..writeAsStringSync(text);
    f.setLastModifiedSync(DateTime.now().add(const Duration(seconds: 5)));
  }

  Future<void> tapSave(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Save'));
    await settle(tester);
  }

  group('EditorScreen', () {
    testWidgets('opens a file, saves an edit, and saves again without quarrelling with its own earlier save', (tester) async {
      File(p('a.txt')).writeAsStringSync('one');
      final c = await open(tester, 'a.txt');
      expect(c.text, 'one');

      c.text = 'two';
      await settle(tester);
      await tapSave(tester);
      expect(File(p('a.txt')).readAsStringSync(), 'two');
      expect(find.text('File changed'), findsNothing);

      c.text = 'three';
      await settle(tester);
      await tapSave(tester);
      expect(File(p('a.txt')).readAsStringSync(), 'three', reason: 'the second save follows the first');
      expect(find.text('File changed'), findsNothing);
    });

    testWidgets('a file changed underneath is not overwritten: it asks, and "keep editing" writes nothing', (tester) async {
      File(p('a.txt')).writeAsStringSync('original');
      final c = await open(tester, 'a.txt');
      c.text = 'my edit';
      await settle(tester);
      changeBehindTheEditor('a.txt', 'the agent was here');

      await tapSave(tester);
      expect(find.text('File changed'), findsOneWidget);
      expect(File(p('a.txt')).readAsStringSync(), 'the agent was here', reason: 'nothing written while the dialog is up');

      await tester.tap(find.text('Keep editing'));
      await settle(tester);
      expect(File(p('a.txt')).readAsStringSync(), 'the agent was here');
      expect(c.text, 'my edit', reason: 'the edits are still on screen');
    });

    testWidgets('"Overwrite" writes my version', (tester) async {
      File(p('a.txt')).writeAsStringSync('original');
      final c = await open(tester, 'a.txt');
      c.text = 'my edit';
      await settle(tester);
      changeBehindTheEditor('a.txt', 'the agent was here');
      await tapSave(tester);
      await tester.tap(find.text('Overwrite'));
      await settle(tester);
      expect(File(p('a.txt')).readAsStringSync(), 'my edit');
      expect(find.text('File changed'), findsNothing);
    });

    testWidgets('"Load theirs" drops my edits and shows the new content, clean', (tester) async {
      File(p('a.txt')).writeAsStringSync('original');
      final c = await open(tester, 'a.txt');
      c.text = 'my edit';
      await settle(tester);
      changeBehindTheEditor('a.txt', 'the agent was here');
      await tapSave(tester);
      await tester.tap(find.text('Load theirs'));
      await settle(tester);
      expect(c.text, 'the agent was here');
      expect(File(p('a.txt')).readAsStringSync(), 'the agent was here');

      // Clean again, and saving works from the new base.
      c.text = 'after reload';
      await settle(tester);
      await tapSave(tester);
      expect(File(p('a.txt')).readAsStringSync(), 'after reload');
    });

    testWidgets('"Save as copy" keeps both: my version beside the file, the file as it is now', (tester) async {
      File(p('a.txt')).writeAsStringSync('original');
      final c = await open(tester, 'a.txt');
      c.text = 'my edit';
      await settle(tester);
      changeBehindTheEditor('a.txt', 'the agent was here');
      await tapSave(tester);
      await tester.tap(find.text('Save as copy'));
      await settle(tester);
      expect(File(p('a copy.txt')).readAsStringSync(), 'my edit');
      expect(File(p('a.txt')).readAsStringSync(), 'the agent was here');
      expect(c.text, 'the agent was here');
      expect(find.text('Your version was saved as a copy.txt'), findsOneWidget);
    });

    testWidgets('a file deleted underneath says so, and can be recreated from the edits', (tester) async {
      File(p('a.txt')).writeAsStringSync('original');
      final c = await open(tester, 'a.txt');
      c.text = 'my edit';
      await settle(tester);
      File(p('a.txt')).deleteSync();

      await tapSave(tester);
      expect(find.text('File was deleted'), findsOneWidget);
      expect(find.text('Load theirs'), findsNothing, reason: 'there is nothing to load');
      expect(File(p('a.txt')).existsSync(), isFalse);
      await tester.tap(find.text('Recreate'));
      await settle(tester);
      expect(File(p('a.txt')).readAsStringSync(), 'my edit');
    });
  });
}
