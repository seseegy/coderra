import 'dart:io';

import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/ui/files_screen.dart';
import 'package:andropi/ui/folder_picker.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Where the files of a test live and what the screens are given to reach them: the phone's own disk with [LocalFs], or
/// a server agent's disk with [RemoteFs] (the files are then really on this machine, behind a real daemon).
abstract class FsVariant {
  /// Called once before all the tests, and once after.
  Future<void> setUpAll() async {}
  Future<void> tearDownAll() async {}

  /// Whether the agent is on a server rather than on this phone.
  bool get remote => false;

  /// A fresh empty folder for one test.
  Directory makeDir();

  /// Just the file access, for code that is not a screen.
  Future<AgentFs> makeFs();

  /// An agent whose screens work on [dir] through this kind of file access.
  Future<AgentController> makeAgent(WidgetTester tester, Directory dir);
}

/// The widget tests for the screens that browse project files through `AgentFs`, run once per [FsVariant]. Real I/O only
/// completes inside `tester.runAsync`, so every step that touches it goes through [settle].
void filesUiSuite(FsVariant variant) {
  late Directory dir;
  late AgentController agent;

  setUp(() {
    dir = variant.makeDir();
  });
  tearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {}
  });

  Future<void> makeAgent(WidgetTester tester) async {
    agent = await variant.makeAgent(tester, dir);
  }

  /// Lets real file I/O finish, then rebuilds. The screens chain several I/O calls, and the continuation after each
  /// one only runs when the test pumps, so real waiting and pumping are interleaved.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 12; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pump(const Duration(milliseconds: 500));
  }

  /// Lets menus, dialogs and routes finish animating. `pumpAndSettle` would wait forever: loading spinners and
  /// the empty-state illustration animate without end.
  Future<void> pumpUi(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Widget app(Widget home) => MaterialApp(theme: buildTheme(Brightness.light), home: home);

  String p(String rel) => '${dir.path}/$rel';

  List<String> shownNames(WidgetTester tester, List<String> candidates) => [
    for (final n in candidates)
      if (find.text(n).evaluate().isNotEmpty) n,
  ];

  group('FilesScreen', () {
    Future<void> open(WidgetTester tester) async {
      await makeAgent(tester);
      await tester.pumpWidget(app(FilesScreen(agent: agent, root: dir.path)));
      await settle(tester);
    }

    Future<void> enterName(WidgetTester tester, String name, String button) async {
      await tester.enterText(find.byType(TextField), name);
      await tester.tap(find.widgetWithText(TextButton, button));
      await settle(tester);
    }

    testWidgets('lists folders before files, and hides dot files until asked', (tester) async {
      File(p('b.txt')).writeAsStringSync('b');
      File(p('A.md')).writeAsStringSync('a');
      Directory(p('zeta')).createSync();
      File(p('.secret')).writeAsStringSync('s');
      await open(tester);

      final names = shownNames(tester, ['zeta', 'A.md', 'b.txt', '.secret']);
      expect(names, ['zeta', 'A.md', 'b.txt']);
      // Folders first, then files by name ignoring case.
      expect(tester.getTopLeft(find.text('zeta')).dy, lessThan(tester.getTopLeft(find.text('A.md')).dy));
      expect(tester.getTopLeft(find.text('A.md')).dy, lessThan(tester.getTopLeft(find.text('b.txt')).dy));

      await tester.tap(find.byTooltip('Show hidden files'));
      await tester.pump();
      expect(find.text('.secret'), findsOneWidget);
    });

    testWidgets('creates a folder', (tester) async {
      await open(tester);
      await tester.tap(find.byTooltip('New'));
      await pumpUi(tester);
      await tester.tap(find.text('New folder'));
      await pumpUi(tester);
      await enterName(tester, 'docs', 'Create');

      expect(Directory(p('docs')).existsSync(), isTrue);
      expect(find.text('docs'), findsOneWidget);
    });

    testWidgets('refuses a name that is already taken and changes nothing', (tester) async {
      File(p('taken')).writeAsStringSync('keep me');
      await open(tester);
      await tester.tap(find.byTooltip('New'));
      await pumpUi(tester);
      await tester.tap(find.text('New folder'));
      await pumpUi(tester);
      await enterName(tester, 'taken', 'Create');

      expect(find.text('taken already exists'), findsOneWidget);
      expect(File(p('taken')).readAsStringSync(), 'keep me');
    });

    testWidgets('renames a file', (tester) async {
      File(p('old.txt')).writeAsStringSync('x');
      await open(tester);
      await tester.tap(find.byIcon(LucideIcons.ellipsisVertical));
      await pumpUi(tester);
      await tester.tap(find.text('Rename').last);
      await pumpUi(tester);
      await enterName(tester, 'new.txt', 'Rename');

      expect(File(p('old.txt')).existsSync(), isFalse);
      expect(File(p('new.txt')).readAsStringSync(), 'x');
      expect(find.text('new.txt'), findsOneWidget);
    });

    testWidgets('duplicates a file with a free name, then a second time', (tester) async {
      File(p('a.txt')).writeAsStringSync('x');
      await open(tester);
      for (var i = 0; i < 2; i++) {
        // The copy sorts before the original ("a copy.txt" < "a.txt"), so the original is the last row.
        await tester.tap(find.byIcon(LucideIcons.ellipsisVertical).last);
        await pumpUi(tester);
        await tester.tap(find.text('Duplicate').last);
        await settle(tester);
      }
      expect(File(p('a copy.txt')).readAsStringSync(), 'x');
      expect(File(p('a copy 2.txt')).readAsStringSync(), 'x');
    });

    testWidgets('duplicates a whole folder', (tester) async {
      File(p('proj/src/main.dart')).createSync(recursive: true);
      File(p('proj/src/main.dart')).writeAsStringSync('main');
      await open(tester);
      await tester.tap(find.byIcon(LucideIcons.ellipsisVertical));
      await pumpUi(tester);
      await tester.tap(find.text('Duplicate').last);
      await settle(tester);

      expect(File(p('proj copy/src/main.dart')).readAsStringSync(), 'main');
      expect(File(p('proj/src/main.dart')).existsSync(), isTrue);
    });

    testWidgets('deletes a folder and everything in it after confirming', (tester) async {
      File(p('gone/inner.txt')).createSync(recursive: true);
      await open(tester);
      await tester.tap(find.byIcon(LucideIcons.ellipsisVertical));
      await pumpUi(tester);
      await tester.tap(find.text('Delete').last);
      await pumpUi(tester);
      expect(find.text('Delete folder?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Delete'));
      await settle(tester);

      expect(Directory(p('gone')).existsSync(), isFalse);
      expect(find.text('gone'), findsNothing);
    });

    testWidgets('cancelling the delete keeps the file', (tester) async {
      File(p('keep.txt')).writeAsStringSync('x');
      await open(tester);
      await tester.tap(find.byIcon(LucideIcons.ellipsisVertical));
      await pumpUi(tester);
      await tester.tap(find.text('Delete').last);
      await pumpUi(tester);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await settle(tester);

      expect(File(p('keep.txt')).existsSync(), isTrue);
    });

    testWidgets('opens a folder and goes back up with the breadcrumb', (tester) async {
      File(p('sub/inner.txt')).createSync(recursive: true);
      await open(tester);
      await tester.tap(find.text('sub'));
      await settle(tester);
      expect(find.text('inner.txt'), findsOneWidget);

      await tester.tap(find.byIcon(LucideIcons.folderRoot));
      await settle(tester);
      expect(find.text('inner.txt'), findsNothing);
      expect(find.text('sub'), findsWidgets);
    });

    testWidgets('shows an error instead of crashing when the folder cannot be read', (tester) async {
      await makeAgent(tester);
      await tester.pumpWidget(app(FilesScreen(agent: agent, root: p('does-not-exist'))));
      await settle(tester);
      expect(find.text("Can't open this folder"), findsOneWidget);
    });
  });

  group('FolderPicker', () {
    /// Opens the picker from a button and records what it returns.
    Future<List<String?>> open(WidgetTester tester) async {
      await makeAgent(tester);
      final results = <String?>[];
      await tester.pumpWidget(
        app(
          Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async => results.add(await FolderPicker.pick(context, agent)),
                child: const Text('pick'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('pick'));
      await pumpUi(tester);
      await settle(tester);
      return results;
    }

    testWidgets('lists folders only, marks git repositories, hides dot folders until asked', (tester) async {
      Directory(p('repo/.git')).createSync(recursive: true);
      Directory(p('plain')).createSync();
      Directory(p('.hidden')).createSync();
      File(p('file.txt')).writeAsStringSync('x');
      await open(tester);

      expect(find.text('repo'), findsOneWidget);
      expect(find.text('plain'), findsOneWidget);
      expect(find.text('file.txt'), findsNothing);
      expect(find.text('.hidden'), findsNothing);
      expect(find.text('git repository'), findsOneWidget);

      await tester.tap(find.byTooltip('Show hidden folders'));
      await settle(tester);
      expect(find.text('.hidden'), findsOneWidget);
    });

    testWidgets('does not offer symbolic links to folders', (tester) async {
      Directory(p('real')).createSync();
      Link(p('alias')).createSync(p('real'));
      await open(tester);
      expect(find.text('real'), findsOneWidget);
      expect(find.text('alias'), findsNothing);
    });

    testWidgets('opening a folder and confirming returns its path', (tester) async {
      Directory(p('proj/inner')).createSync(recursive: true);
      final results = await open(tester);
      await tester.tap(find.text('proj'));
      await settle(tester);
      expect(find.text('inner'), findsOneWidget);

      await tester.tap(find.text('Open proj'));
      await pumpUi(tester);
      expect(results, [p('proj')]);
    });

    testWidgets('creates a folder and steps into it', (tester) async {
      await open(tester);
      await tester.tap(find.byTooltip('New folder'));
      await pumpUi(tester);
      await tester.enterText(find.byType(TextField), 'fresh');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await settle(tester);

      expect(Directory(p('fresh')).existsSync(), isTrue);
      expect(find.text('Open fresh'), findsOneWidget);
    });

    testWidgets('deleting a project removes it from disk', (tester) async {
      File(p('doomed/x.txt')).createSync(recursive: true);
      Directory(p('safe')).createSync();
      await open(tester);
      await tester.tap(find.byTooltip('Project actions').first);
      await pumpUi(tester);
      await tester.tap(find.text('Delete project'));
      await pumpUi(tester);
      await tester.tap(find.widgetWithText(TextButton, 'Delete'));
      await settle(tester);

      expect(Directory(p('doomed')).existsSync(), isFalse);
      expect(Directory(p('safe')).existsSync(), isTrue);
      expect(find.text('doomed'), findsNothing);
    });

    if (variant.remote) {
      testWidgets('does not offer this phone\'s storage, nor ask for permission to it', (tester) async {
        Directory(p('proj')).createSync();
        await open(tester);
        expect(find.text('proj'), findsOneWidget);
        expect(find.text('server'), findsOneWidget, reason: 'the root of the breadcrumb is the server');
        expect(find.text('Allow file access'), findsNothing);
        expect(find.text('Phone storage'), findsNothing);
        expect(find.byIcon(LucideIcons.smartphone), findsNothing);
      });
    }

    testWidgets('refuses to delete the folder the current chat works in', (tester) async {
      Directory(p('active')).createSync();
      await open(tester);
      agent.cwd = p('active');
      await tester.tap(find.byTooltip('Project actions').first);
      await pumpUi(tester);
      await tester.tap(find.text('Delete project'));
      await settle(tester);

      expect(Directory(p('active')).existsSync(), isTrue);
      expect(find.textContaining('in use by the current chat'), findsOneWidget);
    });
  });
}
