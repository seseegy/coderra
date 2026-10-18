import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'remote_profile.dart';

/// Ports on the server that the app reaches through ssh: `ssh -N -L` processes, one per server port, started when
/// something needs them (a preview) and dropped when the link goes. A forward that died on its own (the connection broke)
/// is noticed and made again the next time it is asked for.
class PortForwards {
  PortForwards({required this.setup, required this.env});

  final RemoteSetup setup;
  final Map<String, String> env;

  final _open = <int, Future<_Forward>>{};

  /// Where the server's [remotePort] can be reached on this phone (`127.0.0.1:<port>`). Starts the forward if needed.
  Future<int> open(int remotePort, {Duration timeout = const Duration(seconds: 20)}) async {
    final existing = _open[remotePort];
    if (existing != null) {
      final f = await _peek(existing);
      if (f != null && f.alive) return f.local;
      _open.remove(remotePort);
    }
    final started = _start(remotePort, timeout);
    _open[remotePort] = started;
    try {
      return (await started).local;
    } catch (_) {
      if (identical(_open[remotePort], started)) _open.remove(remotePort);
      rethrow;
    }
  }

  Future<_Forward> _start(int remotePort, Duration timeout) async {
    String? lastError;
    for (var attempt = 0; attempt < 3; attempt++) {
      final local = await _freePort();
      final process = await Process.start(setup.forwardArgv(local, remotePort).first, setup.forwardArgv(local, remotePort).skip(1).toList(), environment: env);
      final forward = _Forward(process, local);
      final err = StringBuffer();
      process.stderr.transform(utf8.decoder).listen(err.write);
      process.stdout.drain<void>();
      unawaited(process.exitCode.then((_) => forward.alive = false));

      final end = DateTime.now().add(timeout);
      while (forward.alive && DateTime.now().isBefore(end)) {
        try {
          (await Socket.connect('127.0.0.1', local, timeout: const Duration(milliseconds: 300))).destroy();
          return forward;
        } on SocketException {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
      }
      lastError = err.toString().trim();
      process.kill();
      if (forward.alive) throw StateError('The connection to the server took too long.');
      // The port we picked was taken in the meantime: pick another. Anything else is not going to get better.
      if (!RegExp(r'address already in use|cannot listen|bind', caseSensitive: false).hasMatch(lastError)) break;
    }
    throw StateError(lastError == null || lastError.isEmpty ? 'Could not open a connection to the server.' : lastError.split('\n').last);
  }

  static Future<_Forward?> _peek(Future<_Forward> f) => f.then<_Forward?>((v) => v, onError: (_) => null);

  static Future<int> _freePort() async {
    final s = await ServerSocket.bind('127.0.0.1', 0);
    final port = s.port;
    await s.close();
    return port;
  }

  Future<void> close(int remotePort) async {
    final f = _open.remove(remotePort);
    if (f == null) return;
    (await _peek(f))?.kill();
  }

  Future<void> closeAll() async {
    for (final port in _open.keys.toList()) {
      await close(port);
    }
  }

  /// The server ports with a live forward.
  Future<List<int>> get openPorts async {
    final out = <int>[];
    for (final e in _open.entries) {
      final f = await _peek(e.value);
      if (f != null && f.alive) out.add(e.key);
    }
    return out;
  }
}

class _Forward {
  _Forward(this.process, this.local);

  final Process process;
  final int local;
  bool alive = true;

  void kill() {
    alive = false;
    process.kill();
  }
}
