import 'dart:async';

import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_backend.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

/// The client's side of a server agent link, with the server played from the test: reconnecting, resuming, and what
/// callers see while the link is down.
void main() {
  late FakeBackend backend;
  late AgentClient client;
  late List<Map<String, dynamic>> records;
  late List<LinkState> states;

  setUp(() {
    backend = FakeBackend();
    client = AgentClient(backend: backend)
      ..remote = const LaunchSpec(['ssh', 'x'])
      ..backoff = ((_) => const Duration(milliseconds: 20))
      ..readyTimeout = const Duration(milliseconds: 300);
    records = [];
    states = [LinkState.offline];
    client.records.listen(records.add);
    client.connection.addListener(() {
      if (states.last != client.connection.value.state) states.add(client.connection.value.state);
    });
  });

  Future<void> until(bool Function() ok, [String what = 'the condition']) async {
    final end = DateTime.now().add(const Duration(seconds: 5));
    while (!ok()) {
      if (DateTime.now().isAfter(end)) fail('timed out waiting for $what');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  List<Map<String, dynamic>> ofType(String type) => records.where((r) => r['type'] == type).toList();

  test('connecting says hello, subscribes from now on, and the link counts as up', () async {
    await client.start();
    expect(client.connection.value.state, LinkState.connected);
    expect(client.serverHello?['mode'], 'vps');
    expect(backend.sent.single, {'id': 1, 'type': 'resume', 'since': null});
    expect(states, [LinkState.offline, LinkState.connecting, LinkState.connected]);
  });

  test('it refuses a server that speaks a newer protocol, and one that is not ours', () async {
    backend.hello = {...backend.hello, 'protocol': 99};
    await expectLater(client.start(), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'protocol')));
    expect(client.connection.value.state, LinkState.offline);
    expect(backend.running, isFalse, reason: 'the connection is closed again');

    // Something that answers but never introduces itself.
    final other = FakeBackend();
    other.hello = {'type': 'banner'};
    final c2 = AgentClient(backend: other)..remote = const LaunchSpec(['ssh']);
    await expectLater(c2.start(), throwsA(isA<AgentError>().having((e) => e.message, 'message', contains('not a CoderRa'))));
  });

  test('a server that never answers is given up on, with what ssh said', () async {
    backend.startPlan.add(false);
    Timer(const Duration(milliseconds: 50), () => backend.stderr('ssh: connect to host x port 22: Connection timed out'));
    await expectLater(
      client.start(),
      throwsA(isA<AgentError>().having((e) => e.message, 'message', allOf(contains('did not answer'), contains('Connection timed out')))),
    );
    expect(client.connection.value.state, LinkState.offline);
  });

  test('when the link drops it reconnects and asks for what it missed, from the last record it saw', () async {
    await client.start();
    backend.say({'seq': 1, 'type': 'event', 'event': {'type': 'a'}});
    backend.say({'seq': 2, 'type': 'event', 'event': {'type': 'b'}});
    await until(() => ofType('event').length == 2);

    backend.exit(255);
    await until(() => client.connection.value.state == LinkState.reconnecting);
    expect(client.connection.value.attempt, 1);
    await until(() => client.connection.value.connected);

    expect(backend.starts, 2);
    expect(backend.sent.last, {'id': 2, 'type': 'resume', 'since': 2, 'epoch': 'aaaa'});
    expect(ofType('reconnected'), [
      {'type': 'reconnected', 'resync': false},
    ]);
    expect(ofType('resync'), isEmpty);
    expect(states, [LinkState.offline, LinkState.connecting, LinkState.connected, LinkState.reconnecting, LinkState.connected]);
  });

  test('records it has already seen are dropped, new ones come through, in any mix of replay and live', () async {
    await client.start();
    for (final seq in [1, 2, 3]) {
      backend.say({'seq': seq, 'type': 'notice', 'message': 'n$seq'});
    }
    await until(() => ofType('notice').length == 3);
    backend.exit(255);
    backend.onResume = (_) => {'replayed': 2};
    await until(() => backend.starts == 2);
    // The server replays 3 again (a doubled line) and 4, 5, then the live stream carries on with 5 again and 6.
    await until(() => backend.sent.any((c) => c['type'] == 'resume' && c['since'] == 3));
    for (final seq in [3, 4, 5, 5, 6]) {
      backend.say({'seq': seq, 'type': 'notice', 'message': 'n$seq'});
    }
    await until(() => ofType('notice').length >= 6);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(ofType('notice').map((r) => r['message']), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  });

  test('when the server cannot replay (it restarted, or the gap is too big) listeners are told to read the state again, after the link is up', () async {
    await client.start();
    backend.say({'seq': 7, 'type': 'notice', 'message': 'x'});
    await until(() => ofType('notice').isNotEmpty);
    backend.hello = {...backend.hello, 'epoch': 'bbbb', 'seq': 3};
    backend.onResume = (_) => {'gap': true, 'replayed': 0};
    final upWhenTold = <bool>[];
    client.records.listen((r) {
      if (r['type'] == 'resync') upWhenTold.add(client.connection.value.connected);
    });
    backend.exit(255);
    await until(() => ofType('resync').isNotEmpty);
    expect(upWhenTold, [true], reason: 'a listener that calls the host at once must not be told "offline"');
    expect(ofType('reconnected').single['resync'], true);

    // The new server's numbering starts again: its first records are not mistaken for old ones.
    backend.say({'seq': 4, 'type': 'notice', 'message': 'fresh'});
    await until(() => ofType('notice').any((r) => r['message'] == 'fresh'));
    expect(backend.sent.last, {'id': 2, 'type': 'resume', 'since': 7, 'epoch': 'aaaa'});
  });

  test('while the link is down calls fail at once instead of hanging; a call in flight fails as connection_lost', () async {
    await client.start();
    backend.onCommand = (c) => Completer<Object?>().future; // never answers
    final inFlight = client.call('messages');
    final caught = expectLater(inFlight, throwsA(isA<AgentError>().having((e) => e.code, 'code', 'connection_lost')));
    await Future<void>.delayed(const Duration(milliseconds: 10));
    backend.startPlan.addAll([null, null, true]);
    backend.exit(255);
    await caught;
    await until(() => client.connection.value.state == LinkState.reconnecting);
    await expectLater(client.call('state'), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'offline')));

    // Back up: calls work again.
    backend.onCommand = (c) => {'ok': true};
    await until(() => client.connection.value.connected);
    expect(await client.call<Map>('state'), {'ok': true});
  });

  test('attempts are spaced by the backoff, and the reason of the last failure is shown', () async {
    final waits = <int>[];
    client.backoff = (n) {
      waits.add(n);
      return const Duration(milliseconds: 10);
    };
    await client.start();
    backend.startPlan.addAll([null, null, null, true]);
    backend.exit(255);
    await until(() => client.connection.value.state == LinkState.reconnecting && client.connection.value.attempt >= 3);
    expect(client.connection.value.reason, contains('the host is not running'));
    await until(() => client.connection.value.connected);
    expect(waits, [1, 2, 3, 4]);
    expect(backend.starts, 5);
  });

  test('an argument called id or type cannot take over the request\'s own', () async {
    await client.start();
    backend.onCommand = (c) => {'echo': c['id']};
    final answer = await client.call<Map>('app_update_status', {'id': 'u1', 'type': 'other', 'downloadId': 'u1'});
    final sent = backend.sent.last;
    expect([sent['type'], sent['id'] is int, sent['downloadId']], ['app_update_status', true, 'u1']);
    expect(answer['echo'], sent['id'], reason: 'the answer came back to the caller');
  });

  test('the real backoff is 1, 2, 4, 8, 16, then 30 seconds', () {
    expect([for (var i = 1; i <= 8; i++) defaultBackoff(i).inSeconds], [1, 2, 4, 8, 16, 30, 30, 30]);
  });

  test('another device taking over ends the link for good until the user asks', () async {
    await client.start();
    backend.say({'type': 'kicked'});
    backend.exit(0);
    await until(() => client.connection.value.kicked);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(backend.starts, 1, reason: 'it did not fight for the connection');
    expect(client.connection.value.state, LinkState.offline);
    expect(client.connection.value.reason, contains('Another device'));

    unawaited(client.reconnectNow());
    await until(() => client.connection.value.connected);
    expect(backend.starts, 2);
  });

  test('stopping ends the reconnecting', () async {
    await client.start();
    backend.startPlan.addAll([null, null, null, null, null, null]);
    backend.exit(255);
    await until(() => client.connection.value.attempt >= 2);
    await client.stop();
    final starts = backend.starts;
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(backend.starts, starts);
    expect(client.connection.value.state, LinkState.offline);
  });

  test('reconnectNow skips the wait', () async {
    client.backoff = (_) => const Duration(minutes: 10);
    await client.start();
    backend.exit(255);
    await until(() => client.connection.value.state == LinkState.reconnecting);
    unawaited(client.reconnectNow());
    await until(() => client.connection.value.connected);
  });

  test('pings from the server are answered, saying whether the app is in the background', () async {
    await client.start();
    backend.say({'type': 'ping'});
    await until(() => backend.sent.any((c) => c['type'] == 'ping'));
    expect(backend.sent.last, {'type': 'ping', 'background': false});
    client.inBackground = true;
    backend.say({'type': 'ping'});
    await until(() => backend.sent.where((c) => c['type'] == 'ping').length == 2);
    expect(backend.sent.last, {'type': 'ping', 'background': true});
    expect(ofType('ping'), isEmpty, reason: 'pings are not passed on to the app');
  });

  test('on this phone nothing of this applies: no resume, no reconnecting, no offline errors', () async {
    final local = FakeBackend()..startPlan.add(false);
    final c = AgentClient(backend: local);
    final start = c.start();
    scheduleMicrotask(() => local.say({'type': 'ready'}));
    await start;
    local.onCommand = (_) => 'fine';
    expect(await c.call<String>('hello'), 'fine');
    expect(local.sent.map((s) => s['type']), ['hello']);
    expect(c.connection.value.connected, isTrue);
    local.exit(1);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(local.starts, 1, reason: 'a crashed local host is the controller\'s business, not retried here');
    unawaited(c.call<Object?>('x').then((_) {}, onError: (_) {}));
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(local.sent.last['type'], 'x', reason: 'a call is sent, not refused');
  });
}
