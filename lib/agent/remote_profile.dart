import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'agent_backend.dart';

/// What `server/bootstrap.sh` prints at the end, and what the user pastes into the app: where the server is, who to be
/// there, and the server's own host key, so the app trusts exactly that machine and nothing that merely answers first.
class SetupCode {
  const SetupCode({required this.host, required this.port, required this.user, required this.hostKey});

  final String host;
  final int port;
  final String user;

  /// `ssh-ed25519 AAAA...` (type and key, no comment).
  final String hostKey;

  static const prefix = 'coderra1:';

  static final _hostOk = RegExp(r'^[A-Za-z0-9][A-Za-z0-9.:_-]*$');
  static final _userOk = RegExp(r'^[a-z_][a-z0-9_-]{0,31}$');
  static final _keyOk = RegExp(r'^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}$');

  /// Reads a setup code. Accepts the code alone or the whole text the script printed (the code is the line that has it),
  /// and one that a terminal wrapped over several lines. Throws [FormatException] with something the user can act on.
  static SetupCode parse(String input) {
    final lines = input.split(RegExp(r'\r?\n')).map((l) => l.trim()).toList();
    final at = lines.indexWhere((l) => l.contains(prefix));
    if (at < 0) throw const FormatException('That is not a setup code. It starts with "coderra1:" and the server script prints it at the end.');
    var token = lines[at].substring(lines[at].indexOf(prefix));
    token = token.split(RegExp(r'\s+')).first;
    // A wrapped code continues on the next lines, which then contain nothing but base64.
    for (var i = at + 1; i < lines.length && RegExp(r'^[A-Za-z0-9+/=]+$').hasMatch(lines[i]); i++) {
      token += lines[i];
    }
    final Object? json;
    try {
      json = jsonDecode(utf8.decode(base64.decode(base64.normalize(token.substring(prefix.length)))));
    } catch (_) {
      throw const FormatException('The setup code is damaged. Copy the whole line again, from "coderra1:" to the end.');
    }
    if (json is! Map) throw const FormatException('The setup code is damaged.');
    if (json['v'] != 1) throw FormatException('This setup code is from a different version (${json['v']}). Update the app or the server script.');

    final host = json['host'];
    final port = json['port'];
    final user = json['user'];
    final key = json['hostKey'];
    if (host is! String || host.startsWith('(')) {
      throw const FormatException('The server script could not tell its address. Run it again with --address <name or IP of the server>.');
    }
    if (!_hostOk.hasMatch(host)) throw FormatException('The address in the setup code is not valid: "$host".');
    if (port is! int || port < 1 || port > 65535) throw FormatException('The port in the setup code is not valid: "$port".');
    if (user is! String || !_userOk.hasMatch(user)) throw FormatException('The user name in the setup code is not valid: "$user".');
    if (key is! String || key.startsWith('(')) {
      throw const FormatException('The setup code has no host key, so the app could not tell your server from an impostor. Install openssh-server on the server and run the script again.');
    }
    if (!_keyOk.hasMatch(key)) throw const FormatException('The host key in the setup code is not valid.');
    return SetupCode(host: host, port: port, user: user, hostKey: key);
  }
}

/// A server agent the user has set up.
class RemoteProfile {
  const RemoteProfile({required this.host, required this.port, required this.user, required this.hostKey, this.active = false});

  factory RemoteProfile.fromSetupCode(SetupCode c) => RemoteProfile(host: c.host, port: c.port, user: c.user, hostKey: c.hostKey);

  factory RemoteProfile.fromJson(Map<String, dynamic> j) => RemoteProfile(
    host: j['host'] as String,
    port: j['port'] as int,
    user: j['user'] as String,
    hostKey: j['hostKey'] as String,
    active: j['active'] == true,
  );

  final String host;
  final int port;
  final String user;
  final String hostKey;

  /// Whether the app uses the server agent (true) or the agent on this phone (false).
  final bool active;

  /// The name ssh knows this server by.
  static const alias = 'coderra-vps';

  RemoteProfile copyWith({bool? active}) => RemoteProfile(host: host, port: port, user: user, hostKey: hostKey, active: active ?? this.active);

  Map<String, dynamic> toJson() => {'host': host, 'port': port, 'user': user, 'hostKey': hostKey, 'active': active};

  String get address => port == 22 ? host : '$host:$port';
}

/// Where a server's problems show up when it is tested.
enum ServerProblem { none, unreachable, hostKeyChanged, authRejected, notInstalled, hostMissing, daemonDown, other }

class ServerCheck {
  const ServerCheck(this.problem, this.message, {this.detail});

  final ServerProblem problem;

  /// What to tell the user, and what to do about it.
  final String message;

