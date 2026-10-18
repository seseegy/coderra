import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/remote_fs.dart';
import 'package:andropi/ui/theme.dart';
import 'package:andropi/ui/update_row.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';
import 'support/fake_host.dart';

/// The "App updates" row. With the agent on a server, the server downloads the APK and the app fetches it from there before
/// installing; the host is told which build and which CPU this phone is, since the server's own environment says nothing.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmp;
  late FakeBackend backend;
  late FakeHost server; // the server's files
  late AgentController agent;
  late List<MethodCall> platformCalls;
  late List<Map<String, dynamic>> commands;
  late Map<String, dynamic> checkAnswer;
  late List<Map<String, dynamic>> statusAnswers;
  late Uint8List apk;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('cr-update-');
    addTearDown(() => tmp.deleteSync(recursive: true));
    apk = bytes(5000, 42);
    server = FakeHost()
      ..files['/srv/agent/updates/b130-app-arm64.apk'] = apk
      ..mtimes['/srv/agent/updates/b130-app-arm64.apk'] = 77;
    platformCalls = [];
    commands = [];
    checkAnswer = {'status': 'available', 'currentBuild': 120, 'currentVersion': '1.2.0', 'latestBuild': 130, 'tag': 'b130'};
    statusAnswers = [
      {'state': 'downloading', 'received': 2000, 'total': 5000},
      {'state': 'done', 'received': 5000, 'total': 5000, 'path': '/srv/agent/updates/b130-app-arm64.apk'},
    ];
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(PlatformBackend.method, (call) async {
      platformCalls.add(call);
      return switch (call.method) {
        'appInfo' => {'version': '1.2.0', 'build': 120, 'abi': 'arm64-v8a'},
        'installApk' => 'launched',
        _ => null,
      };
    });
    addTearDown(() => messenger.setMockMethodCallHandler(PlatformBackend.method, null));
    backend = FakeBackend()
      ..onCommand = (c) {
        commands.add(c);
        return switch (c['type']) {
          'app_update_check' => checkAnswer,
          'app_update_download' => {'id': 'u1', 'name': 'app-arm64.apk', 'size': 5000, 'tag': 'b130'},
          'app_update_status' => statusAnswers.length > 1 ? statusAnswers.removeAt(0) : statusAnswers.first,
          _ => null,
        };
      };
  });

  Future<void> show(WidgetTester tester, {required bool onServer}) async {
    final client = AgentClient(backend: backend);
    if (onServer) client.remote = const LaunchSpec(['ssh']);
    agent = AgentController(client);
    if (onServer) {
      await tester.runAsync(client.start);
      agent.fs = RemoteFs(server.call, phoneCache: Directory('${tmp.path}/cache')..createSync(), chunkSize: 1000, waitOnline: server.waitOnline);
    }
    await tester.pumpWidget(
      MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: UpdateRow(agent: agent))),
    );
    await tester.pump();
    await tester.pump();
  }

  /// Lets the real file I/O of the transfer finish.

  /// Waits (in real time: the platform channel and the file I/O answer outside the test clock) until [text] is on screen.
  Future<void> until(WidgetTester tester, String text) async {
    for (var i = 0; i < 60; i++) {
      if (find.textContaining(text).evaluate().isNotEmpty) return;
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('"$text" never appeared; the row says: ${tester.widgetList<Text>(find.byType(Text)).map((w) => w.data).join(' | ')}');
  }

  Map<String, dynamic> command(String type) => commands.firstWhere((c) => c['type'] == type);
  List<MethodCall> installs() => platformCalls.where((c) => c.method == 'installApk').toList();

  testWidgets('the check tells the host which build and CPU this app is', (tester) async {
    await show(tester, onServer: true);
    await until(tester, 'build b130 available');
    expect(command('app_update_check'), containsPair('currentBuild', 120));
    expect(command('app_update_check'), containsPair('currentVersion', '1.2.0'));
    expect(command('app_update_check'), containsPair('abi', 'arm64-v8a'));
    expect(find.textContaining('build b130 available'), findsOneWidget);
  });

  testWidgets('on a server: the server downloads, the app fetches it with progress, and the phone\'s copy is what gets installed', (tester) async {
    await show(tester, onServer: true);
    await tester.tap(find.text('App updates'));
    await until(tester, 'The server is downloading build b130');
    expect(command('app_update_download'), containsPair('abi', 'arm64-v8a'));

    await until(tester, 'downloaded — tap to install');
    expect(command('app_update_status'), containsPair('downloadId', 'u1'));
    expect(command('app_update_status')['id'], isA<int>(), reason: 'the request keeps its own id, so the answer finds its way back');
    await tester.tap(find.text('App updates'));
    await until(tester, 'Installer opened');
    final path = installs().single.arguments as String;
    expect(path, startsWith('${tmp.path}/cache/'), reason: 'a file on the phone, not the server\'s path');
    expect(File(path).readAsBytesSync(), apk);
  });

  testWidgets('a trip to the phone that fails is retried without downloading from GitHub again', (tester) async {
    await show(tester, onServer: true);
    server.fault = (type, args) => type == 'fs_read' ? 'before' : null; // the connection will not hold
    server.onlineError = AgentError('The connection to the server did not come back.', code: 'offline');
    await tester.tap(find.text('App updates'));
    await until(tester, 'Download failed');
    expect(find.textContaining('did not come back'), findsOneWidget, reason: tester.widgetList<Text>(find.byType(Text)).map((w) => w.data).join(' | '));
    expect(commands.where((c) => c['type'] == 'app_update_download'), hasLength(1));

    server
      ..fault = null
      ..onlineError = null;
    await tester.tap(find.text('App updates'));
    await until(tester, 'downloaded — tap to install');
    expect(commands.where((c) => c['type'] == 'app_update_download'), hasLength(1), reason: 'the server\'s copy was reused');
  });

  testWidgets('on this phone the downloaded file is installed where it is', (tester) async {
    await show(tester, onServer: false);
    await tester.tap(find.text('App updates'));
    await until(tester, 'downloaded — tap to install');
    await tester.tap(find.text('App updates'));
    await until(tester, 'Installer opened');
    expect(installs().single.arguments, '/srv/agent/updates/b130-app-arm64.apk');
  });

  for (final (message, shown) in [
    ('GitHub: Bad credentials (401)', 'GitHub sign-in expired'),
    ('GitHub: API rate limit exceeded (403)', 'GitHub refused (403)'),
    ('fetch failed', 'no connection to GitHub'),
    ('something unexpected', 'something unexpected'),
  ]) {
    testWidgets('a check that fails says why: "$message"', (tester) async {
      checkAnswer = {'status': 'error', 'currentBuild': 120, 'message': message};
      await show(tester, onServer: true);
      await until(tester, "Couldn't check ($shown");
    });
  }

  testWidgets('a check that fails without a reason still says it failed', (tester) async {
    checkAnswer = {'status': 'error', 'currentBuild': 120};
    await show(tester, onServer: true);
    await until(tester, "Couldn't check — tap to retry");
  });

  testWidgets('a server that is not signed in to GitHub says where to sign in', (tester) async {
    checkAnswer = {'status': 'signed-out', 'currentBuild': 120};
    await show(tester, onServer: true);
    await until(tester, 'Sign in to GitHub on the server');
  });
}
