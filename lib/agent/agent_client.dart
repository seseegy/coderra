import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'agent_backend.dart';

/// Where the link to the host stands. On this phone it is always [connected]; with a server agent it comes and goes.
enum LinkState { connecting, connected, reconnecting, offline }

class Connection {
  const Connection(this.state, {this.attempt = 0, this.retryAt, this.reason, this.kicked = false});

  static const local = Connection(LinkState.connected);

  final LinkState state;

  /// The reconnect attempt being waited for or made (1, 2, ...).
  final int attempt;

  /// When the next attempt starts, while waiting for it.
  final DateTime? retryAt;

  /// The last thing that went wrong, in words.
  final String? reason;

  /// Another device took the connection over; nothing reconnects until the user asks.
  final bool kicked;

  bool get connected => state == LinkState.connected;
}

/// 1, 2, 4, 8, 16, then 30 seconds between attempts.
Duration defaultBackoff(int attempt) => Duration(seconds: attempt >= 6 ? 30 : 1 << (attempt - 1));

/// The newest protocol version of the server this app understands (`hello_server.protocol`).
const supportedProtocol = 1;

/// Talks to the pi agent host (agent/src/host.ts): a Node child process on this phone, or a daemon on a server reached
/// through ssh. Commands and records are JSONL; see the host for the protocol.
///
/// With a server agent ([remote] set) the link can drop. The client then reconnects by itself, asks the host to replay
/// what it missed (`resume`), drops anything it already has, and tells whoever listens when the replay was not possible
/// (a `resync` record: reload the state instead).
class AgentClient {
  AgentClient({AgentBackend? backend}) : backend = backend ?? PlatformBackend() {
    this.backend.events.listen(_onPlatformEvent);
  }

  static const _method = PlatformBackend.method;

  final AgentBackend backend;
  final _records = StreamController<Map<String, dynamic>>.broadcast();
  final _pending = <int, Completer<dynamic>>{};
  final _stderr = <String>[];
  Completer<void>? _ready;
  int _nextId = 1;

  /// Set before [start] to run the host on a server instead of on this phone.
  LaunchSpec? remote;

  bool get isRemote => remote != null;

  /// The link to the host, for the connection indicator.
  final connection = ValueNotifier<Connection>(Connection.local);

  /// What the server said about itself when the link came up (`mode`, `epoch`, `hostVersion`, ...); null on this phone.
  Map<String, dynamic>? serverHello;

  /// Whether the app is in the background. The server uses it to decide whether to push a notification instead.
  bool inBackground = false;

  /// How long to wait before reconnect attempt number n. Tests shorten it.
  Duration Function(int attempt) backoff = defaultBackoff;

  /// How long one connection attempt may take before it is given up.
  Duration readyTimeout = const Duration(seconds: 60);

  var _wantConnected = false;
  var _kicked = false;
  var _resyncNeeded = false;
  var _lastSeq = 0;
  String? _epoch;
  Future<void>? _loop;
  Completer<void>? _wake;

  /// Every record the host writes that is not a command response.
  Stream<Map<String, dynamic>> get records => _records.stream;

  /// Recent stderr output, useful when the host fails to start.
  List<String> get stderrTail => List.unmodifiable(_stderr);

  Map<String, String> paths = const {};

  /// Starts the host, or connects to it, and waits until it is ready. Throws if that does not work; whether to try
  /// again is the caller's decision. Once it has worked, a server link that drops is reconnected by the client itself.
  Future<void> start() async {
    _wantConnected = true;
    _kicked = false;
    if (!isRemote) {
      _ready = Completer<void>();
      paths = await backend.start();
      return _ready!.future.timeout(const Duration(seconds: 60));
    }
    _setConnection(const Connection(LinkState.connecting));
    try {
      await _connectOnce();
    } catch (e) {
      _wantConnected = false;
      _setConnection(Connection(LinkState.offline, reason: e.toString()));
      rethrow;
    }
    _setConnection(const Connection(LinkState.connected));
  }

  Future<void> stop() async {
    _wantConnected = false;
    _wake?.complete();
    if (isRemote) _setConnection(const Connection(LinkState.offline));
    await backend.stop();
  }