  /// Raw output, for the curious.
  final String? detail;

  bool get ok => problem == ServerProblem.none;
}

class InstallResult {
  const InstallResult({required this.ok, required this.message, this.filesSent = 0});

  final bool ok;
  final String message;
  final int filesSent;
}

/// Everything on this phone that makes ssh work for the server agent: a key of its own, the server's pinned host key,
/// and an ssh config that insists on both. Nothing here touches `~/.ssh/config` (the agent on this phone writes that),
/// so the two cannot disturb each other.
class RemoteSetup {
  RemoteSetup({
    required this.home,
    this.ssh = 'ssh',
    this.sshKeygen = 'ssh-keygen',
    this.rsync = 'rsync',
    this.remoteDir = '.coderra',
    this.restartCommand = 'XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user restart coderra-hostd',
  });

  /// The app's home (it has `.ssh` in it).
  final String home;
  final String ssh;
  final String sshKeygen;
  final String rsync;

  /// The folder on the server where the host lives, relative to the user's home.
  final String remoteDir;

  /// Run on the server after the host is copied over, to start it with the new files.
  final String restartCommand;

  String get sshDir => '$home/.ssh';
  String get keyPath => '$sshDir/coderra_vps';
  String get knownHostsPath => '$sshDir/coderra_known_hosts';
  String get configPath => '$sshDir/coderra_config';

  // -------------------------------------------------------------------------
  // The key

