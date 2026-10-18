import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';

/// How to start the host somewhere other than this phone: the program and its arguments (normally `ssh ... coderra-attach`),
/// and the environment to give it.
class LaunchSpec {
  const LaunchSpec(this.argv, {this.env = const {}});

  final List<String> argv;
  final Map<String, String> env;
}

/// What [AgentClient] needs from whatever runs the host: start it, write lines to it, read the lines and the exit back.
///
/// The app uses [PlatformBackend] (Kotlin owns the process). Tests use [ProcessBackend] to run the real thing on a laptop.
abstract class AgentBackend {
  /// `{kind: stdout|stderr, line}`, `{kind: exit, code}`, and `{kind: launch}` (the app was opened by a share or widget).
  Stream<Map<String, dynamic>> get events;

  /// Starts the host on this device ([remote] null), or the command in [remote]. Does nothing if it is already running.
  /// Returns the app's paths (`home`, `agentDir`, `workspace`, `hostDir`, `nativeLibDir`) when it knows them.
  Future<Map<String, String>> start([LaunchSpec? remote]);

  Future<void> send(String line);

  /// Asks the process to end (closing its stdin), and forces it if it does not.
  Future<void> stop();

  Future<bool> isRunning();
}

/// The Android side: Kotlin's `AgentRuntime` owns the process.
class PlatformBackend implements AgentBackend {
  PlatformBackend() {
    _events.receiveBroadcastStream().listen((raw) => _controller.add((raw as Map).cast<String, dynamic>()));
  }

  static const method = MethodChannel('andropi/agent');
  static const _events = EventChannel('andropi/agent/events');

  final _controller = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> get events => _controller.stream;

  @override
  Future<Map<String, String>> start([LaunchSpec? remote]) async {
    final result = remote == null
        ? await method.invokeMethod<Map>('start')
        : await method.invokeMethod<Map>('startRemote', {'argv': remote.argv, 'env': remote.env});
    return result?.cast<String, String>() ?? const {};
  }

  @override
  Future<void> send(String line) => method.invokeMethod('send', line);

  @override
  Future<void> stop() => method.invokeMethod('stop');

  @override
  Future<bool> isRunning() async => await method.invokeMethod<bool>('isRunning') == true;
}

/// Runs the command as an ordinary child process. For tests, and for anything that is not Android.
class ProcessBackend implements AgentBackend {
  ProcessBackend({this.workingDirectory});

  final String? workingDirectory;
  final _controller = StreamController<Map<String, dynamic>>.broadcast();
  Process? _process;

  /// Every process started, newest last (tests kill one to simulate the network dropping).
  final started = <Process>[];

  @override
  Stream<Map<String, dynamic>> get events => _controller.stream;

  Process? get current => _process;

  @override
  Future<Map<String, String>> start([LaunchSpec? remote]) async {
    if (_process != null) return const {};
    if (remote == null) throw StateError('ProcessBackend only runs a command: give it a LaunchSpec');
    final process = await Process.start(
      remote.argv.first,
      remote.argv.skip(1).toList(),
      environment: remote.env,
      workingDirectory: workingDirectory,
    );
    _process = process;
    started.add(process);
    // A broken pipe (the process is gone) is reported by the exit event, not as an unhandled error here.
    unawaited(process.stdin.done.catchError((_) {}));
    void lines(Stream<List<int>> s, String kind) =>
        s.transform(utf8.decoder).transform(const LineSplitter()).listen((l) => _controller.add({'kind': kind, 'line': l}));
    lines(process.stdout, 'stdout');
    lines(process.stderr, 'stderr');
    unawaited(
      process.exitCode.then((code) {
        if (identical(_process, process)) _process = null;
        _controller.add({'kind': 'exit', 'code': code});
      }),
    );
    return const {};
  }

  @override
  Future<void> send(String line) async {
    final p = _process;
    if (p == null) throw StateError('the process is not running');
    // No flush: it cannot run while another write is being flushed, and writes are sent in order anyway.
    p.stdin.writeln(line);
  }

  @override
  Future<void> stop() async {
    final p = _process;
    if (p == null) return;
    unawaited(p.stdin.close().catchError((_) {}));
    unawaited(Future<void>.delayed(const Duration(milliseconds: 1500)).then((_) => p.kill()));
  }

  @override
  Future<bool> isRunning() async => _process != null;
}
