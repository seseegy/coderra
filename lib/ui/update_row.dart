import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../agent/agent_client.dart';
import '../agent/agent_fs.dart';
import '../agent/agent_controller.dart';
import 'i18n.dart';
import 'kit.dart';
import 'theme.dart';

/// About row (CoderRa fork addition): checks the GitHub Releases of seseegy/coderra for a newer build. The host looks up
/// the newest release (and caches it for 6 hours); the app says which build and which CPU it is, so the verdict and the
/// APK are the right ones whichever machine the host runs on. When an update exists, tapping downloads the APK and then
/// hands it to the system installer.
///
/// With the agent on a server, the server downloads the APK (the repository is private and the GitHub sign-in is there),
/// and the app then fetches it from the server onto this phone, with progress, before installing. Android only installs
/// an update signed with the same key as the installed app, so an APK from anywhere else is refused by the system.
///
/// The download outlives the row ([UpdateDownload]): leaving Settings neither stops it nor forgets it, and the row shows
/// it again when it is opened. It stops only when the user cancels it.
class UpdateRow extends StatefulWidget {
  const UpdateRow({super.key, required this.agent});

  final AgentController agent;

  @override
  State<UpdateRow> createState() => _UpdateRowState();
}

class _UpdateRowState extends State<UpdateRow> {
  Map<String, dynamic>? _result;
  bool _busy = false;

  AgentController get agent => widget.agent;
  UpdateDownload get dl => UpdateDownload.of(agent);

  @override
  void initState() {
    super.initState();
    dl.addListener(_changed);
    _check(false);
    unawaited(dl.resume());
  }

  @override
  void dispose() {
    dl.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _check(bool force) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await agent.client.call<Map<String, dynamic>>('app_update_check', {'force': force, ...await UpdateDownload.who(agent)});
      if (mounted) setState(() => _result = r);
    } catch (e) {
      if (mounted) setState(() => _result = {'status': 'error', 'message': e is AgentError ? e.message : '$e'});
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Why the check failed, in words a person can act on.
  static String reason(String? message) {
    final m = (message ?? '').trim();
    if (m.isEmpty) return '';
    if (RegExp(r'\(401\)|bad credentials', caseSensitive: false).hasMatch(m)) return 'GitHub sign-in expired: sign in again under Accounts';
    if (RegExp(r'\(403\)|rate limit|resource not accessible', caseSensitive: false).hasMatch(m)) return 'GitHub refused (403): rate limit, or the token lacks the repo permission';
    if (RegExp(r'fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network', caseSensitive: false).hasMatch(m)) return 'no connection to GitHub';
    return m.length > 90 ? '${m.substring(0, 89)}…' : m;
  }

  String _mb(int bytes) => '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final r = _result;
    final status = r?['status']?.toString();
    final available = status == 'available';
    final working = dl.working;
    final pct = dl.total > 0 ? (dl.received * 100 ~/ dl.total) : 0;
    final build = dl.tag ?? 'b${r?['latestBuild']}';
    final String sub;
    if (dl.state == 'downloading') {
      sub = '${agent.fs.isLocal ? 'Downloading' : 'The server is downloading'} build $build… $pct% (${_mb(dl.received)} of ${_mb(dl.total)})';
    } else if (dl.state == 'fetching') {
      sub = 'Bringing build $build to this phone… $pct% (${_mb(dl.received)} of ${_mb(dl.total)})';
    } else if (dl.state == 'ready') {
      sub = dl.installNote ?? 'Build $build downloaded — tap to install';
    } else if (dl.state == 'error') {
      sub = 'Download failed${dl.message != null ? ' (${dl.message})' : ''} — tap to retry';
    } else if (r == null) {
      sub = _busy ? 'Checking…' : 'Tap to check for updates';
    } else {
      final curV = (r['currentVersion'] ?? '').toString();
      final head = curV.isEmpty ? 'Build b${r['currentBuild']}' : 'Version $curV · build b${r['currentBuild']}';
      sub = switch (status) {
        'available' => '$head — build b${r['latestBuild']} available, tap to download',
        'current' => '$head — up to date',
        'none' => '$head — no builds published yet',
        'signed-out' =>
          agent.fs.isLocal ? 'Sign in to GitHub in the app to check for updates' : 'Sign in to GitHub on the server (Accounts) to check for updates',
        _ => "Couldn't check${r['message'] != null && '${r['message']}'.trim().isNotEmpty ? ' (${reason('${r['message']}')})' : ''} — tap to retry",
      };
    }
    return SettingsRow(
      icon: LucideIcons.refreshCw,
      color: available ? const Color(0xFF22C55E) : p.accent,
      title: tr('App updates'),
      subtitle: sub,
      trailing: working
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('$pct%', style: Theme.of(context).textTheme.bodySmall),
                IconButton(tooltip: tr('Cancel download'), icon: const Icon(LucideIcons.x, size: 18), onPressed: dl.cancel),
              ],
            )
          : dl.state == 'ready'
          ? const Icon(LucideIcons.check, size: 18)
          : _busy
          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : available
          ? const Icon(LucideIcons.download, size: 18)
          : null,
      onTap: () {
        if (working) return;
        if (dl.state == 'ready') {
          dl.install();
        } else if (dl.state == 'error' || available) {
          dl.start();
        } else {
          _check(true);
        }
      },
    );
  }
}