  /// The app's key for the server, made on first use. Returns the public key, one line, to hand to the server script.
  Future<String> ensureKey() async {
    Directory(sshDir).createSync(recursive: true);
    final pub = File('$keyPath.pub');
    if (!File(keyPath).existsSync()) {
      if (pub.existsSync()) pub.deleteSync(); // a public key without its private half is no use
      final r = await Process.run(sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'coderra-app', '-f', keyPath]);
      if (r.exitCode != 0) throw StateError('Could not make an ssh key: ${r.stderr}'.trim());
    }
    if (!pub.existsSync()) {
      final r = await Process.run(sshKeygen, ['-y', '-f', keyPath]);
      if (r.exitCode != 0) throw StateError('Could not read the ssh key: ${r.stderr}'.trim());
      pub.writeAsStringSync('${(r.stdout as String).trim()} coderra-app\n');
    }
    return pub.readAsStringSync().trim();
  }

  /// Throws the key away. A new one has to be authorised on the server again.
  void forgetKey() {
    for (final f in [keyPath, '$keyPath.pub']) {
      if (File(f).existsSync()) File(f).deleteSync();
    }
  }

  /// The command to run on the server, as root, to let this app in and set the server up.
  String bootstrapCommand(String publicKey, {String? address}) {
    String q(String s) => "'${s.replaceAll("'", r"'\''")}'";
    return 'sudo ./bootstrap.sh --pubkey ${q(publicKey)}${address == null || address.isEmpty ? '' : ' --address ${q(address)}'}';
  }

  // -------------------------------------------------------------------------
  // ssh's side

  String _q(String s) => '"${s.replaceAll(r'\', r'\\').replaceAll('"', r'\"')}"';

  String configText(RemoteProfile p) {
    final type = p.hostKey.split(' ').first;
    final algorithms = type == 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256' : type;
    return [
      '# Written by CoderRa for the server agent. Changes are overwritten.',
      'Host ${RemoteProfile.alias}',
      '  HostName ${p.host}',
      '  Port ${p.port}',
      '  User ${p.user}',
      '  IdentityFile ${_q(keyPath)}',
      '  IdentitiesOnly yes',
      '  IdentityAgent none',
      '  UserKnownHostsFile ${_q(knownHostsPath)}',
      '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking yes',
      '  HostKeyAlgorithms $algorithms',
      '  BatchMode yes',
      '  PasswordAuthentication no',
      '  KbdInteractiveAuthentication no',
      '  ForwardAgent no',
      '  ForwardX11 no',
      '  ConnectTimeout 15',
      '  ServerAliveInterval 15',
      '  ServerAliveCountMax 3',
      '  LogLevel ERROR',
      '',
    ].join('\n');
  }

  /// The one line that says which key this server has.
  String knownHostsLine(RemoteProfile p) => '${p.port == 22 ? p.host : '[${p.host}]:${p.port}'} ${p.hostKey}\n';

  /// Writes the ssh config and the pinned host key.
  void write(RemoteProfile p) {
    Directory(sshDir).createSync(recursive: true);
    File(configPath).writeAsStringSync(configText(p));
    File(knownHostsPath).writeAsStringSync(knownHostsLine(p));
  }

  void remove() {
    for (final f in [configPath, knownHostsPath]) {
      if (File(f).existsSync()) File(f).deleteSync();
    }
  }

  /// The ssh arguments every use of the server starts with.
  List<String> get _base => ['-F', configPath];

  /// What the app runs to reach the agent: ssh to the server and join its stdin and stdout to the daemon's socket.
  LaunchSpec launch(RemoteProfile p, {Map<String, String> env = const {}}) =>
      LaunchSpec([ssh, ..._base, '-T', RemoteProfile.alias, '$remoteDir/bin/coderra-attach'], env: env);

  /// `ssh -N -L`: makes [remotePort] on the server's loopback available as [localPort] on this phone's. The server only
  /// lets the app's key forward to its own loopback (`permitopen`), and the phone's side is bound to loopback too.
  List<String> forwardArgv(int localPort, int remotePort) => [
    ssh,
    ..._base,
    '-N',
    '-T',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    '127.0.0.1:$localPort:127.0.0.1:$remotePort',
    RemoteProfile.alias,
  ];

  static String _sh(String s) => "'${s.replaceAll("'", r"'\''")}'";

  /// A terminal on the server: ssh with a terminal, running (or re-joining) a tmux session called [session], so that a
  /// lost connection or a closed app leaves the shell running and the next tab with the same name picks it up. With
  /// [box] the shell is the agent's own container (what the agent's commands run in), otherwise a login shell.
  List<String> terminalArgv({required String cwd, required String session, bool box = false}) {
    final home = remoteDir.startsWith('/') ? remoteDir : '\$HOME/$remoteDir';
    final inner = box ? '"$home/bin/box"' : 'bash -l';
    final command = 'tmux new-session -A -s ${_sh(session)} -c ${_sh(cwd)} ${_sh(inner)}';
    return [ssh, ..._base, '-tt', RemoteProfile.alias, command];
  }

  /// Ends a terminal session on the server for good (closing a tab does this; a dropped connection does not).
  List<String> killTerminalArgv(String session) =>
      [ssh, ..._base, '-T', RemoteProfile.alias, 'tmux kill-session -t ${_sh(session)} 2>/dev/null || true'];

  // -------------------------------------------------------------------------
  // Checking the server

  /// Connects and looks: can we get in, is the host installed, is it running. The answer says what to do next.
  Future<ServerCheck> check(RemoteProfile p, {Map<String, String>? env, Duration timeout = const Duration(seconds: 30)}) async {
    final script =
        'if [ ! -x $remoteDir/bin/coderra-attach ]; then echo CODERRA:attach-missing; '
        'elif [ ! -f $remoteDir/host/host.mjs ]; then echo CODERRA:host-missing; '
        'elif [ ! -S $remoteDir/host.sock ]; then echo CODERRA:daemon-down; '
        'else echo CODERRA:ok; fi';
    final r = await _run([ssh, ..._base, '-T', RemoteProfile.alias, script], env: env, timeout: timeout);
    return classify(p, r.exitCode, r.stdout, r.stderr);
  }

  /// Turns the outcome of the check command into something to show. Public so the wording can be tested.
  ServerCheck classify(RemoteProfile p, int exitCode, String stdout, String stderr) {
    final err = stderr.trim();
    if (exitCode == 0) {
      final state = RegExp(r'CODERRA:([a-z-]+)').firstMatch(stdout)?.group(1);
      switch (state) {
        case 'ok':
          return const ServerCheck(ServerProblem.none, 'Connected. The agent is running on the server.');
        case 'daemon-down':
          return const ServerCheck(
            ServerProblem.daemonDown,
            'Connected, but the agent is not running on the server. Start it with: systemctl --user start coderra-hostd (as the coderra user), or press Install / update.',
          );
        case 'host-missing':
          return const ServerCheck(ServerProblem.hostMissing, 'Connected. The agent is not installed on the server yet: press Install / update.');
        case 'attach-missing':
          return const ServerCheck(
            ServerProblem.notInstalled,
            'Connected, but the server is not set up (no coderra-attach). Run the server script on it first; the app shows the command.',
          );
      }
      return ServerCheck(ServerProblem.other, 'Connected, but the server answered something unexpected.', detail: stdout.trim());
    }
    if (RegExp(r'REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|host key for .* has changed', caseSensitive: false).hasMatch(err)) {
      return ServerCheck(
        ServerProblem.hostKeyChanged,
        'The server at ${p.address} does not have the host key from the setup code. Either the server was reinstalled, or something else is answering at that address. Do not continue unless you reinstalled it; then paste a fresh setup code.',
        detail: err,
      );
    }
    if (RegExp('Permission denied').hasMatch(err)) {
      return ServerCheck(
        ServerProblem.authRejected,
        'The server did not accept this app\'s key. Run the server script with this app\'s public key (the app shows the command).',
        detail: err,
      );
    }
    if (RegExp(r'Connection refused|timed out|No route to host|Could not resolve|Network is unreachable|Connection closed|Connection reset', caseSensitive: false).hasMatch(err)) {
      return ServerCheck(
        ServerProblem.unreachable,
        'Could not reach ${p.address}. Check the address, the phone\'s connection, and that the server allows ssh on that port.',
        detail: err,
      );
    }
    return ServerCheck(ServerProblem.other, err.isEmpty ? 'Connecting failed (exit code $exitCode).' : err.split('\n').last, detail: err);
  }

  // -------------------------------------------------------------------------
  // Putting the host on the server

  /// The `.stamp` of the host on the server, or null if there is none.
  Future<String?> remoteStamp({Map<String, String>? env}) async {
    final r = await _run([ssh, ..._base, '-T', RemoteProfile.alias, 'cat $remoteDir/host/.stamp 2>/dev/null || true'], env: env, timeout: const Duration(seconds: 30));
    final text = r.stdout.trim();
    return r.exitCode == 0 && text.isNotEmpty ? text : null;
  }

  /// Copies the host ([hostDir]: `host.mjs`, `node_modules`, `skills`, `.stamp`) to the server and restarts the daemon
  /// there so it runs the new files. A running chat is not cut off: the restart waits for it to be idle on the server
  /// side only if the host is already running (then `host_restart` is the better door; this is the first-install path).
  Future<InstallResult> install(String hostDir, {Map<String, String>? env, void Function(String line)? onProgress}) async {
    if (!File('$hostDir/host.mjs').existsSync()) return InstallResult(ok: false, message: 'There is no agent bundle to copy ($hostDir/host.mjs is missing).');
    final target = '${RemoteProfile.alias}:$remoteDir/host/';
    var r = await _run([ssh, ..._base, '-T', RemoteProfile.alias, 'mkdir -p $remoteDir/host'], env: env, timeout: const Duration(seconds: 30));
    if (r.exitCode != 0) return InstallResult(ok: false, message: 'Could not prepare the server: ${r.stderr.trim()}');
    onProgress?.call('Copying the agent...');
    r = await _run(
      [rsync, '-rltpz', '--delete', '--itemize-changes', '-e', '$ssh -F $configPath', '$hostDir/', target],
      env: env,
      timeout: const Duration(minutes: 10),
    );
    if (r.exitCode != 0) return InstallResult(ok: false, message: 'Copying failed: ${(r.stderr.trim().isEmpty ? r.stdout : r.stderr).trim().split('\n').last}');
    final sent = r.stdout.split('\n').where((l) => RegExp(r'^[<>c]f').hasMatch(l)).length;
    onProgress?.call('Starting it...');
    r = await _run([ssh, ..._base, '-T', RemoteProfile.alias, restartCommand], env: env, timeout: const Duration(seconds: 60));
    if (r.exitCode != 0) {
      return InstallResult(ok: false, filesSent: sent, message: 'Copied $sent files, but starting the agent failed: ${r.stderr.trim().split('\n').last}');
    }
    return InstallResult(ok: true, filesSent: sent, message: sent == 0 ? 'Already up to date. Restarted the agent.' : 'Installed ($sent files). The agent was restarted.');
  }

  Future<({int exitCode, String stdout, String stderr})> _run(List<String> argv, {Map<String, String>? env, required Duration timeout}) async {
    try {
      final r = await Process.run(argv.first, argv.skip(1).toList(), environment: env).timeout(timeout);
      return (exitCode: r.exitCode, stdout: '${r.stdout}', stderr: '${r.stderr}');
    } on TimeoutException {
      return (exitCode: 255, stdout: '', stderr: 'Timed out after ${timeout.inSeconds} s.');
    } on ProcessException catch (e) {
      return (exitCode: 127, stdout: '', stderr: 'Could not run ${argv.first}: ${e.message}');
    }
  }
}

/// The profile on disk, so the app knows at start-up whether to use the server.
class RemoteProfileStore {
  RemoteProfileStore(this.file);

  final File file;

  RemoteProfile? load() {
    try {
      return RemoteProfile.fromJson((jsonDecode(file.readAsStringSync()) as Map).cast<String, dynamic>());
    } catch (_) {
      return null;
    }
  }

  void save(RemoteProfile p) {
    file.parent.createSync(recursive: true);
    // Write beside and rename, so a crash never leaves half a file.
    final tmp = File('${file.path}.tmp')..writeAsStringSync(jsonEncode(p.toJson()));
    tmp.renameSync(file.path);
  }

  void clear() {
    if (file.existsSync()) file.deleteSync();
  }
}
