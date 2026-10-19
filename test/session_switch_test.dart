import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

/// Switching chats while the agent works in the open one stops it, so the host refuses (`busy`) and the user decides.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeBackend backend;
  late AgentController agent;
  final asked = <String>[];

  setUp(() {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      PlatformBackend.method,
      (_) async => null,
    );
    addTearDown(
      () => messenger.setMockMethodCallHandler(PlatformBackend.method, null),
    );
    backend = FakeBackend()..running = true;
    agent = AgentController(
      AgentClient(backend: backend)
        ..backoff = ((_) => const Duration(milliseconds: 20)),
    );
    asked.clear();
    // Stands in for the host: busy unless the switch is meant.
    backend.onCommand = (c) {
      switch (c['type']) {
        case 'open_session' || 'new_session' || 'fork_session':
          if (c['force'] != true)
            throw const FakeFailure(
              'The agent is still working in this chat.',
              code: 'busy',
            );
          return {
            'sessionId': 'new',
            'sessionFile': '/s/new.jsonl',
            'cwd': '/w',
            'isStreaming': false,
          };
        case 'messages':
          return <Object>[];
        default:
          return <String, Object>{};
      }
    };
  });

  Iterable<Map<String, dynamic>> sent(String type) =>
      backend.sent.where((c) => c['type'] == type);

  test(
    'keeping the chat that is working sends nothing more and reports no switch',
    () async {
      agent.confirmStop = (message) async {
        asked.add(message);
        return false;
      };
      expect(await agent.openSession('/s/other.jsonl'), isFalse);
      expect(asked, ['The agent is still working in this chat.']);
      expect(sent('open_session').map((c) => c['force']), [
        null,
      ], reason: 'not sent again with force');
      expect(agent.sessionId, isNot('new'));
    },
  );

  test('stopping it switches with force', () async {
    agent.confirmStop = (_) async => true;
    expect(await agent.newSession(dir: '/w'), isTrue);
    expect(sent('new_session').map((c) => c['force']), [null, true]);
    expect(agent.sessionId, 'new');
  });

  test('without anyone to ask, the refusal reaches the caller', () async {
    await expectLater(
      agent.openSession('/s/other.jsonl'),
      throwsA(isA<AgentError>().having((e) => e.code, 'code', 'busy')),
    );
  });
}
