import 'dart:async';

import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:andropi/ui/theme.dart';
import 'package:andropi/ui/transfer_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late BuildContext context;

  Future<void> host(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(
          body: Builder(
            builder: (c) {
              context = c;
              return const SizedBox();
            },
          ),
        ),
      ),
    );
  }

  testWidgets('shows what is being sent and how far, and goes away with the result', (tester) async {
    await host(tester);
    final release = Completer<void>();
    late TransferHandle handle;
    final done = runTransfer<String>(
      context,
      title: 'Sending files',
      task: (h) async {
        handle = h;
        h.label = 'photo.pdf · 1 of 2';
        h.onProgress(2 * 1024 * 1024, 8 * 1024 * 1024);
        await release.future;
        return 'result';
      },
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Sending files'), findsOneWidget);
    expect(find.text('photo.pdf · 1 of 2'), findsOneWidget);
    expect(find.text('2.0 MB of 8.0 MB · 25%'), findsOneWidget);
    expect(tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).value, 0.25);

    handle.onProgress(8 * 1024 * 1024, 8 * 1024 * 1024);
    await tester.pump();
    expect(find.text('8.0 MB of 8.0 MB · 100%'), findsOneWidget);

    release.complete();
    expect(await done, 'result');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Sending files'), findsNothing);
  });

  testWidgets('Cancel stops the transfer: the task sees it, nothing is reported as an error, the result is null', (tester) async {
    await host(tester);
    final started = Completer<TransferHandle>();
    final done = runTransfer<String>(
      context,
      title: 'Uploading',
      task: (h) async {
        started.complete(h);
        while (true) {
          h.cancel.check();
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      },
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Starting…'), findsOneWidget, reason: 'no progress yet');
    expect(tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).value, isNull);
    await tester.tap(find.text('Cancel'));
    await tester.pump();
    expect((await started.future).cancel.cancelled, isTrue);
    await tester.pump(const Duration(milliseconds: 50));
    expect(await done, isNull);
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(SnackBar), findsNothing);
    expect(find.text('Uploading'), findsNothing);
  });

  testWidgets('a failure closes the dialog and says what happened; a lost connection says nothing was changed', (tester) async {
    await host(tester);
    expect(await runTransfer<String>(context, title: 'x', task: (h) async => throw AgentError('Disk full', code: 'ENOSPC')), isNull);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Disk full'), findsOneWidget);
    expect(find.text('x'), findsNothing);

    expect(await runTransfer<String>(context, title: 'y', task: (h) async => throw AgentError('lost', code: 'connection_lost')), isNull);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.textContaining('connection to the server was lost. Nothing was changed'), findsOneWidget);

    expect(await runTransfer<String>(context, title: 'z', task: (h) async => throw StateError('odd')), isNull);
    await tester.pump();
    expect(find.textContaining('odd'), findsOneWidget);
  });

  testWidgets('without a dialog (files on the phone) it just runs, and still reports errors the same way', (tester) async {
    await host(tester);
    expect(await runTransfer<int>(context, title: 'quiet', show: false, task: (h) async => 7), 7);
    expect(find.text('quiet'), findsNothing);
    expect(await runTransfer<int>(context, title: 'quiet', show: false, task: (h) async => throw const Cancelled()), isNull);
    await tester.pump();
    expect(find.byType(SnackBar), findsNothing);
  });
}
