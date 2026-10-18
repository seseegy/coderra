import 'dart:async';

import 'package:flutter/material.dart';

import '../agent/agent_client.dart';
import '../agent/agent_fs.dart';
import 'i18n.dart';
import 'theme.dart';

/// What a running transfer reports to its dialog, and how it hears about "Cancel".
class TransferHandle {
  TransferHandle._(this.cancel);

  final CancelToken cancel;
  final _progress = ValueNotifier<({int done, int total})>((done: 0, total: 0));
  final _label = ValueNotifier<String>('');

  /// Pass to `upload` / `toPhoneFile`.
  void onProgress(int done, int total) =>
      _progress.value = (done: done, total: total);

  /// What is being sent now, when several things are (`photo.pdf · 2 of 3`).
  set label(String text) => _label.value = text;
}

String _size(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

/// Runs [task], a transfer between the phone and a server, with a dialog that shows how far it is and lets the user stop
/// it. Returns the task's result, or null if it was stopped or failed (a failure is shown in a message). With [show]
/// false (files on the phone itself, which copy at once) there is no dialog, but errors are still reported the same way.
Future<T?> runTransfer<T>(
  BuildContext context, {
  required String title,
  required Future<T> Function(TransferHandle handle) task,
  bool show = true,
}) async {
  final handle = TransferHandle._(CancelToken());
  final navigator = Navigator.of(context, rootNavigator: true);
  final messenger = ScaffoldMessenger.maybeOf(context);
  var dialogOpen = false;
  if (show) {
    dialogOpen = true;
    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        useRootNavigator: true,
        builder: (_) => _TransferDialog(title: title, handle: handle),
      ).whenComplete(() => dialogOpen = false),
    );
  }
  try {
    return await task(handle);
  } on Cancelled {
    return null;
  } on AgentError catch (e) {
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(switch (e.code) {
            'offline' || 'connection_lost' => tr(
              'The connection to the server was lost. Nothing was changed.',
            ),
            _ => e.message,
          }),
        ),
      );
    return null;
  } catch (e) {
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text('$e')));
    return null;
  } finally {
    if (dialogOpen && navigator.mounted) navigator.pop();
  }
}

class _TransferDialog extends StatelessWidget {
  const _TransferDialog({required this.title, required this.handle});

  final String title;
  final TransferHandle handle;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return PopScope(
      canPop: false,
      child: AlertDialog(
        title: Text(title),
        content: ListenableBuilder(
          listenable: Listenable.merge([
            handle._progress,
            handle._label,
            handle.cancel,
          ]),
          builder: (context, _) {
            final v = handle._progress.value;
            final known = v.total > 0;
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (handle._label.value.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      handle._label.value,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                LinearProgressIndicator(
                  value: known ? v.done / v.total : null,
                  minHeight: 4,
                  borderRadius: BorderRadius.circular(2),
                ),
                const SizedBox(height: 8),
                Text(
                  handle.cancel.cancelled
                      ? tr('Stopping…')
                      : known
                      ? '${_size(v.done)} ${tr('of')} ${_size(v.total)} · ${v.done * 100 ~/ v.total}%'
                      : tr('Starting…'),
                  style: TextStyle(fontSize: 12.5, color: p.muted),
                ),
              ],
            );
          },
        ),
        actions: [
          TextButton(
            onPressed: handle.cancel.cancelled ? null : handle.cancel.cancel,
            child: Text(tr('Cancel')),
          ),
        ],
      ),
    );
  }
}