  Future<void> restart() async {
    await stop();
    while (await backend.isRunning()) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    await start();
  }

  /// Tries again now: right away when waiting to reconnect, or taking the connection back after another device had it.
  Future<void> reconnectNow() async {
    if (!isRemote || connection.value.connected) return;
    _wantConnected = true;
    _kicked = false;
    if (_loop != null) {
      _wake?.complete();
      return;
    }
    _beginReconnecting(connection.value.reason);
  }

  /// Resolves when the link to the server is up (at once on this phone, or when it already is). Fails with code `offline`
  /// when it is down and nothing is trying to bring it back (stopped, or another device has it), or when it stays down
  /// for [timeout]. For work that should carry on after a dropped connection instead of failing.
  Future<void> whenConnected({Duration timeout = const Duration(minutes: 5)}) async {
    if (!isRemote || connection.value.connected) return;
    final done = Completer<void>();
    void check() {
      final c = connection.value;
      if (done.isCompleted) return;
      if (c.connected) {
        done.complete();
      } else if (c.state == LinkState.offline) {
        done.completeError(AgentError(c.kicked ? 'Another device took over the connection.' : 'Not connected to the server.', code: 'offline'));
      }
    }

    connection.addListener(check);
    try {
      check();
      await done.future.timeout(timeout, onTimeout: () => throw AgentError('The connection to the server did not come back.', code: 'offline'));
    } finally {
      connection.removeListener(check);
    }
  }

  Future<void> setBusy(bool busy) => _method.invokeMethod('setBusy', busy);

  Future<void> openUrl(String url) => _method.invokeMethod('openUrl', url);

  /// Hands a downloaded APK to the system installer. Returns 'launched', or
  /// 'needs-permission' when the user must first allow installs for this app
  /// (the system settings screen is opened in that case).
  Future<String> installApk(String path) async =>
      (await _method.invokeMethod<String>('installApk', path)) ?? 'error';

  /// This build's version name, number and CPU (`arm64-v8a`, ...), for update checks.
  Future<({String version, int build, String abi})> appInfo() async {
    final m = (await _method.invokeMethod<Map>('appInfo'))!;
    return (version: m['version'] as String? ?? '', build: (m['build'] as num?)?.toInt() ?? 0, abi: m['abi'] as String? ?? '');
  }

  /// Whether this build can ask for shared storage at all (the Play build can't), whether it has it, and where it is.
  Future<({bool available, bool granted, String root})> storageAccess() async {
    final m = (await _method.invokeMethod<Map>('storageAccess'))!;
    return (available: m['available'] != false, granted: m['granted'] == true, root: m['root'] as String);
  }

  /// Keeps the app alive in the background (queued runs, schedules).
  Future<void> keepAlive(bool on, {String? text}) => _method.invokeMethod('keepAlive', {'on': on, 'text': text});

  /// System speech recognizer; null when cancelled.
  Future<String?> listen({String? language}) => _method.invokeMethod<String>('listen', {'language': language});

  /// Why the app was opened (share from another app, widget, tile), once.
  Future<Map<String, dynamic>?> takeLaunch() async =>
      (await _method.invokeMethod<Map>('takeLaunch'))?.cast<String, dynamic>();

  Future<void> notify(int id, String title, String body) =>
      _method.invokeMethod('notify', {'id': id, 'title': title, 'body': body});

  Future<void> requestNotifications() => _method.invokeMethod('requestNotifications');

  /// Opens the Android share sheet for a file.
  Future<void> shareFile(String path) => _method.invokeMethod('shareFile', {'path': path});

  /// Copies a file into the phone's Download/CoderRa folder; returns where it landed.
  Future<String> saveToDownloads(String path) async =>
      (await _method.invokeMethod<String>('saveToDownloads', {'path': path}))!;

  /// Opens the system page where the user grants "All files access".
  Future<void> requestStorageAccess() => _method.invokeMethod('requestStorageAccess');

