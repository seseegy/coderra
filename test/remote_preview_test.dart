import 'dart:io';

import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/remote_profile.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/daemon.dart';
import 'support/remote_rig.dart';

/// Web pages and dev servers on a server, reached from the phone: a real sshd, a real host daemon, real ssh port forwards
/// (restricted the way the server script restricts the app's key). The only thing missing is the phone's WebView, so a
/// page is "opened" by fetching its URL.
void main() {
  final skip = RemoteRig.skip;
  TestWidgetsFlutterBinding.ensureInitialized();
  // The test binding answers every HTTP request with 400; these tests talk to real loopback servers.
  HttpOverrides.global = null;

  late RemoteRig rig;
  late AgentController agent;
  late RemoteSetup setup;
  late TestDaemon daemon;
  late Directory app;

  Future<(int, String)> fetch(String url) => RemoteRig.fetch(url);
  Future<int> devServer(String body, {String address = '127.0.0.1'}) => rig.devServer(body, address: address);

  setUp(() async {
    rig = await RemoteRig.start();
    agent = rig.agent;
    setup = rig.setup;
    daemon = rig.daemon;
    app = rig.app;
  });

  tearDown(() => rig.dispose());

  group('port forwards', skip: skip, () {
    test('make a port of the server reachable on the phone, once per port, on the loopback only', () async {
      final port = await devServer('hello from the server');
      final f = agent.remote.forwards!;
      final local = await f.open(port);
      expect(local, isNot(port));
      expect(await fetch('http://127.0.0.1:$local/'), (200, 'hello from the server'));
      expect(await f.open(port), local, reason: 'asking again reuses it');
      expect(await f.openPorts, [port]);

      final other = await devServer('another');
      final local2 = await f.open(other);
      expect(local2, isNot(local));
      expect(await fetch('http://127.0.0.1:$local2/'), (200, 'another'));
      expect((await f.openPorts)..sort(), [port, other]..sort());
    });

    test('asked for at the same moment they are still one', () async {
      final port = await devServer('x');
      final f = agent.remote.forwards!;
      final locals = await Future.wait([f.open(port), f.open(port), f.open(port)]);
      expect(locals.toSet(), hasLength(1));
    });

    test('closing one ends it, closing all ends all', () async {
      final a = await devServer('a');
      final b = await devServer('b');
      final f = agent.remote.forwards!;
      final la = await f.open(a);
      final lb = await f.open(b);
      await f.close(a);
      await expectLater(fetch('http://127.0.0.1:$la/'), throwsA(anything));
      expect((await fetch('http://127.0.0.1:$lb/')).$1, 200);
      await f.closeAll();
      await expectLater(fetch('http://127.0.0.1:$lb/'), throwsA(anything));
      expect(await f.openPorts, isEmpty);
    });

    test('one that died on its own (the connection broke) is made again when asked for', () async {
      final port = await devServer('again');
      final f = agent.remote.forwards!;
      final first = await f.open(port);
      Process.runSync('pkill', ['-f', '127.0.0.1:$first:127.0.0.1:$port']);
      for (var i = 0; i < 100 && (await f.openPorts).isNotEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      expect(await f.openPorts, isEmpty, reason: 'the dead one is not reported as open');
      final second = await f.open(port);
      expect(await fetch('http://127.0.0.1:$second/'), (200, 'again'));
    });

    test('a port nothing listens on on the server gives a closed connection, not a hang', () async {
      final f = agent.remote.forwards!;
      final dead = (await ServerSocket.bind('127.0.0.1', 0));
      final port = dead.port;
      await dead.close();
      final local = await f.open(port);
      await expectLater(fetch('http://127.0.0.1:$local/'), throwsA(anything));
    });

    test('the server\'s rules apply: the app\'s key may only forward to the server\'s own 127.0.0.1', () async {
      final elsewhere = await devServer('not for you', address: '127.0.0.2');
      final local = await ServerSocket.bind('127.0.0.1', 0).then((s) async {
        final p = s.port;
        await s.close();
        return p;
      });
      final argv = setup.forwardArgv(local, elsewhere);
      final towardsOtherAddress = [for (final a in argv.skip(1)) a.replaceFirst('127.0.0.1:$local:127.0.0.1:$elsewhere', '127.0.0.1:$local:127.0.0.2:$elsewhere')];
      final p = await Process.start(argv.first, towardsOtherAddress);
      addTearDown(p.kill);
      var up = false;
      for (var i = 0; i < 100 && !up; i++) {
        try {
          (await Socket.connect('127.0.0.1', local)).destroy();
          up = true;
        } on SocketException {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
      }
      expect(up, isTrue, reason: 'ssh itself started the forward');
      await expectLater(fetch('http://127.0.0.1:$local/'), throwsA(anything), reason: 'but the server refuses to connect it to 127.0.0.2');
    });

    test('the forwards of a server are dropped when its setup is applied again', () async {
      final port = await devServer('x');
      final local = await agent.remote.forwards!.open(port);
      agent.remote.configure(setup: setup, store: RemoteProfileStore(File('${app.path}/.coderra/remote.json')));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      await expectLater(fetch('http://127.0.0.1:$local/'), throwsA(anything));
    });
  });

  group('previews', skip: skip, () {
    String ws() => daemon.workspace;

    void site() {
      Directory('${ws()}/site/docs').createSync(recursive: true);
      File('${ws()}/site/index.html').writeAsStringSync('<link rel="stylesheet" href="style.css"><h1>site</h1>');
      File('${ws()}/site/style.css').writeAsStringSync('h1{color:red}');
      File('${ws()}/site/docs/a.html').writeAsStringSync('<link rel="stylesheet" href="../style.css"><p>doc</p>');
      File('${ws()}/secret.txt').writeAsStringSync('not part of the site');
    }

    test('a page on the server opens on the phone, and so do the files it links to', () async {
      site();
      final url = (await agent.remote.previewUrl('${ws()}/site/index.html'))!;
      expect(url, matches(RegExp(r'^http://127\.0\.0\.1:\d+/[0-9a-f]{24}/index\.html$')));
      expect(await fetch(url), (200, '<link rel="stylesheet" href="style.css"><h1>site</h1>'));
      expect(await fetch(Uri.parse(url).resolve('style.css').toString()), (200, 'h1{color:red}'), reason: 'a relative link works as on any web site');
    });

    test('with the project folder as root, a page in a subfolder finds a file one level up', () async {
      site();
      final url = (await agent.remote.previewUrl('${ws()}/site/docs/a.html', root: '${ws()}/site'))!;
      expect(url, endsWith('/docs/a.html'));
      expect(await fetch(url), (200, '<link rel="stylesheet" href="../style.css"><p>doc</p>'));
      expect((await fetch(Uri.parse(url).resolve('../style.css').toString())).$1, 200);
    });

    test('what is outside the folder, and the folder without the token, stay out of reach', () async {
      site();
      final url = Uri.parse((await agent.remote.previewUrl('${ws()}/site/index.html'))!);
      expect((await fetch(url.resolve('../secret.txt').toString())).$1, 404);
      expect((await fetch('http://127.0.0.1:${url.port}/index.html')).$1, 404);
      await expectLater(agent.remote.previewUrl('/etc/hostname'), throwsA(isA<AgentError>().having((e) => e.code, 'code', 'outside_root')));
    });

    test('an edit made on the server shows on reload (nothing is cached)', () async {
      site();
      final url = (await agent.remote.previewUrl('${ws()}/site/index.html'))!;
      File('${ws()}/site/index.html').writeAsStringSync('<h1>edited</h1>');
      expect(await fetch(url), (200, '<h1>edited</h1>'));
    });

    test('a dev server the agent started on the server opens on the phone', () async {
      final port = await devServer('<h1>dev server</h1>');
      final url = (await agent.remote.devServerUrl(port))!;
      expect(url, matches(RegExp(r'^http://127\.0\.0\.1:\d+/$')));
      expect(await fetch(url), (200, '<h1>dev server</h1>'));
    });
  });
}
