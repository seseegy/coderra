import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/remote_profile.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/daemon.dart';
import 'support/sshd.dart';

/// The whole path from the app to the daemon with a real sshd in between: the files RemoteSetup writes, the key it makes,
/// the checks it runs, the install it does with rsync, and a client talking through it. The "server" is a private sshd on
/// loopback running as the current user; its folders live in a temp directory, never in the real home.
void main() {
  final skip = TestSshd.unavailable != null ? TestSshd.skip : TestDaemon.skip;

  late TestSshd sshd;
  late Directory app; // the phone's home
  late Directory server; // the server's .coderra parent
  late RemoteSetup setup;
  late RemoteProfile profile;
  late String restartMarker;
  final cleanup = <Future<void> Function()>[];

  String remoteDir() => '${server.path}/.coderra';

  String absoluteNode() {
    final n = TestDaemon.node;
    return n.startsWith('/') ? n : (Process.runSync('which', [n]).stdout as String).trim();
  }

  void installAttachWrapper(String sock) {
    final f = File('${remoteDir()}/bin/coderra-attach')..createSync(recursive: true);
    f.writeAsStringSync("#!/bin/sh\nexec env CODERRA_SOCK='$sock' '${absoluteNode()}' '${Directory.current.path}/server/coderra-attach'\n");
    Process.runSync('chmod', ['755', f.path]);
  }

  setUp(() async {
    sshd = await TestSshd.start();
    app = Directory.systemTemp.createTempSync('cr-app-');
    server = Directory.systemTemp.createTempSync('cr-server-');
    restartMarker = '${server.path}/restarted';
    setup = RemoteSetup(home: app.path, remoteDir: remoteDir(), restartCommand: 'echo restarted >> $restartMarker');
    profile = RemoteProfile(host: '127.0.0.1', port: sshd.port, user: sshd.user, hostKey: sshd.hostKey);
    sshd.authorize(await setup.ensureKey());
    setup.write(profile);
  });

  tearDown(() async {
    for (final c in cleanup.reversed) {
      await c();
    }
    cleanup.clear();
    await sshd.dispose();
    for (final d in [app, server]) {
      try {
        d.deleteSync(recursive: true);
      } catch (_) {}
    }
  });

  Directory fakeHost(Map<String, String> files) {
    final d = Directory.systemTemp.createTempSync('cr-host-');
    cleanup.add(() async => d.deleteSync(recursive: true));
    files.forEach((name, content) {
      File('${d.path}/$name')
        ..createSync(recursive: true)
        ..writeAsStringSync(content);
    });
    return d;
  }

  test('a server that is not set up says so; after the script and the install it says the agent is not running; then it is running', () async {
    expect((await setup.check(profile)).problem, ServerProblem.notInstalled);

    installAttachWrapper('${remoteDir()}/host.sock'); // what bootstrap.sh does
    expect((await setup.check(profile)).problem, ServerProblem.hostMissing);

    final host = fakeHost({'host.mjs': '// host', '.stamp': 'build-1', 'node_modules/dep/index.js': 'module.exports = 1', 'skills/a.md': '# a'});
    final result = await setup.install(host.path);
    expect(result.ok, isTrue, reason: result.message);
    expect(result.filesSent, 4);
    expect(File(restartMarker).readAsStringSync(), 'restarted\n');
    expect(File('${remoteDir()}/host/node_modules/dep/index.js').readAsStringSync(), 'module.exports = 1');
    expect(await setup.remoteStamp(), 'build-1');
    expect((await setup.check(profile)).problem, ServerProblem.daemonDown);

    final daemon = await TestDaemon.start(socket: '${remoteDir()}/host.sock');
    cleanup.add(daemon.dispose);
    final ok = await setup.check(profile);
    expect(ok.ok, isTrue, reason: ok.message);
  }, skip: skip);

  test('installing again sends only what changed, and removes what is gone', () async {
    installAttachWrapper('${remoteDir()}/host.sock');
    final host = fakeHost({'host.mjs': '// v1', '.stamp': 'one', 'a.js': 'a', 'old.js': 'old'});
    expect((await setup.install(host.path)).filesSent, 4);

    File('${host.path}/old.js').deleteSync();
    // (rsync decides by size and whole-second time, so a change of size keeps the test honest within one second.)
    File('${host.path}/host.mjs').writeAsStringSync('// version two');
    File('${host.path}/.stamp').writeAsStringSync('two-two');
    final second = await setup.install(host.path);
    expect(second.ok, isTrue);
    expect(second.filesSent, 2, reason: 'host.mjs and .stamp only');
    expect(File('${remoteDir()}/host/old.js').existsSync(), isFalse);
    expect(await setup.remoteStamp(), 'two-two');

    final same = await setup.install(host.path);
    expect(same.filesSent, 0);
    expect(same.message, contains('up to date'));
  }, skip: skip);

  test('an install that cannot start the agent says what was done and what failed', () async {
    installAttachWrapper('${remoteDir()}/host.sock');
    final failing = RemoteSetup(home: app.path, remoteDir: remoteDir(), restartCommand: 'echo "no such unit" >&2; exit 5');
    final r = await failing.install(fakeHost({'host.mjs': 'x', '.stamp': '1'}).path);
    expect(r.ok, isFalse);
    expect(r.filesSent, 2);
    expect(r.message, allOf(contains('Copied 2 files'), contains('no such unit')));
    final missing = await setup.install('${app.path}/nowhere');
    expect(missing.ok, isFalse);
    expect(missing.message, contains('no agent bundle'));
  }, skip: skip);

  test('a server presenting a different host key is refused, and the key is not learned', () async {
    final other = Directory.systemTemp.createTempSync('cr-other-');
    cleanup.add(() async => other.deleteSync(recursive: true));
    Process.runSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', '${other.path}/k']);
    final wrongKey = File('${other.path}/k.pub').readAsStringSync().split(' ').take(2).join(' ');
    final impostor = RemoteProfile(host: '127.0.0.1', port: sshd.port, user: sshd.user, hostKey: wrongKey);
    setup.write(impostor);
    final c = await setup.check(impostor);
    expect(c.problem, ServerProblem.hostKeyChanged, reason: '${c.detail}');
    expect(File(setup.knownHostsPath).readAsStringSync(), contains(wrongKey), reason: 'nothing was added to the pinned keys');
    expect(File(setup.knownHostsPath).readAsLinesSync(), hasLength(1));
  }, skip: skip);

  test('a key the server does not know is rejected with the way out', () async {
    sshd.revokeAll();
    final c = await setup.check(profile);
    expect(c.problem, ServerProblem.authRejected, reason: '${c.detail}');
    expect(c.message, contains('public key'));
  }, skip: skip);

  test('an address nothing listens on is unreachable', () async {
    final closed = RemoteProfile(host: '127.0.0.1', port: 1, user: sshd.user, hostKey: sshd.hostKey);
    setup.write(closed);
    expect((await setup.check(closed)).problem, ServerProblem.unreachable);
  }, skip: skip);

  test('the client talks to a daemon through ssh, and rides out the connection being cut', () async {
    final daemon = await TestDaemon.start(socket: '${remoteDir()}/host.sock');
    cleanup.add(daemon.dispose);
    installAttachWrapper('${remoteDir()}/host.sock');

    final backend = ProcessBackend();
    final client = AgentClient(backend: backend)
      ..remote = setup.launch(profile, env: Platform.environment)
      ..backoff = ((_) => const Duration(milliseconds: 100))
      ..readyTimeout = const Duration(seconds: 20);
    cleanup.add(client.stop);
    await client.start();
    expect(client.serverHello?['mode'], 'vps');
    expect((await client.call<Map>('hello'))['workspace'], isNotNull);
    expect(backend.started.single.pid, isPositive);

    backend.current!.kill(); // ssh dies, as when the phone loses the network
    final deadline = DateTime.now().add(const Duration(seconds: 20));
    while (!(client.connection.value.connected && backend.started.length == 2)) {
      if (DateTime.now().isAfter(deadline)) fail('did not reconnect: ${client.connection.value.reason}');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    expect((await client.call<Map>('hello'))['workspace'], isNotNull);

    // And through ssh the restrictions hold: this key cannot open a shell-less escape such as a remote forward.
    final r = await Process.run('ssh', ['-F', setup.configPath, '-R', '127.0.0.1:2222:127.0.0.1:22', '-o', 'ExitOnForwardFailure=yes', '-T', 'coderra-vps', 'true']);
    expect(r.exitCode, isNot(0), reason: 'a remote forward must be refused by the key\'s restrictions');
  }, skip: skip);
}
