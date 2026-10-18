import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:andropi/agent/agent_client.dart' show AgentError;

/// The Node side of the file protocol (agent/test/harness/fs_server.ts, the real fs.ts behind a JSONL pipe), started as
/// a child process so Dart tests talk to it exactly as the app talks to the host.
///
/// It exists once `npm test` has run in agent/ (that builds it) and `node` is on the PATH. Otherwise [start] returns
/// null and the tests that need it say so.
class FsServer {
  FsServer._(this._process);

  static const harness = 'agent/.test-out/harness/fs_server.mjs';

  /// Why the server is unavailable, or null when it can run.
  static String? get unavailable {
    if (!File(harness).existsSync()) return 'run `npm test` in agent/ first: it builds $harness';
    try {
      if (Process.runSync(_node, ['--version']).exitCode != 0) return 'node does not run';
    } on ProcessException {
      return 'node is not on the PATH (set NODE to its location)';
    }
    return null;
  }

  static String get _node => Platform.environment['NODE'] ?? 'node';

  /// [roots] is a list of `{path, readOnly?}`; [limits] overrides the server's limits (chunk, maxWrite, ...).
  static Future<FsServer> start({required List<Map<String, Object?>> roots, Map<String, Object?> limits = const {}}) async {
    final process = await Process.start(_node, [harness, jsonEncode(roots), jsonEncode(limits)]);
    final server = FsServer._(process);
    process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen(server._onLine);
    // Anything the child prints on stderr is a bug in the harness; surface it in the test log.
    process.stderr.transform(utf8.decoder).listen((e) => stderr.write('[fs_server] $e'));
    return server;
  }

  final Process _process;
  final _pending = <int, Completer<Object?>>{};
  var _nextId = 1;

  /// Same shape as `AgentClient.call`, so it can be handed to `RemoteFs`.
  Future<T> call<T>(String type, [Map<String, dynamic> args = const {}]) {
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    _process.stdin.writeln(jsonEncode({'id': id, 'type': type, ...args}));
    return completer.future.then((v) => v as T);
  }

  void _onLine(String line) {
    final record = jsonDecode(line) as Map<String, dynamic>;
    final completer = _pending.remove(record['id']);
    if (completer == null) return;
    if (record['ok'] == true) {
      completer.complete(record['data']);
    } else {
      completer.completeError(AgentError(record['error'] as String? ?? 'Unknown error', code: record['code'] as String?));
    }
  }

  Future<void> close() async {
    await _process.stdin.close();
    await _process.exitCode.timeout(const Duration(seconds: 5), onTimeout: () {
      _process.kill();
      return -1;
    });
  }
}
