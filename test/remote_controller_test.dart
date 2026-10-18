import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/models.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/daemon.dart';

/// The controller (what the screens read) over a server agent link that drops: the conversation on screen must come out
/// right, and a dropped link must not look like a crash.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final skip = TestDaemon.skip;

  // The controller tells Android when the agent is busy; there is no Android here.
  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(PlatformBackend.method, (call) async => null);
  });

  late TestDaemon daemon;
  late MockModel model;
  late ProcessBackend backend;
  late AgentClient client;
  late AgentController agent;

  setUp(() async {
    model = await MockModel.start();
    daemon = await TestDaemon.start(model: model);
    backend = ProcessBackend();
    client = AgentClient(backend: backend)
      ..remote = daemon.launchSpec
      ..backoff = ((_) => const Duration(milliseconds: 50));
    agent = AgentController(client);
    await agent.boot();
    expect(agent.status, BootStatus.ready, reason: agent.bootError);
    await client.call('set_model', {'provider': 'mock', 'model': 'mock-1'});
  });

  tearDown(() async {
    await client.stop();
    await daemon.dispose();
    await model.close();
  });

  Future<void> until(bool Function() ok, [String what = 'the condition', int seconds = 20]) async {
    final end = DateTime.now().add(Duration(seconds: seconds));
    while (!ok()) {
      if (DateTime.now().isAfter(end)) fail('timed out waiting for $what');
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  String lastReply() {
    final a = agent.entries.whereType<AssistantEntry>().lastOrNull;
    return a == null ? '' : a.orderedBlocks.where((b) => b.kind == BlockKind.text).map((b) => b.text).join();
  }

  test('a dropped link is not a crash: the app stays on its screens and the reply finishes on its own', () async {
    final reply = MockReply(['Alpha ', 'beta ', 'gamma ', 'delta'], holdAfter: 2);
    model.script.add(reply);
    await agent.send('say the letters');
    await until(() => lastReply().contains('beta'));

    backend.current!.kill();
    await until(() => client.connection.value.state == LinkState.reconnecting);
    expect(agent.status, BootStatus.ready, reason: 'no failure screen');
    expect(agent.bootError, isNull);

    reply.release();
    await until(() => client.connection.value.connected);
    await until(() => !agent.busy, 'the agent to finish');
    expect(lastReply(), 'Alpha beta gamma delta');
    expect(agent.entries.whereType<AssistantEntry>(), hasLength(1), reason: 'nothing doubled');
    expect(agent.entries.whereType<UserEntry>().map((e) => e.text), ['say the letters']);
  }, skip: skip);

  test('after a restart of the daemon the chat is read from the host again and matches what it kept', () async {
    model.script.add(MockReply(['First answer']));
    await agent.send('first');
    await until(() => lastReply() == 'First answer' && !agent.busy);

    await daemon.kill();
    await until(() => client.connection.value.state == LinkState.reconnecting);
    // Something on screen that the host knows nothing about: the resync must replace the transcript, not add to it.
    agent.entries.add(UserEntry('a ghost from before'));
    await daemon.launch();
    await until(() => client.connection.value.connected, 'the reconnect', 30);
    await until(() => agent.entries.whereType<UserEntry>().length == 1 && lastReply() == 'First answer', 'the chat to be reloaded');
    expect(agent.entries.whereType<AssistantEntry>(), hasLength(1));
    expect(agent.entries.whereType<UserEntry>().map((e) => e.text), ['first']);
    expect(agent.status, BootStatus.ready);

    // And it still works afterwards.
    model.script.add(MockReply(['Second answer']));
    await agent.send('second');
    await until(() => lastReply() == 'Second answer' && !agent.busy);
    expect(agent.entries.whereType<AssistantEntry>(), hasLength(2));
  }, skip: skip);

  test('a first connection that fails is a failed start with the reason, as on the phone', () async {
    await daemon.kill();
    final c = AgentClient(backend: ProcessBackend())..remote = daemon.launchSpec;
    final a = AgentController(c);
    await a.boot();
    expect(a.status, BootStatus.failed);
    expect(a.bootError, contains('not running'));
    await c.stop();
  }, skip: skip);
}
