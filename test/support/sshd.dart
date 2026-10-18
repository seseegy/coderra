import 'dart:async';
import 'dart:io';

/// A private sshd on a loopback port, run as the current user with throwaway host keys, for tests of the real ssh chain.
/// A key is let in with exactly the restrictions `server/bootstrap.sh` gives the app's key (read from that file, so the
/// two cannot drift apart).
class TestSshd {
  TestSshd._(this.dir, this.port, this.user, this.hostKey, this._process);

  static String? get _sshdPath => ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].where((p) => File(p).existsSync()).firstOrNull;

  /// Why it cannot run here, or null.
  static String? get unavailable {
    if (_sshdPath == null) return 'sshd is not installed';
    for (final tool in ['ssh', 'ssh-keygen', 'rsync']) {
      try {
        Process.runSync(tool, ['--version']);
      } on ProcessException {
        return '$tool is not installed';
      }
    }
    if (!File('server/bootstrap.sh').existsSync()) return 'run the tests from the repository root';
    return null;
  }

  static String? get skip {
    final why = unavailable;
    if (why == null) return null;
    if (Platform.environment['CODERRA_REQUIRE_NODE_SIDE'] != null) throw StateError(why);
    return why;
  }

  final Directory dir;
  final int port;
  final String user;

  /// `ssh-ed25519 AAAA...`, as the setup code carries it.
  final String hostKey;
  final Process _process;

  static final keyOptions = RegExp(r"^KEY_OPTIONS='(.*)'$", multiLine: true).firstMatch(File('server/bootstrap.sh').readAsStringSync())!.group(1)!;

  static Future<TestSshd> start() async {
    final dir = Directory.systemTemp.createTempSync('cr-sshd-');
    Process.runSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', '${dir.path}/host_key']);
    final server = await ServerSocket.bind('127.0.0.1', 0);
    final port = server.port;
    await server.close();
    final user = Platform.environment['USER'] ?? Process.runSync('id', ['-un']).stdout.toString().trim();
    File('${dir.path}/authorized_keys').writeAsStringSync('');
    File('${dir.path}/sshd_config').writeAsStringSync(
      [
        'Port $port',
        'ListenAddress 127.0.0.1',
        'HostKey ${dir.path}/host_key',
        'PidFile ${dir.path}/sshd.pid',
        'AuthorizedKeysFile ${dir.path}/authorized_keys',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PubkeyAuthentication yes',
        'UsePAM no',
        'StrictModes no',
        'AllowUsers $user',
        'LogLevel ERROR',
      ].join('\n'),
    );
    final process = await Process.start(_sshdPath!, ['-D', '-e', '-f', '${dir.path}/sshd_config']);
    final log = StringBuffer();
    process.stderr.transform(const SystemEncoding().decoder).listen(log.write);
    process.stdout.drain<void>();
    for (var i = 0; i < 100; i++) {
      try {
        (await Socket.connect('127.0.0.1', port)).destroy();
        break;
      } on SocketException {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    }
    final hostKey = File('${dir.path}/host_key.pub').readAsStringSync().split(' ').take(2).join(' ');
    return TestSshd._(dir, port, user, hostKey, process);
  }

  /// Lets a key in, with the app's restrictions.
  void authorize(String publicKey) => File('${dir.path}/authorized_keys').writeAsStringSync('$keyOptions $publicKey\n', mode: FileMode.append);

  void revokeAll() => File('${dir.path}/authorized_keys').writeAsStringSync('');

  Future<void> dispose() async {
    _process.kill(ProcessSignal.sigkill);
    await _process.exitCode;
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {}
  }
}