  /// The environment the agent runs with (PATH, HOME, git/ssh setup).
  Future<Map<String, String>> environment() async =>
      (await _method.invokeMethod<Map>('environment'))!.cast<String, String>();

  /// Sends a command and resolves with its `data`, or throws [AgentError]. While the server link is down it fails at
  /// once with code `offline` instead of waiting, and a command that was in flight when the link dropped fails with
  /// `connection_lost` (it may or may not have run; the replay after reconnecting shows what happened).
  Future<T> call<T>(String type, [Map<String, dynamic> args = const {}]) {
    if (isRemote && !connection.value.connected) {
      return Future.error(AgentError('Not connected to the server.', code: 'offline'));
    }
    return _call<T>(type, args);
  }

  Future<T> _call<T>(String type, Map<String, dynamic> args) {
    final id = _nextId++;
    final completer = Completer<dynamic>();
    _pending[id] = completer;
    // The envelope goes last: an argument called `id` or `type` must not replace the request's own, or the answer would
    // come back under a name nobody is waiting for.
    backend.send(jsonEncode({...args, 'id': id, 'type': type})).catchError((Object e) {
      if (_pending.remove(id) != null) completer.completeError(AgentError('Could not send: $e', code: isRemote ? 'connection_lost' : null));
    });
    return completer.future.then((v) => v as T);
  }

  // -------------------------------------------------------------------------
  // The server link

  void _setConnection(Connection c) {
    connection.value = c;
  }

  /// One attempt: start the command, wait for the host to say it is ready, and subscribe (resuming where we were).
  Future<void> _connectOnce() async {
    _ready = Completer<void>();
    serverHello = null;
    final stderrBefore = _stderr.length;
    paths = {...paths, ...await backend.start(remote)};
    try {
      await _ready!.future.timeout(readyTimeout);
      final hello = serverHello;
      if (hello == null) throw AgentError('This is not a CoderRa server agent (it did not introduce itself).');
      final protocol = (hello['protocol'] as num?)?.toInt() ?? 0;
      if (protocol > supportedProtocol) {
        throw AgentError('The server agent is newer than this app (protocol $protocol). Update the app.', code: 'protocol');
      }
      final resumeFrom = _epoch == null ? null : _lastSeq;
      final r = (await _call<Map>('resume', {'since': resumeFrom, 'epoch': ?_epoch})).cast<String, dynamic>();
      final gap = r['gap'] == true;
      _epoch = r['epoch'] as String? ?? _epoch;
      // After a replay we are at its last record; after a gap the numbering is the server's own, from where it stands now.
      final seq = (r['seq'] as num?)?.toInt() ?? _lastSeq;
      _lastSeq = gap ? seq : (seq > _lastSeq ? seq : _lastSeq);
      // The replay was not possible: announced once the link counts as up, so listeners can ask for the state.
      _resyncNeeded = gap && resumeFrom != null;
    } on TimeoutException {
      await _abandon();
      throw AgentError('The server did not answer in ${readyTimeout.inSeconds} s.${_whyFrom(stderrBefore)}');
    } catch (e) {
      final why = _whyFrom(stderrBefore);
      await _abandon();
      if (e is AgentError && why.isNotEmpty && !e.message.contains(why.trim())) throw AgentError('${e.message}$why', code: e.code);
      rethrow;
    }
  }

  String _whyFrom(int from) {
    final lines = _stderr.skip(from).where((l) => l.trim().isNotEmpty).toList();
    return lines.isEmpty ? '' : '\n${lines.skip(lines.length > 3 ? lines.length - 3 : 0).join('\n')}';
  }