/// Downloading an update: on a server, the server fetches the APK from GitHub, then this phone fetches it from the
/// server. Kept per agent for as long as the app runs, so it carries on, and is shown again, when Settings is left and
/// opened anew; only [cancel] stops it.
class UpdateDownload extends ChangeNotifier {
  UpdateDownload._(this.agent);

  static final _all = Expando<UpdateDownload>();

  factory UpdateDownload.of(AgentController agent) => _all[agent] ??= UpdateDownload._(agent);

  final AgentController agent;

  /// idle | downloading (the host fetches from GitHub) | fetching (the phone fetches from the server) | ready | error.
  String state = 'idle';
  int received = 0;
  int total = 0;
  String? tag;
  String? message;
  String? installNote;

  /// The APK on this phone, once it is here.
  String? path;

  /// The APK on the server, once the server has it: a failed trip to the phone is retried without GitHub.
  String? _serverPath;
  String? _id;
  Timer? _poll;
  CancelToken? _cancel;
  bool _resumed = false;

  bool get working => state == 'downloading' || state == 'fetching';

  void _set(void Function() change) {
    change();
    notifyListeners();
  }

  /// Which build and CPU this app is. Without it (no Android here) the host falls back on what it knows itself.
  static Future<Map<String, dynamic>> who(AgentController agent) async {
    try {
      final info = await agent.client.appInfo();
      return {
        if (info.build > 0) 'currentBuild': info.build,
        if (info.version.isNotEmpty) 'currentVersion': info.version,
        if (info.abi.isNotEmpty) 'abi': info.abi,
      };
    } catch (_) {
      return const {};
    }
  }

  /// Picks up a download the host still has from before the app was closed, once, if it is for a newer build than this
  /// one. A host from before downloads could be asked about this way answers with an error, which is ignored.
  Future<void> resume() async {
    if (_resumed || state != 'idle') return;
    _resumed = true;
    try {
      final st = await agent.client.call<Map<String, dynamic>>('app_update_status');
      final id = st['id']?.toString();
      final build = int.tryParse('${st['tag'] ?? ''}'.replaceFirst('b', '')) ?? 0;
      final current = (await who(agent))['currentBuild'] as int? ?? 0;
      if (id == null || state != 'idle' || build <= current) return;
      _id = id;
      tag = st['tag']?.toString();
      if (st['state'] == 'downloading') {
        _set(() {
          state = 'downloading';
          received = (st['received'] as num?)?.toInt() ?? 0;
          total = (st['total'] as num?)?.toInt() ?? 0;
        });
        _startPolling();
      } else if (st['state'] == 'done' && st['path'] != null) {
        _arrived(st['path'].toString());
      }
    } catch (_) {
      // Nothing to pick up.
    }
  }

