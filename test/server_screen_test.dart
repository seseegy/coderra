import 'dart:convert';
import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/agent/remote_fs.dart';
import 'package:andropi/agent/remote_profile.dart';
import 'package:andropi/ui/server_screen.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABn0o4m7AzJb8wgXq1z+8+KtuqK5nyX6AX9nOQI2zVG';
const pubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyOnlyForTests coderra-app';

String setupCode([Map<String, Object?> over = const {}]) =>
    'coderra1:${base64.encode(utf8.encode(jsonEncode({'v': 1, 'host': 'agent.example.com', 'port': 22, 'user': 'coderra', 'hostKey': hostKey, ...over})))}';

/// RemoteSetup without the processes: a fixed key, and answers for the server checks the test chooses.
class StubSetup extends RemoteSetup {
  StubSetup(String home) : super(home: home, ssh: 'ssh');

  ServerCheck result = const ServerCheck(ProblemNone.ok, 'Connected. The agent is running on the server.');
  InstallResult installResult = const InstallResult(ok: true, message: 'Installed (12 files). The agent was restarted.', filesSent: 12);
  var checks = 0;
  var installs = 0;

  @override
  Future<String> ensureKey() async => pubKey;

  @override
  Future<ServerCheck> check(RemoteProfile p, {Map<String, String>? env, Duration timeout = const Duration(seconds: 30)}) async {
    checks++;
    return result;
  }

  @override
  Future<InstallResult> install(String hostDir, {Map<String, String>? env, void Function(String line)? onProgress}) async {
    installs++;
    onProgress?.call('Copying the agent...');
    return installResult;
  }
}

// ServerProblem.none is awkward to spell next to a ServerCheck, so name it once.
class ProblemNone {
  static const ok = ServerProblem.none;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmp;
  late FakeBackend backend;
  late AgentController agent;
  late StubSetup setup;
  late RemoteProfileStore store;

  setUp(() {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(PlatformBackend.method, (_) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(PlatformBackend.method, null));
    tmp = Directory.systemTemp.createTempSync('cr-ui-');
    addTearDown(() => tmp.deleteSync(recursive: true));
    backend = FakeBackend();
    agent = AgentController(AgentClient(backend: backend)..backoff = ((_) => const Duration(milliseconds: 20)));
    setup = StubSetup('${tmp.path}/home');
    store = RemoteProfileStore(File('${tmp.path}/home/.coderra/remote.json'));
  });

