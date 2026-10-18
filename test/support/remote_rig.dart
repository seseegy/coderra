import 'dart:convert';
import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/remote_profile.dart';

import 'daemon.dart';
import 'sshd.dart';

/// A whole server agent on this machine, reached the way the phone reaches one: a private sshd (with the app's key let in
/// under the restrictions the server script uses), a host daemon behind the real attach program, and an app-side
/// [AgentController] configured for it and connected through ssh. Nothing touches the real home directory.
class RemoteRig {
  RemoteRig._(this.sshd, this.app, this.server, this.setup, this.profile, this.daemon, this.agent);

  static String? get skip => TestSshd.unavailable != null ? TestSshd.skip : TestDaemon.skip;

  final TestSshd sshd;
  final Directory app;
  final Directory server;
  final RemoteSetup setup;
  final RemoteProfile profile;
  final TestDaemon daemon;
  final AgentController agent;
  final servers = <HttpServer>[];

  String get remoteDir => '${server.path}/.coderra';
  String get workspace => daemon.workspace;

  static Future<RemoteRig> start() async {
    final sshd = await TestSshd.start();
    final app = Directory.systemTemp.createTempSync('cr-app-');
    final server = Directory.systemTemp.createTempSync('cr-server-');
    final remoteDir = '${server.path}/.coderra';
    final setup = RemoteSetup(home: app.path, remoteDir: remoteDir);
    final profile = RemoteProfile(host: '127.0.0.1', port: sshd.port, user: sshd.user, hostKey: sshd.hostKey, active: true);
    sshd.authorize(await setup.ensureKey());
    setup.write(profile);

    final daemon = await TestDaemon.start(socket: '$remoteDir/host.sock');
    final node = (Process.runSync('which', [TestDaemon.node]).stdout as String).trim();
    File('$remoteDir/bin/coderra-attach')
      ..createSync(recursive: true)
      ..writeAsStringSync("#!/bin/sh\nexec env CODERRA_SOCK='$remoteDir/host.sock' '$node' '${Directory.current.path}/server/coderra-attach'\n");
    Process.runSync('chmod', ['755', '$remoteDir/bin/coderra-attach']);

    final store = RemoteProfileStore(File('${app.path}/.coderra/remote.json'))..save(profile);
    final agent = AgentController(AgentClient(backend: ProcessBackend()));
    agent.remote.env = Platform.environment;
    agent.remote.configure(setup: setup, store: store);
    await agent.client.start();
    return RemoteRig._(sshd, app, server, setup, profile, daemon, agent);
  }

  /// A small web server on this machine's loopback, standing in for a dev server the agent started on the server.
  Future<int> devServer(String body, {String address = '127.0.0.1'}) async {
    final s = await HttpServer.bind(address, 0);
    servers.add(s);
    s.listen((req) {
      req.response
        ..write(body)
        ..close();
    });
    return s.port;
  }

  /// GET [url] and return the status and body. (A test binding answers every HttpClient request with 400, so the tests
  /// that use this set `HttpOverrides.global = null`.)
  static Future<(int, String)> fetch(String url) async {
    final c = HttpClient()
      ..findProxy = ((_) => 'DIRECT') // never through a proxy set in the environment: these are loopback ports
      ..connectionTimeout = const Duration(seconds: 5);
    try {
      final res = await (await c.getUrl(Uri.parse(url))).close().timeout(const Duration(seconds: 10));
      return (res.statusCode, await utf8.decodeStream(res));
    } finally {
      c.close(force: true);
    }
  }

  Future<void> dispose() async {
    await agent.remote.forwards?.closeAll();
    await agent.client.stop();
    for (final s in servers) {
      await s.close(force: true);
    }
    await daemon.dispose();
    await sshd.dispose();
    for (final d in [app, server]) {
      try {
        d.deleteSync(recursive: true);
      } catch (_) {}
    }
  }
}
