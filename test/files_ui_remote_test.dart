import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/agent/remote_fs.dart';
import 'package:andropi/ui/skills_screen.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/daemon.dart';
import 'support/files_ui_suite.dart';
import 'support/fs_screens_suite.dart';

/// The same file screens, with the agent on a server: every operation goes through [RemoteFs] to a real host daemon
/// (through the real attach program), which does it on its disk. The folders the tests build are inside that daemon's
/// workspace, so the tests can still look at the disk directly.
class RemoteVariant extends FsVariant {
  TestDaemon? daemon;

  @override
  bool get remote => true;
  var _n = 0;

  @override
  Future<void> setUpAll() async {
    daemon = await TestDaemon.start();
  }

  @override
  Future<void> tearDownAll() async {
    await _shared?.stop();
    _cache?.deleteSync(recursive: true);
    await daemon?.dispose();
  }

  @override
  Directory makeDir() => Directory('${daemon!.workspace}/t${_n++}')..createSync(recursive: true);

  AgentClient? _shared;
  Directory? _cache;

  /// One connection for the code that is not a screen; closed with the group.
  @override
  Future<AgentFs> makeFs() async {
    final client = _shared ??= AgentClient(backend: ProcessBackend())..remote = daemon!.launchSpec;
    if (client.serverHello == null) await client.start();
    return RemoteFs(client.call, phoneCache: _cache ??= Directory.systemTemp.createTempSync('remote_cache_'));
  }

  @override
  Future<AgentController> makeAgent(WidgetTester tester, Directory dir) async {
    // Android is not here: the few calls to the platform side get empty answers, and phone storage is "not available".
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(PlatformBackend.method, (call) async {
      // What a real phone would say: it has shared storage the user could allow. With a server agent that is not on offer.
      if (call.method == 'storageAccess') return {'available': true, 'granted': false, 'root': '/storage/emulated/0'};
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(PlatformBackend.method, null));

    final client = AgentClient(backend: ProcessBackend())..remote = daemon!.launchSpec;
    await tester.runAsync(client.start);
    addTearDown(() => tester.runAsync(client.stop));
    final cache = Directory.systemTemp.createTempSync('remote_cache_');
    addTearDown(() => cache.deleteSync(recursive: true));
    final agent = AgentController(client)..info = {'workspace': dir.path};
    // Every file operation must go to the server: count them, and fail the test if there were none.
    var calls = 0;
    Future<T> counted<T>(String type, [Map<String, dynamic> args = const {}]) {
      if (type.startsWith('fs_')) calls++;
      return client.call<T>(type, args);
    }

    addTearDown(() => expect(calls, greaterThan(0), reason: 'the screens did not use the server\'s files'));
    agent.fs = RemoteFs(counted, phoneCache: cache);
    return agent;
  }
}

void main() {
  final skip = TestDaemon.skip;
  if (skip != null) {
    test('file screens on a server agent', () {}, skip: skip);
    return;
  }
  final variant = RemoteVariant();
  fsScreensSuite(variant);

  // Things only a server agent has to get right.
  group('SkillsScreen on a server agent', () {
    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 12; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
        await tester.pump(const Duration(milliseconds: 50));
      }
      await tester.pump(const Duration(milliseconds: 500));
    }

    testWidgets('shows the text of a skill that lives in the server\'s agent folder', (tester) async {
      final skill = Directory('${variant.daemon!.home.path}/.pi/agent/skills/demo-skill')..createSync(recursive: true);
      File('${skill.path}/SKILL.md').writeAsStringSync('---\nname: demo-skill\ndescription: Does demo things\n---\n# Demo\nUse the demo flow.\n');
      final agent = await variant.makeAgent(tester, variant.makeDir());
      await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: SkillsScreen(agent: agent)));
      await settle(tester);
      expect(find.text('demo-skill'), findsOneWidget);

      await tester.tap(find.text('demo-skill'));
      await settle(tester);
      expect(find.textContaining('Use the demo flow.'), findsOneWidget, reason: 'read through the server\'s file access');
    });
  });
}
