import 'dart:io';

import 'dart:async';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/remote_profile.dart';
import 'package:andropi/ui/box_screen.dart';
import 'package:andropi/ui/container_screen.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

/// The agent's box on a server, as the app shows it. The host is played by a script that keeps a box's state and answers
/// the way agent/src/podmanbox.ts does (that is tested against a stand-in podman in agent/test/podmanbox.test.ts).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeBackend backend;
  late AgentController agent;
  late List<Map<String, dynamic>> commands;
  late Map<String, dynamic> box;
  late Map<String, Object? Function(Map<String, dynamic>)> overrides;
  late Completer<Object?> buildDone;

  Map<String, dynamic> running() => {
    'kind': 'podman',
    'available': true,
    'installed': true,
    'state': 'running',
    'enabled': true,
    'image': 'localhost/coderra-box',
    'startedAt': DateTime.now().toUtc().subtract(const Duration(hours: 3, minutes: 5)).toIso8601String(),
    'usage': {'memoryBytes': 512 * 1024 * 1024, 'memoryLimitBytes': 2 * 1024 * 1024 * 1024, 'processes': 5},
    'limits': {'memory': '2g', 'swap': '3g', 'cpus': '1.5'},
    'problem': null,
  };

  setUp(() {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(PlatformBackend.method, (_) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(PlatformBackend.method, null));
    commands = [];
    overrides = {};
    buildDone = Completer<Object?>();
    box = running();
    backend = FakeBackend()
      ..onCommand = (c) {
        commands.add(c);
        final type = c['type'] as String;
        final over = overrides[type];
        if (over != null) return over(c);
        switch (type) {
          case 'container_status':
            return box;
          case 'container_enable':
            box = {...box, 'enabled': c['on'] == true};
            return box;
          case 'container_remove':
            box = {...box, 'state': 'none', 'usage': null, 'startedAt': null};
            return box;
          case 'box_stop':
            box = {...box, 'state': 'stopped', 'usage': null};
            return box;
          case 'box_check':
            return {'ok': true, 'message': 'The box works: a command ran inside it.'};
          case 'container_install':
            backend
              ..say({'type': 'task', 'taskId': c['taskId'], 'line': 'STEP 1/3: FROM ubuntu'})
              ..say({'type': 'task', 'taskId': c['taskId'], 'line': 'Successfully tagged localhost/coderra-box'});
            box = {...box, 'state': 'none', 'usage': null};
            // The build takes a while: its output arrives well before the answer, as it does for real.
            return buildDone.future;
          case 'box_wipe_home':
            box = {...box, 'state': 'none', 'usage': null};
            return {'removed': 4, 'status': box};
        }
        return null;
      };
    agent = AgentController(AgentClient(backend: backend)..remote = const LaunchSpec(['ssh']));
  });

  Future<void> open(WidgetTester tester, {Duration refresh = const Duration(minutes: 5)}) async {
    tester.view.physicalSize = const Size(800, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.runAsync(agent.client.start);
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: BoxScreen(agent: agent, refreshEvery: refresh)));
    await tester.pump();
    await tester.pump();
  }

  List<String> sent() => [for (final c in commands) c['type'] as String];
  Map<String, dynamic> last(String type) => commands.lastWhere((c) => c['type'] == type);

  Future<void> tapAndConfirm(WidgetTester tester, String row, String button) async {
    await tester.ensureVisible(find.text(row));
    await tester.tap(find.text(row));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    await tester.tap(find.widgetWithText(FilledButton, button));
    await tester.pump();
    await tester.pump();
  }

  testWidgets('a running box: its state, how long, what it uses and its limits', (tester) async {
    await open(tester);
    expect(find.text('Running'), findsOneWidget);
    expect(find.textContaining('up for 3 h 5 min'), findsOneWidget);
    expect(find.text('Memory  512 MB of 2.0 GB'), findsOneWidget);
    expect(find.text('Processes  5'), findsOneWidget);
    expect(find.textContaining('memory 2g · swap 3g · 1.5 CPU'), findsOneWidget);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
  });

  testWidgets('a box that has not been built says so; one with no memory limit shows just what it uses', (tester) async {
    box = {...running(), 'installed': false, 'state': 'none', 'usage': null, 'problem': 'The box image has not been built. Rebuild it from this screen, or run the setup script again.'};
    await open(tester);
    expect(find.text('Not built'), findsOneWidget);
    expect(find.textContaining('image has not been built'), findsOneWidget);
    expect(find.text('Using now'), findsNothing);
  });

  testWidgets('no box at all: an explanation, and none of the controls', (tester) async {
    box = {'kind': 'podman', 'available': false, 'installed': false, 'state': 'none', 'enabled': false, 'problem': 'There is no box on this server (the setup script was run with --no-box).'};
    await open(tester);
    expect(find.text('There is no box on this server'), findsOneWidget);
    expect(find.textContaining('without --no-box'), findsWidgets);
    expect(find.byType(Switch), findsNothing);
    expect(find.text('Reset the box'), findsNothing);
  });

  testWidgets('turning the box off asks first, saying where commands would run; cancelling changes nothing', (tester) async {
    await open(tester);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(find.textContaining('directly on the server, as the coderra user'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(sent().contains('container_enable'), isFalse);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);

    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    await tester.tap(find.widgetWithText(FilledButton, 'Turn the box off'));
    await tester.pump();
    await tester.pump();
    expect(last('container_enable'), containsPair('on', false));
    expect(find.textContaining('Off: commands run directly on the server'), findsOneWidget);

    // On again needs no question.
    await tester.tap(find.byType(Switch));
    await tester.pump();
    await tester.pump();
    expect(last('container_enable'), containsPair('on', true));
  });

  testWidgets('testing the box shows the verdict, good or bad, in words', (tester) async {
    await open(tester);
    await tester.tap(find.text('Test the box'));
    await tester.pump();
    await tester.pump();
    expect(find.text('The box works: a command ran inside it.'), findsOneWidget);

    overrides['box_check'] = (_) => {'ok': false, 'message': 'Error: crun: cannot start the container'};
    await tester.tap(find.text('Test the box'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Error: crun: cannot start the container'), findsOneWidget);
    expect(find.text('The box works: a command ran inside it.'), findsNothing);
  });

  testWidgets('stopping, resetting, rebuilding and emptying the home each ask first and do exactly that', (tester) async {
    await open(tester);

    await tester.tap(find.text('Stop the box'));
    await tester.pump();
    await tester.pump();
    expect(sent().last, 'box_stop', reason: 'stopping is harmless and asks nothing');
    expect(find.text('Stopped'), findsOneWidget);
    expect(find.text('Using now'), findsNothing);

    box = running();
    await tester.tap(find.byTooltip('Refresh'));
    await tester.pump();
    await tester.pump();

    await tester.ensureVisible(find.text('Reset the box'));
    await tester.tap(find.text('Reset the box'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(sent().contains('container_remove'), isFalse);
    await tapAndConfirm(tester, 'Reset the box', 'Reset');
    expect(last('container_remove'), isNot(contains('force')));
    expect(find.text('Not started yet'), findsOneWidget);

    await tapAndConfirm(tester, 'Empty the box\'s home folder', 'Empty it');
    expect(sent().last, 'box_wipe_home');
    expect(find.text('Removed 4'), findsOneWidget);
  });

  testWidgets('rebuilding shows what the build says', (tester) async {
    await open(tester);
    await tester.ensureVisible(find.text('Rebuild the image'));
    await tester.tap(find.text('Rebuild the image'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(find.textContaining('a few minutes'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Rebuild'));
    // The sheet and its subscriptions live outside the test clock; give the real event loop turns.
    Future<void> until(bool Function() ok) async {
      for (var i = 0; i < 50 && !ok(); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    await until(() => find.textContaining('Successfully tagged').evaluate().isNotEmpty);
    expect(last('container_install'), containsPair('taskId', isA<String>()));
    expect(find.textContaining('STEP 1/3'), findsOneWidget, reason: 'the output shows while the build is still going');
    expect(find.textContaining('Successfully tagged'), findsOneWidget);
    expect(find.text('Working…'), findsOneWidget);

    buildDone.complete(box);
    await until(() => find.text('Working…').evaluate().isEmpty);
    expect(find.text('Working…'), findsNothing);
    expect(find.text('Done'), findsOneWidget);
  });

  testWidgets('while the agent is using the box the host refuses; the user can wait, or do it anyway', (tester) async {
    overrides['container_remove'] = (c) {
      if (c['force'] == true) {
        box = {...box, 'state': 'none', 'usage': null};
        return box;
      }
      throw const FakeFailure('The agent is working in the box right now. Stop it first, or do it anyway.', code: 'busy');
    };
    await open(tester);

    await tapAndConfirm(tester, 'Reset the box', 'Reset');
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(find.text('The agent is using the box'), findsOneWidget);
    expect(find.textContaining('stops the command it is running'), findsOneWidget);
    await tester.tap(find.text('Wait'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(commands.where((c) => c['type'] == 'container_remove'), hasLength(1));

    await tapAndConfirm(tester, 'Reset the box', 'Reset');
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    await tester.tap(find.text('Do it anyway'));
    await tester.pump();
    await tester.pump();
    expect(commands.where((c) => c['type'] == 'container_remove').last, containsPair('force', true));
    expect(find.text('Not started yet'), findsOneWidget);
  });

  testWidgets('what cannot be done is greyed out: stopping a box that is not running, resetting one that does not exist', (tester) async {
    box = {...running(), 'state': 'none', 'usage': null};
    await open(tester);
    await tester.ensureVisible(find.text('Stop the box'));
    await tester.tap(find.text('Stop the box'));
    await tester.tap(find.text('Reset the box'));
    await tester.pump();
    expect(sent().contains('box_stop'), isFalse);
    expect(sent().contains('container_remove'), isFalse);
  });

  testWidgets('the numbers follow the box while the screen is open', (tester) async {
    await open(tester, refresh: const Duration(milliseconds: 200));
    expect(find.text('Processes  5'), findsOneWidget);
    box = {...running(), 'usage': {'memoryBytes': 1900 * 1024 * 1024, 'memoryLimitBytes': 2 * 1024 * 1024 * 1024, 'processes': 41}};
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pump();
    await tester.pump();
    expect(find.text('Processes  41'), findsOneWidget);
    expect(find.text('Memory  1.9 GB of 2.0 GB'), findsOneWidget);
    await tester.pumpWidget(const SizedBox()); // stops the timer
  });

  testWidgets('without a connection the screen says so instead of spinning', (tester) async {
    tester.view.physicalSize = const Size(800, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    agent.client.connection.value = const Connection(LinkState.offline);
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: BoxScreen(agent: agent)));
    await tester.pump();
    await tester.pump();
    expect(find.text('Not connected to the server.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the settings screen for the Linux container turns into this one when the agent is on a server', (tester) async {
    final tmp = Directory.systemTemp.createTempSync('cr-box-');
    addTearDown(() => tmp.deleteSync(recursive: true));
    final store = RemoteProfileStore(File('${tmp.path}/remote.json'))
      ..save(const RemoteProfile(host: 'h', port: 22, user: 'coderra', hostKey: 'ssh-ed25519 AAAA', active: true));
    agent.remote.configure(setup: RemoteSetup(home: tmp.path), store: store);
    tester.view.physicalSize = const Size(800, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.runAsync(agent.client.start);
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: ContainerScreen(agent: agent)));
    await tester.pump();
    await tester.pump();
    expect(find.text('The agent\'s box'), findsOneWidget);
    expect(find.text('Linux container'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