  /// Ends a connection attempt that did not work, and waits for the process to be gone.
  Future<void> _abandon() async {
    await backend.stop();
    for (var i = 0; i < 40 && await backend.isRunning(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
  }

  void _beginReconnecting(String? reason) {
    _loop ??= _reconnectLoop(reason).whenComplete(() => _loop = null);
  }

  Future<void> _reconnectLoop(String? firstReason) async {
    var attempt = 0;
    var reason = firstReason;
    while (_wantConnected && !_kicked) {
      attempt++;
      final wait = backoff(attempt);
      _setConnection(Connection(LinkState.reconnecting, attempt: attempt, retryAt: DateTime.now().add(wait), reason: reason));
      _wake = Completer<void>();
      await Future.any([Future<void>.delayed(wait), _wake!.future]);
      _wake = null;
      if (!_wantConnected || _kicked) break;
      _setConnection(Connection(LinkState.reconnecting, attempt: attempt, reason: reason));
      try {
        await _connectOnce();
        _setConnection(const Connection(LinkState.connected));
        _records.add({'type': 'reconnected', 'resync': _resyncNeeded});
        if (_resyncNeeded) _records.add({'type': 'resync', 'reason': 'gap'});
        _resyncNeeded = false;
        return;
      } catch (e) {
        reason = e is AgentError ? e.message : e.toString();
      }
    }
    if (_kicked) {
      _setConnection(Connection(LinkState.offline, kicked: true, reason: 'Another device took over the connection.'));
    } else if (!_wantConnected) {
      _setConnection(const Connection(LinkState.offline));
    }
  }

  void _onPlatformEvent(Map<String, dynamic> event) {
    switch (event['kind']) {
      case 'stdout':
        _onLine(event['line'] as String);
      case 'stderr':
        _stderr.add(event['line'] as String);
        if (_stderr.length > 200) _stderr.removeAt(0);
      case 'exit':
        final lost = isRemote;
        final error = AgentError(lost ? 'The connection to the server was lost.' : 'Agent exited with code ${event['code']}', code: lost ? 'connection_lost' : null);
        for (final c in _pending.values) {
          c.completeError(error);
        }
        _pending.clear();
        if (_ready?.isCompleted == false) _ready!.completeError(error);
        _records.add({'type': 'exit', 'code': event['code']});
        // A link that was up and went down is brought back; a failed attempt is handled by whoever made it.
        if (lost && _wantConnected && !_kicked && connection.value.connected && _loop == null) {
          _beginReconnecting(_whyFrom(_stderr.length > 3 ? _stderr.length - 3 : 0).trim());
        } else if (lost && _kicked) {
          _setConnection(Connection(LinkState.offline, kicked: true, reason: 'Another device took over the connection.'));
        }
      // A share, widget or tile opened the app; details come from takeLaunch().
      case 'launch':
        _records.add({'type': 'launch'});
    }
  }

  void _onLine(String line) {
    final Map<String, dynamic> record;
    try {
      record = jsonDecode(line) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (record['type']) {
      case 'response':
        final completer = _pending.remove(record['id']);
        if (completer == null) return;
        if (record['ok'] == true) {
          completer.complete(record['data']);
        } else {
          completer.completeError(
            AgentError(record['error'] as String? ?? 'Unknown error', code: record['code'] as String?),
          );
        }
      case 'hello_server':
        serverHello = record;
        _records.add(record);
      case 'ready':
        if (_ready?.isCompleted == false) _ready!.complete();
        _records.add(record);
      case 'fatal':
        final error = AgentError(record['message'] as String? ?? 'Agent failed');
        if (_ready?.isCompleted == false) _ready!.completeError(error);
        _records.add(record);
      // The server checks we are still there; the answer also says whether the app is in the background.
      case 'ping':
        backend.send(jsonEncode({'type': 'ping', 'background': inBackground})).catchError((Object _) {});
      case 'pong':
        break;
      case 'kicked':
        _kicked = true;
        _setConnection(Connection(LinkState.offline, kicked: true, reason: 'Another device took over the connection.'));
        _records.add(record);
      default:
        // A record we already have (the replay and the live stream can overlap in a race the server rules out, but a
        // belt costs nothing).
        final seq = record['seq'];
        if (seq is int && isRemote) {
          if (seq <= _lastSeq && _epoch != null) return;
          _lastSeq = seq;
        }
        _records.add(record);
    }
  }
}

class AgentError implements Exception {
  AgentError(this.message, {this.code});
  final String message;

  /// A stable, machine-readable reason when the host gave one: `ENOENT`, `EEXIST`, `outside_root`, `conflict`, ...
  final String? code;
  @override
  String toString() => message;
}