  Future<void> start() async {
    if (working) return;
    if (_serverPath != null) {
      // The server already has it (an earlier try got that far): only the trip to this phone is left.
      unawaited(_fetch(_serverPath!));
      return;
    }
    try {
      final me = await who(agent);
      final r = await agent.client.call<Map<String, dynamic>>('app_update_download', {'abi': ?me['abi']});
      _id = r['id']?.toString() ?? '';
      _set(() {
        state = 'downloading';
        received = 0;
        total = (r['size'] as num?)?.toInt() ?? 0;
        tag = r['tag']?.toString();
        installNote = null;
        message = null;
      });
      _startPolling();
    } catch (e) {
      _set(() {
        state = 'error';
        message = e is AgentError ? e.message : 'could not start';
      });
    }
  }

  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(milliseconds: 700), (_) => _check());
  }

  Future<void> _check() async {
    final id = _id;
    if (id == null || state != 'downloading') {
      _poll?.cancel();
      return;
    }
    try {
      final st = await agent.client.call<Map<String, dynamic>>('app_update_status', {'downloadId': id});
      if (state != 'downloading' || id != _id) return; // cancelled meanwhile
      final now = st['state']?.toString() ?? 'error';
      if (now != 'downloading') _poll?.cancel();
      _set(() {
        received = (st['received'] as num?)?.toInt() ?? received;
        total = (st['total'] as num?)?.toInt() ?? total;
        if (now == 'error') {
          state = 'error';
          message = st['message']?.toString();
        } else if (now == 'cancelled') {
          state = 'idle';
        }
      });
      final path = st['path']?.toString();
      if (now == 'done' && path != null) _arrived(path);
    } catch (_) {
      // Polling glitch; the timer keeps trying.
    }
  }

  void _arrived(String serverPath) {
    _serverPath = serverPath;
    if (agent.fs.isLocal) {
      _set(() {
        state = 'ready';
        path = serverPath;
      });
    } else {
      unawaited(_fetch(serverPath));
    }
  }

  /// With a server agent: brings the APK the server downloaded onto this phone.
  Future<void> _fetch(String serverPath) async {
    final cancel = _cancel = CancelToken();
    _set(() {
      state = 'fetching';
      received = 0;
      installNote = null;
      message = null;
    });
    try {
      final local = await agent.fs.toPhoneFile(
        serverPath,
        cancel: cancel,
        onProgress: (done, all) {
          if (!cancel.cancelled) {
            _set(() {
              received = done;
              total = all;
            });
          }
        },
      );
      if (cancel.cancelled) return;
      _set(() {
        state = 'ready';
        path = local;
      });
    } on Cancelled {
      // Cancelled: the row went back to idle already.
    } catch (e) {
      if (cancel.cancelled) return;
      _set(() {
        state = 'error';
        message = e is AgentError ? e.message : '$e';
      });
    }
  }

  /// Stops the download wherever it is. The server drops a partial download; an APK it already has stays there, so
  /// starting again only brings it to the phone.
  void cancel() {
    if (!working) return;
    _poll?.cancel();
    _cancel?.cancel();
    final id = _id;
    if (state == 'downloading') _id = null;
    _set(() {
      state = 'idle';
      received = 0;
    });
    if (id != null) {
      // An older host does not know the command; the download then runs out on its own.
      unawaited(agent.client.call('app_update_cancel', {'downloadId': id}).then<void>((_) {}, onError: (Object _) {}));
    }
  }

  Future<void> install() async {
    final apk = path;
    if (apk == null) return;
    final res = await agent.client.installApk(apk);
    _set(() {
      installNote = switch (res) {
        'launched' => 'Installer opened — confirm to finish updating',
        'needs-permission' => 'Allow installs for CoderRa on the screen that opened, then tap again',
        _ => 'Could not open the installer',
      };
    });
  }
}
