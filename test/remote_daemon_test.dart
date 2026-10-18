import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/daemon.dart';

/// The client against the real host daemon, through the real attach program: the link is cut the way a network cuts it
/// (the attach process dies), and the transcript must come out whole, once.
void main() {
  final skip = TestDaemon.skip;

  late TestDaemon daemon;
  late MockModel model;
  late ProcessBackend backend;
  late AgentClient client;
  late List<Map<String, dynamic>> records;
  final clients = <AgentClient>[];

  AgentClient newClient(ProcessBackend backend) {
    final c = AgentClient(backend: backend)
      ..remote = daemon.launchSpec
      ..backoff = ((_) => const Duration(milliseconds: 50))
      ..readyTimeout = const Duration(seconds: 15);
    clients.add(c);
    return c;
  }

  setUp(() async {
    model = await MockModel.start();
    daemon = await TestDaemon.start(model: model, env: {'CODERRA_PING_MS': '150', 'CODERRA_IDLE_MS': '5000'});
    backend = ProcessBackend();
    client = newClient(backend);
    records = [];
    client.records.listen(records.add);
    await client.start();
    await client.call('set_model', {'provider': 'mock', 'model': 'mock-1'});
  });

  tearDown(() async {
    for (final c in clients) {
      await c.stop();
    }
    clients.clear();
    await daemon.dispose();
    await model.close();
  });

  Future<void> until(bool Function() ok, [String what = 'the condition', int seconds = 15]) async {
    final end = DateTime.now().add(Duration(seconds: seconds));
    while (!ok()) {
      if (DateTime.now().isAfter(end)) fail('timed out waiting for $what\n${daemon.stderrText}');
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  String text() => records
      .where((r) => r['type'] == 'event' && (r['event'] as Map)['type'] == 'message_update')
      .map((r) => ((r['event'] as Map)['assistantMessageEvent'] as Map))
      .where((d) => d['type'] == 'text_delta')
      .map((d) => d['delta'] as String)
      .join();

  int settled() => records.where((r) => r['type'] == 'event' && (r['event'] as Map)['type'] == 'agent_settled').length;

  test('connects through the real attach program and the host introduces itself', () {
    expect(client.serverHello?['mode'], 'vps');
    expect(client.serverHello?['protocol'], 1);
    expect(client.connection.value.connected, isTrue);
  }, skip: skip);

  test('a reply that is streaming when the link is cut arrives whole and once after reconnecting', () async {
    final reply = MockReply(['One ', 'two ', 'three ', 'four'], holdAfter: 2);
    model.script.add(reply);
    await client.call('prompt', {'text': 'count'});
    await until(() => text().contains('two'), 'the first words');

    backend.current!.kill(); // the network goes
    await until(() => client.connection.value.state == LinkState.reconnecting, 'the link to notice');
    reply.release(); // the agent carries on without the phone
    await until(() => client.connection.value.connected, 'the link to come back');
    await until(() => settled() == 1, 'the replies to finish');

    expect(text(), 'One two three four');
    // (The greeting carries the server's current number, which is not a record of the stream.)
    final seqs = [for (final r in records) if (r['seq'] is int && r['type'] != 'hello_server') r['seq'] as int];
    expect(seqs, [for (var i = 0; i < seqs.length; i++) seqs.first + i], reason: 'every record exactly once, in order');
    expect(records.where((r) => r['type'] == 'resync'), isEmpty);
  }, skip: skip);

  test('cut several times in a row during one reply, it still comes out whole', () async {
    final reply = MockReply(['a', 'b', 'c', 'd', 'e', 'f'], holdAfter: 3);
    model.script.add(reply);
    await client.call('prompt', {'text': 'go'});
    await until(() => text().contains('c'));
    for (var i = 0; i < 3; i++) {
      backend.current!.kill();
      await until(() => client.connection.value.state == LinkState.reconnecting);
      await until(() => client.connection.value.connected);
    }
    reply.release();
    await until(() => settled() == 1);
    expect(text(), 'abcdef');
  }, skip: skip);

  test('a command sent while offline is refused, and works again once the link is back', () async {
    final reply = MockReply(['x', 'y'], holdAfter: 1);
    model.script.add(reply);
    await client.call('prompt', {'text': 'go'});
    await until(() => text().contains('x'));
    client.backoff = (_) => const Duration(milliseconds: 300);
    backend.current!.kill();
    await until(() => client.connection.value.state == LinkState.reconnecting);
    await expectLater(client.call('state'), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'offline')));
    await until(() => client.connection.value.connected);
    final state = await client.call<Map>('state');
    expect(state['isStreaming'], true, reason: 'the agent kept working while the phone was away');
    reply.release();
    await until(() => settled() == 1);
  }, skip: skip);

  test('an approval raised while the phone was away is waiting for it when it returns, and answering it lets the agent go on', () async {
    await client.call('settings_set', {
      'settings': {'approvalMode': 'ask_all'},
    });
    final first = MockReply([], holdAfter: 0, toolCall: ('write', {'path': 'made-while-away.txt', 'content': 'hi'}));
    model.script
      ..add(first)
      ..add(MockReply(['Written.']));
    await client.call('prompt', {'text': 'write a file'});
    await until(() => model.requests == 1, 'the model to be asked');
    backend.current!.kill();
    await until(() => client.connection.value.state == LinkState.reconnecting);
    first.release(); // the agent reaches for the tool while nobody is looking
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await until(() => client.connection.value.connected);
    await until(() => records.any((r) => r['type'] == 'approval'), 'the approval to be replayed');

    final pending = await client.call<List>('approvals_pending');
    expect(pending, hasLength(1));
    expect(File('${daemon.workspace}/made-while-away.txt').existsSync(), isFalse, reason: 'nothing happens without an answer');
    await client.call('approval_reply', {'approvalId': (pending.single as Map)['approvalId'], 'allow': true});
    await until(() => settled() == 1, 'the agent to finish');
    expect(File('${daemon.workspace}/made-while-away.txt').readAsStringSync(), 'hi');
  }, skip: skip);

  test('a restarted daemon cannot replay: the client says so and the state is read again', () async {
    final epochBefore = client.serverHello!['epoch'];
    await daemon.kill();
    await until(() => client.connection.value.state == LinkState.reconnecting, 'the loss to be noticed');
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(client.connection.value.reason, isNotNull);
    await daemon.launch();
    await until(() => client.connection.value.connected, 'the daemon to be reached again', 30);
    await until(() => records.any((r) => r['type'] == 'resync'), 'the resync notice');
    expect(client.serverHello!['epoch'], isNot(epochBefore));
    expect((await client.call<Map>('hello'))['workspace'], isNotNull);
  }, skip: skip);

  test('while the daemon is down the reason shown is the real one', () async {
    await daemon.kill();
    await until(() => client.connection.value.state == LinkState.reconnecting && (client.connection.value.reason ?? '').contains('not running'), 'the reason', 20);
  }, skip: skip);

  test('a second device takes the connection over; the first stays out until it asks, and then takes it back', () async {
    final other = newClient(ProcessBackend());
    await other.start();
    await until(() => client.connection.value.kicked, 'to be kicked');
    expect(client.connection.value.state, LinkState.offline);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(client.connection.value.state, LinkState.offline, reason: 'no fighting over the connection');
    expect(other.connection.value.connected, isTrue);

    await client.reconnectNow();
    await until(() => client.connection.value.connected, 'to take it back');
    await until(() => other.connection.value.kicked, 'the other to be kicked in turn');
  }, skip: skip);

  test('the host learns whether the app is in the background from its answers to pings', () async {
    client.inBackground = true;
    final end = DateTime.now().add(const Duration(seconds: 10));
    var seen = false;
    while (DateTime.now().isBefore(end) && !seen) {
      seen = (await client.call<Map>('health'))['clientInBackground'] == true;
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    expect(seen, isTrue);
    client.inBackground = false;
    final end2 = DateTime.now().add(const Duration(seconds: 10));
    var back = false;
    while (DateTime.now().isBefore(end2) && !back) {
      back = (await client.call<Map>('health'))['clientInBackground'] == false;
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    expect(back, isTrue);
  }, skip: skip);

  test('a client that answers the pings is never dropped', () async {
    // The ping interval is 150 ms and the host drops a client silent for 5 s; a client that answers is never dropped.
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    expect(client.connection.value.connected, isTrue);
    expect(backend.started.length, 1, reason: 'it was never dropped, since it answers the pings');
  }, skip: skip);
}
