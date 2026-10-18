import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'agent_controller.dart';
import 'agent_fs.dart';
import 'port_forward.dart';
import 'remote_fs.dart';
import 'remote_profile.dart';

/// Which agent the app uses: the one on this phone, or the one on the user's server. Owns the saved server, the key, the
/// ssh files, and switching between the two.
class RemoteMode extends ChangeNotifier {
  RemoteMode(this.agent);

  final AgentController agent;

  RemoteSetup? setup;
  RemoteProfileStore? store;
  RemoteProfile? profile;
  Map<String, String> env = const {};

  /// The server's agent bundle on this phone, copied to the server by [install].
  String? hostDir;

  /// The phone's own folder for files fetched from the server.
  Directory? phoneCache;

  PortForwards? _forwards;

  /// The ports of the server that are reachable from this phone while the link is up.
  PortForwards? get forwards {
    final s = setup;
    if (s == null || !active) return null;
    return _forwards ??= PortForwards(setup: s, env: env);
  }

  /// Where a dev server on the server's [port] can be opened on this phone, or null if there is no server agent in use.
  Future<String?> devServerUrl(int port) async {
    final f = forwards;
    if (f == null) return null;
    return 'http://127.0.0.1:${await f.open(port)}/';
  }

  /// A URL the phone can open for the web page [path] on the server (and the files next to it): the host serves the
  /// project folder, and the app reaches that through a forward. [root] is the folder to serve; it must contain [path].
  Future<String?> previewUrl(String path, {String? root}) async {
    final f = forwards;
    if (f == null) return null;
    final base = (root != null && path.startsWith(root.endsWith('/') ? root : '$root/')) ? root : parentPath(path);
    final served = (await agent.client.call<Map>('preview_serve', {'dir': base})).cast<String, dynamic>();
    final local = await f.open(served['port'] as int);
    final rel = path.substring(base.length).split('/').where((p) => p.isNotEmpty).map(Uri.encodeComponent).join('/');
    return 'http://127.0.0.1:$local/${served['token']}/$rel';
  }

  /// Whether the app is set to use the server.
  bool get active => profile?.active == true;

  /// Whether a server has been set up (used or not).
  bool get configured => profile != null;

  /// Reads the saved server and tells the client how to reach it. Call before the first boot.
  Future<void> load() async {
    try {
      env = await agent.client.environment();
    } catch (_) {
      return; // no platform (desktop run, tests): the phone's agent
    }
    final home = env['HOME'];
    if (home == null) return;
    final bin = '${env['PI_CODING_AGENT_DIR']}/bin';
    configure(
      setup: RemoteSetup(home: home, ssh: '$bin/ssh', sshKeygen: '$bin/ssh-keygen', rsync: '$bin/rsync'),
      store: RemoteProfileStore(File('$home/.coderra/remote.json')),
      hostDir: '${env['ANDROPI_FILES']}/agent',
      phoneCache: Directory('$home/.cache/coderra-remote'),
    );
  }

  /// Sets the pieces up by hand (the tests do this). Applies the saved choice.
  void configure({required RemoteSetup setup, required RemoteProfileStore store, String? hostDir, Directory? phoneCache}) {
    this.setup = setup;
    this.store = store;
    this.hostDir = hostDir;
    this.phoneCache = phoneCache ?? Directory('${setup.home}/.cache/coderra-remote');
    profile = store.load();
    _apply();
    notifyListeners();
  }

  /// The app's public key for the server, made on first use.
  Future<String> publicKey() => setup!.ensureKey(env: env.isEmpty ? null : env);

  /// The command the user runs on their server.
  Future<String> bootstrapCommand({String? address}) async => setup!.bootstrapCommand(await publicKey(), address: address);

  /// Reads a pasted setup code and keeps the server (not yet in use). Throws [FormatException] with the reason.
  RemoteProfile saveCode(String text) {
    final saved = RemoteProfile.fromSetupCode(SetupCode.parse(text)).copyWith(active: active);
    setup!.write(saved);
    store!.save(saved);
    profile = saved;
    _apply();
    notifyListeners();
    return saved;
  }

  Future<ServerCheck> test() => setup!.check(profile!, env: env.isEmpty ? null : env);

  Future<InstallResult> install({void Function(String line)? onProgress}) {
    final dir = hostDir;
    if (dir == null) return Future.value(const InstallResult(ok: false, message: 'This app does not have an agent bundle to copy.'));
    return setup!.install(dir, env: env.isEmpty ? null : env, onProgress: onProgress);
  }

  /// Uses the server (true) or this phone (false) from now on, and restarts the connection to match.
  Future<void> use(bool server) async {
    if (profile == null) return;
    if (server == active) return;
    profile = profile!.copyWith(active: server);
    store!.save(profile!);
    _apply();
    notifyListeners();
    await agent.restart();
  }

  /// Forgets the server: stops using it, deletes the ssh files and the key.
  Future<void> forget() async {
    final wasActive = active;
    profile = null;
    store!.clear();
    setup!
      ..remove()
      ..forgetKey();
    _apply();
    notifyListeners();
    if (wasActive) await agent.restart();
  }

  void _apply() {
    // Forwards belong to the server they were opened for.
    final old = _forwards;
    _forwards = null;
    if (old != null) unawaited(old.closeAll());
    final p = profile;
    final s = setup;
    final client = agent.client;
    if (p != null && p.active && s != null) {
      client.remote = s.launch(p, env: env);
      agent.fs = RemoteFs(client.call, phoneCache: phoneCache!, waitOnline: client.whenConnected);
    } else {
      client.remote = null;
      agent.fs = const LocalFs();
    }
  }
}
