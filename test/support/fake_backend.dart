import 'dart:async';
import 'dart:convert';

import 'package:andropi/agent/agent_backend.dart';

/// Thrown from a scripted command to answer it with an error that has a code, as the host does.
class FakeFailure implements Exception {
  const FakeFailure(this.message, {this.code});

  final String message;
  final String? code;
}

/// A server agent played from the test: it says what the real one would say, and the test decides when it drops.
class FakeBackend implements AgentBackend {
  final _events = StreamController<Map<String, dynamic>>.broadcast();

  /// Every command the client wrote, decoded.
  final sent = <Map<String, dynamic>>[];
  var starts = 0;
  var running = false;

  /// What the server's greeting says; the test changes it to play an older or newer server.
  Map<String, dynamic> hello = {'type': 'hello_server', 'protocol': 1, 'mode': 'vps', 'epoch': 'aaaa', 'seq': 0, 'firstSeq': 1, 'hostVersion': 'test'};

  /// Answer to `resume` (merged over a default). Null makes the server stay silent.
  Map<String, dynamic>? Function(Map<String, dynamic> command)? onResume;

  /// How the next starts behave: true = the server greets, false = nothing happens (a hung connection),
  /// null = the process dies at once with exit code 3 (the daemon is not running).
  final startPlan = <bool?>[];

  /// Called for every command other than `resume` and `ping`; return the `data` of the response, or throw to fail.
  FutureOr<Object?> Function(Map<String, dynamic> command)? onCommand;

  @override
  Stream<Map<String, dynamic>> get events => _events.stream;

  @override
  Future<Map<String, String>> start([LaunchSpec? remote]) async {
    if (running) return const {};
    starts++;
    running = true;
    final plan = startPlan.isEmpty ? true : startPlan.removeAt(0);
    scheduleMicrotask(() {
      if (plan == true) {
        say(hello);
        say({'type': 'ready', 'version': 'test'});
      } else if (plan == null) {
        stderr('coderra-attach: cannot connect to /x/host.sock: the host is not running (ECONNREFUSED)');
        exit(3);
      }
    });
    return const {};
  }

  void say(Map<String, dynamic> record) => _events.add({'kind': 'stdout', 'line': jsonEncode(record)});

  void stderr(String line) => _events.add({'kind': 'stderr', 'line': line});

  void exit(int code) {
    running = false;
    _events.add({'kind': 'exit', 'code': code});
  }

  void respond(Map<String, dynamic> command, Object? data) => say({'type': 'response', 'id': command['id'], 'ok': true, 'data': data});

  void fail(Map<String, dynamic> command, String message, {String? code}) =>
      say({'type': 'response', 'id': command['id'], 'ok': false, 'error': message, 'code': ?code});

  @override
  Future<void> send(String line) async {
    final command = (jsonDecode(line) as Map).cast<String, dynamic>();
    sent.add(command);
    switch (command['type']) {
      case 'resume':
        final reply = onResume == null ? <String, dynamic>{} : onResume!(command);
        if (reply == null) return;
        respond(command, {'replayed': 0, 'gap': false, 'seq': hello['seq'], 'epoch': hello['epoch'], ...reply});
      case 'ping':
        break;
      default:
        if (onCommand == null) return;
        try {
          respond(command, await onCommand!(command));
        } on FakeFailure catch (e) {
          fail(command, e.message, code: e.code);
        } catch (e) {
          fail(command, e.toString());
        }
    }
  }

  @override
  Future<void> stop() async {
    if (running) scheduleMicrotask(() => exit(0));
  }

  @override
  Future<bool> isRunning() async => running;
}
