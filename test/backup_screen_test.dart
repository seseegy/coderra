import 'dart:io';

import 'package:andropi/agent/agent_backend.dart';
import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/ui/backup_screen.dart';
import 'package:andropi/ui/kit.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';
import 'support/remote_rig.dart';

/// Backup and restore with the agent on a server: the backup is made there and brought to the phone, and a backup from the
/// phone is sent to the server before it is restored. Real host, real ssh, real files.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<MethodCall> platform;

  setUp(() {
    platform = [];
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(PlatformBackend.method, (call) async {
      platform.add(call);
      return call.method == 'saveToDownloads' ? '/storage/emulated/0/Download/CoderRa/saved.zip' : null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(PlatformBackend.method, null));
  });

  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  Future<void> until(WidgetTester tester, bool Function() ok, String what) async {
    for (var i = 0; i < 100; i++) {
      if (ok()) return;
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('timed out waiting for $what; on screen: ${tester.widgetList<Text>(find.byType(Text)).map((w) => w.data).join(' | ')}');
  }

  bool shown(String text) => find.textContaining(text).evaluate().isNotEmpty;

  Future<RemoteRig> rig(WidgetTester tester) async {
    final r = (await tester.runAsync(RemoteRig.start))!;
    addTearDown(() => tester.runAsync(r.dispose));
    r.agent.info = {'workspace': r.workspace};
    return r;
  }

  Future<void> open(WidgetTester tester, AgentController agent, {Future<String?> Function()? pick}) async {
    tall(tester);
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: BackupScreen(agent: agent, pickFile: pick)));
    await tester.pump();
  }

  /// A zip made on the phone, as a backup from another device would be.
  String phoneZip(Directory dir, Map<String, String> members) {
    final path = '${dir.path}/phone-backup.zip';
    final r = Process.runSync('python3', [
      '-c',
      'import sys, zipfile, json\nz = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)\nfor n, d in json.loads(sys.argv[2]).items():\n    z.writestr(zipfile.ZipInfo(n), d)\nz.close()',
      path,
      '{${members.entries.map((e) => '"${e.key}": "${e.value}"').join(',')}}',
    ]);
    expect(r.exitCode, 0, reason: '${r.stderr}');
    return path;
  }

  final skip = RemoteRig.skip;

  testWidgets('a backup made on the server comes to the phone, with progress, as a zip that opens', (tester) async {
    final r = await rig(tester);
    Directory('${r.workspace}/proj').createSync(recursive: true);
    File('${r.workspace}/proj/a.txt').writeAsStringSync('alpha' * 1000);
    await open(tester, r.agent);

    await tester.tap(find.byType(Switch));
    await until(tester, () => shown('files ·'), 'the size of what would be backed up');
    expect(find.textContaining('1 files · 5 KB').evaluate().isNotEmpty || find.textContaining(' files · ').evaluate().isNotEmpty, isTrue);

    await tester.tap(find.text('Create backup'));
    await until(tester, () => find.text('Download to this phone').evaluate().isNotEmpty, 'the backup');
    expect(shown('left out'), isFalse);

    await tester.tap(find.text('Download to this phone'));
    await until(tester, () => platform.any((c) => c.method == 'saveToDownloads'), 'the download to finish');
    await until(tester, () => !shown('Downloading the backup'), 'the progress dialog to go');

    final local = (platform.firstWhere((c) => c.method == 'saveToDownloads').arguments as Map)['path'] as String;
    expect(local, startsWith('${r.app.path}/.cache/'), reason: 'a file on the phone');
    final test = Process.runSync('unzip', ['-t', local]);
    expect(test.exitCode, 0, reason: '${test.stdout}');
    expect('${test.stdout}', contains('proj/a.txt'));
    expect(find.textContaining('Saved to /storage/emulated/0/Download/CoderRa/saved.zip'), findsOneWidget);
  }, skip: skip != null);

  testWidgets('a backup from the phone is sent to the server first, restored there, and the copy is cleaned up', (tester) async {
    final r = await rig(tester);
    final zip = phoneZip(r.app, {'workspace/proj/restored.txt': 'from the phone', 'agent/AGENTS.md': 'restored notes'});
    await open(tester, r.agent, pick: () async => zip);

    await tester.tap(find.text('Choose file'));
    await until(tester, () => tester.widget<TextField>(find.byType(TextField)).controller!.text.endsWith('/backups/.restore-phone-backup.zip'), 'the zip to reach the server');
    await tester.pump(const Duration(milliseconds: 500)); // the progress dialog finishes closing
    final onServer = tester.widget<TextField>(find.byType(TextField)).controller!.text;
    expect(File(onServer).existsSync(), isTrue);
    expect(onServer, startsWith(r.workspace));

    await tester.tap(find.widgetWithText(PrimaryButton, 'Restore'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.widgetWithText(TextButton, 'Restore'));
    await until(tester, () => shown('Restored 2 files'), 'the restore');
    expect(File('${r.workspace}/proj/restored.txt').readAsStringSync(), 'from the phone');
    await until(tester, () => !File(onServer).existsSync(), 'the uploaded copy to be removed');
  }, skip: skip != null);

  testWidgets('entries that cannot be restored are listed, not hidden', (tester) async {
    final r = await rig(tester);
    final zip = phoneZip(r.app, {'workspace/ok.txt': 'fine', '../escape.txt': 'no'});
    await open(tester, r.agent, pick: () async => zip);
    await tester.tap(find.text('Choose file'));
    await until(tester, () => tester.widget<TextField>(find.byType(TextField)).controller!.text.endsWith('/backups/.restore-phone-backup.zip'), 'the upload');
    await tester.pump(const Duration(milliseconds: 500)); // the progress dialog finishes closing
    await tester.tap(find.widgetWithText(PrimaryButton, 'Restore'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.widgetWithText(TextButton, 'Restore'));
    await until(tester, () => shown('could not be restored'), 'the report');
    expect(find.textContaining('../escape.txt: unsafe path'), findsOneWidget);
    expect(find.text('Restored 1 file'), findsOneWidget);
    expect(File('${r.workspace}/ok.txt').readAsStringSync(), 'fine');
    expect(File('${r.server.path}/escape.txt').existsSync() || File('${r.workspace}/../escape.txt').existsSync(), isFalse);
  }, skip: skip != null);

  testWidgets('on this phone there is no trip to make: no download button', (tester) async {
    final backend = FakeBackend()
      ..onCommand = (c) => switch (c['type']) {
        'backup_create' => {'path': '/phone/ws/backups/b.zip', 'files': 3, 'bytes': 2048, 'left': [], 'leftCount': 2},
        _ => null,
      };
    final agent = AgentController(AgentClient(backend: backend));
    backend.running = true;
    await open(tester, agent);
    await tester.tap(find.text('Create backup'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('3 files · 2 KB · 2 left out'), findsOneWidget);
    expect(find.text('Download to this phone'), findsNothing);
  });
}