  /// [saved]: a server already set up; [active]: and in use.
  void configure({bool saved = false, bool active = false}) {
    if (saved) store.save(RemoteProfile.fromSetupCode(SetupCode.parse(setupCode())).copyWith(active: active));
    agent.remote.configure(setup: setup, store: store, hostDir: '${tmp.path}/host');
  }

  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  Future<void> show(WidgetTester tester, Widget child) async {
    tall(tester);
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: child)));
  }

  group('ConnectionChip', () {
    testWidgets('is invisible until a server is set up, then says which agent is in use', (tester) async {
      configure();
      await show(tester, ConnectionChip(agent: agent));
      expect(find.byType(Text), findsNothing);

      store.save(RemoteProfile.fromSetupCode(SetupCode.parse(setupCode())));
      configure(); // reads it again
      await tester.pump();
      expect(find.text('Phone'), findsOneWidget);
    });

    testWidgets('follows the link while the server is in use', (tester) async {
      configure(saved: true, active: true);
      await show(tester, ConnectionChip(agent: agent));
      final link = agent.client.connection;

      link.value = Connection.local;
      await tester.pump();
      expect(find.text('Server'), findsOneWidget);

      link.value = const Connection(LinkState.reconnecting, attempt: 2);
      await tester.pump();
      expect(find.text('Reconnecting'), findsOneWidget);

      link.value = const Connection(LinkState.offline);
      await tester.pump();
      expect(find.text('Offline'), findsOneWidget);
    });
  });

  group('ConnectionBanner', () {
    testWidgets('is silent on the phone and while connected', (tester) async {
      configure();
      await show(tester, ConnectionBanner(agent: agent));
      expect(find.byType(Text), findsNothing);
      configure(saved: true, active: true);
      await tester.pump();
      expect(find.byType(Text), findsNothing, reason: 'connected');
    });

    testWidgets('says it is reconnecting, why, and lets the user hurry it', (tester) async {
      configure(saved: true, active: true);
      await show(tester, ConnectionBanner(agent: agent));
      agent.client.connection.value = Connection(
        LinkState.reconnecting,
        attempt: 3,
        retryAt: DateTime.now().add(const Duration(seconds: 8)),
        reason: 'ssh: connect to host x port 22: Connection timed out',
      );
      await tester.pump();
      expect(find.textContaining('Reconnecting to the server'), findsOneWidget);
      expect(find.textContaining('Connection timed out'), findsOneWidget);
      expect(find.text('The agent keeps working on the server.'), findsOneWidget);
      expect(find.text('Retry now'), findsOneWidget);
      await tester.pumpWidget(const SizedBox()); // stop the countdown timer
    });

    testWidgets('after another device took over it offers to take the connection back', (tester) async {
      configure(saved: true, active: true);
      await show(tester, ConnectionBanner(agent: agent));
      agent.client.connection.value = const Connection(LinkState.offline, kicked: true, reason: 'Another device took over the connection.');
      await tester.pump();
      expect(find.text('Another device is using the server agent'), findsOneWidget);
      expect(find.text('Take over'), findsOneWidget);

      await tester.tap(find.text('Take over'));
      await tester.pump();
      expect(agent.client.connection.value.state, LinkState.reconnecting);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump();
      expect(backend.starts, 1, reason: 'taking over starts a new connection');
      expect(agent.client.connection.value.connected, isTrue);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('when simply offline it says so and offers to reconnect', (tester) async {
      configure(saved: true, active: true);
      await show(tester, ConnectionBanner(agent: agent));
      agent.client.connection.value = const Connection(LinkState.offline);
      await tester.pump();
      expect(find.text('Not connected to the server'), findsOneWidget);
      expect(find.text('Reconnect'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('InterruptedBar', () {
    testWidgets('offers to continue a chat the host was cut off from, once, and only when nothing is running', (tester) async {
      configure();
      await show(tester, ListenableBuilder(listenable: agent, builder: (_, _) => InterruptedBar(agent: agent)));
      expect(find.byType(Text), findsNothing);

      agent.interrupted = true;
      agent.notifyListeners();
      await tester.pump();
      expect(find.text('The last request was cut off before it finished.'), findsOneWidget);

      agent.busy = true;
      agent.notifyListeners();
      await tester.pump();
      expect(find.byType(Text), findsNothing, reason: 'it is already going');
      agent.busy = false;
      agent.notifyListeners();
      await tester.pump();

      backend.onCommand = (c) => null;
      backend.running = true;
      await tester.tap(find.text('Continue'));
      await tester.pump();
      expect(backend.sent.last['type'], 'continue_session');
      expect(agent.interrupted, isFalse);
      expect(find.byType(Text), findsNothing);
    });
  });

  group('ServerScreen', () {
    Future<void> open(WidgetTester tester) async {
      tall(tester);
      await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: ServerScreen(agent: agent)));
      await tester.pump();
    }

    testWidgets('with no server: shows the app\'s key in a command to run on the server, and asks for the code', (tester) async {
      configure();
      await open(tester);
      expect(find.text('This phone runs the agent'), findsOneWidget);
      expect(find.textContaining("sudo ./bootstrap.sh --pubkey '$pubKey'"), findsOneWidget);
      expect(find.text('Setup code'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, 'Server address (name or IP)'), 'agent.example.com');
      await tester.pump();
      expect(find.textContaining("--address 'agent.example.com'"), findsOneWidget);
    });

    testWidgets('a bad code says what is wrong; a good one saves the server, writes its ssh files and shows it', (tester) async {
      configure();
      await open(tester);
      await tester.enterText(find.widgetWithText(TextField, 'Setup code'), 'hello');
      await tester.tap(find.text('Save server'));
      await tester.pump();
      expect(find.textContaining('not a setup code'), findsOneWidget);
      expect(store.load(), isNull);

      await tester.enterText(find.widgetWithText(TextField, 'Setup code'), 'Done. Paste this:\n\n  ${setupCode()}\n');
      await tester.tap(find.text('Save server'));
      await tester.pump();
      expect(find.textContaining('not a setup code'), findsNothing);
      expect(find.text('agent.example.com'), findsOneWidget);
      expect(find.text('user coderra'), findsOneWidget);
      final saved = store.load()!;
      expect([saved.host, saved.active], ['agent.example.com', false]);
      expect(File(setup.configPath).readAsStringSync(), contains('HostName agent.example.com'));
      expect(File(setup.knownHostsPath).readAsStringSync(), 'agent.example.com $hostKey\n');
      expect(agent.client.isRemote, isFalse, reason: 'saving a server does not switch to it');
    });

    testWidgets('testing the connection shows the verdict, with the way out when it is bad', (tester) async {
      configure(saved: true);
      await open(tester);
      await tester.tap(find.text('Test connection'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Connected. The agent is running on the server.'), findsOneWidget);
      expect(setup.checks, 1);

      setup.result = const ServerCheck(ServerProblem.authRejected, 'The server did not accept this app\'s key.', detail: 'Permission denied (publickey).');
      await tester.tap(find.text('Test connection'));
      await tester.pump();
      await tester.pump();
      expect(find.text('The server did not accept this app\'s key.'), findsOneWidget);
      expect(find.text('Permission denied (publickey).'), findsOneWidget);
    });

    testWidgets('installing shows what it did, and tests the server afterwards', (tester) async {
      configure(saved: true);
      await open(tester);
      await tester.tap(find.text('Install / update agent'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Installed (12 files). The agent was restarted.'), findsOneWidget);
      expect(setup.installs, 1);
      expect(setup.checks, 1, reason: 'a successful install is followed by a check');

      setup.installResult = const InstallResult(ok: false, message: 'Copying failed: rsync: connection unexpectedly closed');
      await tester.tap(find.text('Install / update agent'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Copying failed: rsync: connection unexpectedly closed'), findsOneWidget);
      expect(setup.checks, 1);
    });

    testWidgets('switching to the server asks first, and cancelling changes nothing', (tester) async {
      configure(saved: true);
      await open(tester);
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(find.text('Use the server agent?'), findsOneWidget);
      expect(find.textContaining('stay here, untouched'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(store.load()!.active, isFalse);
      expect(agent.client.isRemote, isFalse);
    });

    testWidgets('forgetting a server asks first, then removes the key and the ssh files', (tester) async {
      configure(saved: true);
      setup.write(store.load()!);
      await open(tester);
      await tester.ensureVisible(find.text('Forget this server'));
      await tester.tap(find.text('Forget this server'));
      await tester.pumpAndSettle();
      expect(find.text('Forget this server?'), findsOneWidget);
      await tester.tap(find.text('Forget'));
      await tester.pumpAndSettle();
      expect(store.load(), isNull);
      expect(File(setup.configPath).existsSync(), isFalse);
      expect(find.text('Setup code'), findsOneWidget, reason: 'back to the set-up steps');
    });
  });

  group('ServerScreen on a connected server', () {
    Map<String, Object?> notify = {'enabled': true, 'url': 'https://ntfy.sh', 'topic': null};

    Future<void> openConnected(WidgetTester tester, {String diskLevel = 'ok'}) async {
      configure(saved: true, active: true);
      notify = {'enabled': true, 'url': 'https://ntfy.sh', 'topic': null};
      backend.onCommand = (c) => switch (c['type']) {
        'health' => {
          'disk': {'freeBytes': 13421772800, 'totalBytes': 53687091200, 'level': diskLevel},
          'memory': {'rssBytes': 300 * 1024 * 1024},
          'runs': {'running': 1, 'queued': 2},
          'uptimeSec': 7500,
          'node': 'v24.22.0',
        },
        'settings_get' => {'notify': notify},
        'settings_set' => () {
          notify = ((c['settings'] as Map)['notify'] as Map).cast<String, Object?>();
          return {'notify': notify};
        }(),
        _ => null,
      };
      await tester.runAsync(() => agent.client.start());
      tall(tester);
      await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: ServerScreen(agent: agent)));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      await tester.pump();
    }

    testWidgets('shows how the server is doing', (tester) async {
      await openConnected(tester);
      expect(find.text('Your server runs the agent'), findsOneWidget);
      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Server health'), findsOneWidget);
      expect(find.text('Disk free  12.5 GB of 50.0 GB'), findsOneWidget);
      expect(find.text('Agent memory  0.3 GB'), findsOneWidget);
      expect(find.text('Running  1 · queued 2'), findsOneWidget);
      expect(find.text('Up for  2 h 5 min'), findsOneWidget);
      expect(find.textContaining('almost full'), findsNothing);
    });

    testWidgets('warns when the disk is getting full', (tester) async {
      await openConnected(tester, diskLevel: 'critical');
      expect(find.textContaining('The disk is almost full'), findsOneWidget);
    });

    testWidgets('makes a secret topic, saves it with the server address, and reads it back', (tester) async {
      await openConnected(tester);
      expect(find.text('Not set up yet'), findsOneWidget);
      await tester.ensureVisible(find.byTooltip('Make a new one'));
      await tester.tap(find.byTooltip('Make a new one'));
      await tester.pump();
      final field = tester.widget<TextField>(find.widgetWithText(TextField, 'Topic (keep it secret)'));
      final topic = field.controller!.text;
      expect(topic, matches(RegExp(r'^coderra-[0-9a-f]{32}$')), reason: '128 bits, so nobody can guess it');

      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      final sent = backend.sent.lastWhere((c) => c['type'] == 'settings_set');
      expect(((sent['settings'] as Map)['notify'] as Map), {'enabled': true, 'url': 'https://ntfy.sh', 'topic': topic});
      expect(find.text('Notifications saved'), findsOneWidget);
      expect(find.text('Not set up yet'), findsNothing);
    });
  });

  group('switching agents', () {
    setUp(() {
      backend.onCommand = (c) => switch (c['type']) {
        'messages' || 'providers' || 'models' || 'sessions' => <Object?>[],
        _ => <String, Object?>{'workspace': '/srv/work'},
      };
    });

    test('using the server points the client at it and the files at its disk; using the phone undoes it', () async {
      configure(saved: true);
      expect(agent.client.isRemote, isFalse);
      expect(agent.fs, isA<LocalFs>());

      await agent.remote.use(true);
      expect(agent.remote.active, isTrue);
      expect(store.load()!.active, isTrue, reason: 'remembered for the next start');
      expect(agent.client.isRemote, isTrue);
      expect(agent.client.remote!.argv, containsAllInOrder(['ssh', '-F', setup.configPath, '-T', 'coderra-vps']));
      expect(agent.fs, isA<RemoteFs>());
      expect(agent.status, BootStatus.ready, reason: agent.bootError);
      expect(backend.sent.where((c) => c['type'] == 'resume'), hasLength(1), reason: 'it connected as a server agent');

      await agent.remote.use(false);
      expect(agent.client.isRemote, isFalse);
      expect(agent.fs, isA<LocalFs>());
      expect(store.load()!.active, isFalse);
    });

    test('forgetting the server in use puts the phone\'s agent back', () async {
      configure(saved: true, active: true);
      expect(agent.client.isRemote, isTrue);
      await agent.remote.forget();
      expect(agent.client.isRemote, isFalse);
      expect(agent.fs, isA<LocalFs>());
      expect(agent.remote.configured, isFalse);
    });

    test('a saved server in use is picked up at start', () {
      configure(saved: true, active: true);
      expect(agent.client.isRemote, isTrue);
      expect(agent.fs, isA<RemoteFs>());
    });
  });
}
