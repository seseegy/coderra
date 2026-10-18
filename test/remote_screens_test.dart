import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/agent/remote_fs.dart';
import 'package:andropi/ui/chat_extras.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

/// Small things on screens that change when the agent is on a server and the screen only looks at the app's own state.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(PlatformBackend.method, (_) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(PlatformBackend.method, null));
  });

  AgentController agentOn({required bool server}) {
    final client = AgentClient(backend: FakeBackend());
    if (server) client.remote = const LaunchSpec(['ssh']);
    return AgentController(client);
  }

  group('dev server banner', () {
    final opened = <(String, String)>[];

    Future<void> show(WidgetTester tester, AgentController agent) async {
      opened.clear();
      agent.features.handleRecord({'type': 'dev_server', 'port': 3000, 'url': 'http://localhost:3000'});
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTheme(Brightness.light),
          home: Scaffold(
            body: DevServerBanner(agent: agent, opener: (context, title, url) async => opened.add((title, url))),
          ),
        ),
      );
    }

    testWidgets('on this phone the preview opens the dev server where it is', (tester) async {
      await show(tester, agentOn(server: false));
      await tester.tap(find.text('Preview'));
      await tester.pump();
      expect(opened, [('localhost:3000', 'http://localhost:3000')]);
    });

    testWidgets('on a server "localhost" is the phone, so the phone\'s own localhost is never opened', (tester) async {
      // No forward is possible here (no server set up), so nothing opens: certainly not http://localhost:3000.
      await show(tester, agentOn(server: true));
      expect(find.text('localhost:3000'), findsOneWidget, reason: 'the server still tells you it is running');
      await tester.tap(find.text('Preview'));
      await tester.pump();
      expect(opened, isEmpty);
    });
  });

  group('file access', () {
    test('the phone knows its files are its own, a server\'s are not', () {
      expect(const LocalFs().isLocal, isTrue);
      expect(RemoteFs(AgentClient(backend: FakeBackend()).call, phoneCache: Directory.systemTemp).isLocal, isFalse);
    });
  });
}
