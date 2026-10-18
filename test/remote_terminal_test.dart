import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:andropi/agent/remote_profile.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/sshd.dart';

/// The terminal tabs on a server: the real ssh command the app runs, against a real sshd and real tmux. The phone's pty
/// is played by `script`, which gives ssh a terminal the way the app's pty does.
void main() {
  String? skipReason() {
    final why = TestSshd.unavailable;
    if (why != null) return TestSshd.skip;
    for (final tool in ['tmux', 'script']) {
      if (Process.runSync('which', [tool]).exitCode != 0) {
        if (Platform.environment['CODERRA_REQUIRE_NODE_SIDE'] != null) throw StateError('$tool is not installed');
        return '$tool is not installed';
      }
    }
    return null;
  }

  final skip = skipReason();

  late TestSshd sshd;
  late Directory app;
  late Directory remote;
  late RemoteSetup setup;
  late RemoteProfile profile;
  final sessions = <String>[];
  final running = <_Term>[];

  String newSession() {
    final name = 'coderra-t-${Random().nextInt(1 << 30).toRadixString(36)}';
    sessions.add(name);
    return name;
  }

  setUp(() async {
    sshd = await TestSshd.start();
    app = Directory.systemTemp.createTempSync('cr-app-');
    remote = Directory.systemTemp.createTempSync('cr-remote-');
    setup = RemoteSetup(home: app.path, remoteDir: '${remote.path}/.coderra');
    profile = RemoteProfile(host: '127.0.0.1', port: sshd.port, user: sshd.user, hostKey: sshd.hostKey, active: true);
    sshd.authorize(await setup.ensureKey());
    setup.write(profile);
  });

  tearDown(() async {
    for (final t in running) {
      t.kill();
    }
    running.clear();
    for (final s in sessions) {
      Process.runSync('tmux', ['kill-session', '-t', s]);
    }
    sessions.clear();
    await sshd.dispose();
    for (final d in [app, remote]) {
      try {
        d.deleteSync(recursive: true);
      } catch (_) {}
    }
  });

  Future<_Term> open(List<String> argv) async {
    final t = await _Term.start(argv);
    running.add(t);
    return t;
  }

  bool exists(String session) => Process.runSync('tmux', ['has-session', '-t', session]).exitCode == 0;

  test('a tab runs a login shell in the project folder on the server', () async {
    final name = newSession();
    final work = Directory('${remote.path}/work')..createSync();
    final t = await open(setup.terminalArgv(cwd: work.path, session: name));
    t.send('echo MARK-\$((6*7))\n');
    await t.until('MARK-42');
    t.send('pwd\n');
    await t.until(work.path);
    expect(exists(name), isTrue, reason: 'the shell lives in a tmux session on the server');
  }, skip: skip);

  test('a lost connection leaves the shell running, and the next tab with the same name is that shell', () async {
    final name = newSession();
    final argv = setup.terminalArgv(cwd: remote.path, session: name);
    final first = await open(argv);
    first.send('KEPT=still-here; sleep 300 &\n');
    first.send('echo ready-\$((1+1))\n');
    await first.until('ready-2');

    first.kill(); // the phone loses the network, or the app is closed
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(exists(name), isTrue, reason: 'the server keeps the shell');

    final second = await open(argv);
    second.send('echo "\$KEPT"\n');
    await second.until('still-here');
    second.send('jobs\n');
    await second.until('sleep 300');
  }, skip: skip);

  test('closing a tab ends its session on the server for good', () async {
    final name = newSession();
    final t = await open(setup.terminalArgv(cwd: remote.path, session: name));
    t.send('echo up-\$((2+2))\n');
    await t.until('up-4');
    expect(exists(name), isTrue);
    t.kill();
    final r = await Process.run(setup.killTerminalArgv(name).first, setup.killTerminalArgv(name).skip(1).toList());
    expect(r.exitCode, 0);
    expect(exists(name), isFalse);
    // Ending one that is already gone is not an error.
    expect((await Process.run(setup.killTerminalArgv(name).first, setup.killTerminalArgv(name).skip(1).toList())).exitCode, 0);
  }, skip: skip);

  test('the Linux tab is the agent\'s container shell: the box program, not a plain shell', () async {
    final name = newSession();
    File('${remote.path}/.coderra/bin/box')
      ..createSync(recursive: true)
      ..writeAsStringSync('#!/bin/sh\necho "IN-THE-BOX-\$((20+1))"\nexec bash -l\n');
    Process.runSync('chmod', ['755', '${remote.path}/.coderra/bin/box']);
    final t = await open(setup.terminalArgv(cwd: remote.path, session: name, box: true));
    await t.until('IN-THE-BOX-21');
    t.send('echo still-a-shell-\$((3*3))\n');
    await t.until('still-a-shell-9');
  }, skip: skip);

  test('a project folder with spaces and quotes in its name is fine', () async {
    final name = newSession();
    final odd = Directory("${remote.path}/it's a project")..createSync();
    final t = await open(setup.terminalArgv(cwd: odd.path, session: name));
    t.send('pwd\n');
    await t.until("it's a project");
  }, skip: skip);

  test('names that could be commands are just names', () async {
    final pwned = '${remote.path}/pwned';
    final name = '${newSession()}\$(touch $pwned)`touch $pwned.2`';
    sessions.add(name);
    final t = await open(setup.terminalArgv(cwd: "${remote.path}\$(touch $pwned.3)", session: name));
    t.send('echo safe-\$((5+5))\n');
    await t.until('safe-10');
    for (final f in [pwned, '$pwned.2', '$pwned.3']) {
      expect(File(f).existsSync(), isFalse, reason: 'nothing in a name or folder is run by the server\'s shell');
    }
  }, skip: skip);
}

/// A program run on a terminal made by `script`, with a log of what it printed.
class _Term {
  _Term(this._p);

  final Process _p;
  final _out = StringBuffer();

  static Future<_Term> start(List<String> argv) async {
    String q(String a) => "'${a.replaceAll("'", r"'\''")}'";
    final p = await Process.start('script', ['-qefc', argv.map(q).join(' '), '/dev/null'], environment: {...Platform.environment, 'TERM': 'xterm-256color'});
    final t = _Term(p);
    p.stdout.transform(const Utf8Decoder(allowMalformed: true)).listen(t._out.write);
    p.stderr.drain<void>();
    p.stdin.done.catchError((_) {});
    return t;
  }

  void send(String text) => _p.stdin.write(text);

  Future<void> until(String text, {Duration timeout = const Duration(seconds: 20)}) async {
    final end = DateTime.now().add(timeout);
    while (!_out.toString().contains(text)) {
      if (DateTime.now().isAfter(end)) fail('timed out waiting for "$text"; the terminal showed:\n$_out');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
  }

  void kill() => _p.kill(ProcessSignal.sigkill);
}
