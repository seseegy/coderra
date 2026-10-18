import 'dart:async';

import 'package:flutter/material.dart';

import '../agent/agent_controller.dart';
import '../agent/agent_fs.dart';
import 'preview_screen.dart';

/// Opens a URL in the preview screen. Tests pass their own, since there is no WebView in a unit test.
typedef UrlOpener = Future<void> Function(BuildContext context, String title, String url);

Future<void> _openInPreview(BuildContext context, String title, String url) => HtmlPreviewScreen.openUrl(context, title: title, url: url);

/// Shows the web page at [path] (which belongs to the agent's machine).
///
/// On this phone the page is read and shown with its folder as the base, so its pictures and styles load by path. With a
/// server agent the page is on the server: the host serves the project folder, the app forwards that port over ssh, and the
/// WebView opens it like any web site, so relative links just work. A page that is still being written ([live]) is shown
/// from the text as it streams in, as on the phone.
Future<void> openFilePreview(
  BuildContext context,
  AgentController agent, {
  required String title,
  required String path,
  required FutureOr<String> Function() source,
  Listenable? live,
  UrlOpener? opener,
}) async {
  if (agent.fs.isLocal || live != null || agent.remote.forwards == null) {
    await HtmlPreviewScreen.open(context, title: title, source: source, baseDir: agent.fs.isLocal ? parentPath(path) : null, live: live);
    return;
  }
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    final url = await agent.remote.previewUrl(path, root: agent.cwd.isEmpty ? null : agent.cwd);
    if (url == null || !context.mounted) return;
    await (opener ?? _openInPreview)(context, title, url);
  } catch (e) {
    messenger?.showSnackBar(SnackBar(content: Text('Could not open the preview: $e')));
  }
}

/// Opens a dev server the agent started. On this phone it is on localhost; on a server its port is forwarded first.
Future<void> openDevServer(BuildContext context, AgentController agent, int port, String localUrl, {UrlOpener? opener}) async {
  final title = 'localhost:$port';
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    final url = agent.client.isRemote ? await agent.remote.devServerUrl(port) : localUrl;
    if (url == null || !context.mounted) return;
    await (opener ?? _openInPreview)(context, title, url);
  } catch (e) {
    messenger?.showSnackBar(SnackBar(content: Text('Could not reach port $port on the server: $e')));
  }
}
