import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../agent/agent_client.dart';
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
class UpdateRow extends StatefulWidget {
  const UpdateRow({super.key, required this.agent});

  final AgentController agent;

  @override
  State<UpdateRow> createState() => _UpdateRowState();
}

class _UpdateRowState extends State<UpdateRow> {
  Map<String, dynamic>? _result;
  bool _busy = false;
  // Direct-download state: idle | downloading | fetching | ready | error.
  String _dlState = 'idle';
  int _received = 0;
  int _total = 0;
  String? _path;
  String? _serverPath;
  String? _dlMessage;
  String? _installNote;
  Timer? _pollTimer;

  AgentController get agent => widget.agent;

  @override
  void initState() {
    super.initState();
    _check(false);
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  /// Which build and CPU this app is. Without it (no Android here) the host falls back on what it knows itself.
  Future<Map<String, dynamic>> _who() async {
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

  Future<void> _check(bool force) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await agent.client.call<Map<String, dynamic>>('app_update_check', {'force': force, ...await _who()});
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

  Future<void> _startDownload() async {
    if (_serverPath != null) {
      // The server already has it (an earlier try got that far): only the trip to this phone is left.
      unawaited(_fetch(_serverPath!));
      return;
    }
    try {
      final who = await _who();
      final r = await agent.client.call<Map<String, dynamic>>('app_update_download', {'abi': ?who['abi']});
      if (!mounted) return;
      setState(() {
        _dlState = 'downloading';
        _received = 0;
        _total = (r['size'] as num?)?.toInt() ?? 0;
        _installNote = null;
        _dlMessage = null;
      });
      final id = r['id']?.toString() ?? '';
      _pollTimer?.cancel();
      _pollTimer = Timer.periodic(const Duration(milliseconds: 700), (_) => _poll(id));
    } catch (e) {
      if (mounted) {
        setState(() {
          _dlState = 'error';
          _dlMessage = e is AgentError ? e.message : 'could not start';
        });
      }
    }
  }

  Future<void> _poll(String id) async {
    try {
      final st = await agent.client.call<Map<String, dynamic>>('app_update_status', {'downloadId': id});
      if (!mounted) return;
      final state = st['state']?.toString() ?? 'error';
      final path = st['path']?.toString();
      setState(() {
        _received = (st['received'] as num?)?.toInt() ?? _received;
        _total = (st['total'] as num?)?.toInt() ?? _total;
        if (state == 'error') {
          _dlState = 'error';
          _dlMessage = st['message']?.toString();
        }
      });
      if (state != 'downloading') _pollTimer?.cancel();
      if (state == 'done' && path != null) {
        _serverPath = path;
        if (agent.fs.isLocal) {
          setState(() {
            _dlState = 'ready';
            _path = path;
          });
        } else {
          unawaited(_fetch(path));
        }
      }
    } catch (_) {
      // Polling glitch; the timer keeps trying.
    }
  }

  /// With a server agent: brings the APK the server downloaded onto this phone.
  Future<void> _fetch(String serverPath) async {
    setState(() {
      _dlState = 'fetching';
      _received = 0;
      _installNote = null;
      _dlMessage = null;
    });
    try {
      final local = await agent.fs.toPhoneFile(
        serverPath,
        onProgress: (done, total) {
          if (mounted) {
            setState(() {
              _received = done;
              _total = total;
            });
          }
        },
      );
      if (mounted) {
        setState(() {
          _dlState = 'ready';
          _path = local;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _dlState = 'error';
          _dlMessage = e is AgentError ? e.message : '$e';
        });
      }
    }
  }

  Future<void> _install() async {
    final path = _path;
    if (path == null) return;
    final res = await agent.client.installApk(path);
    if (!mounted) return;
    setState(() {
      _installNote = switch (res) {
        'launched' => 'Installer opened — confirm to finish updating',
        'needs-permission' => 'Allow installs for CoderRa on the screen that opened, then tap again',
        _ => 'Could not open the installer',
      };
    });
  }

  String _mb(int bytes) => '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final r = _result;
    final status = r?['status']?.toString();
    final available = status == 'available';
    final working = _dlState == 'downloading' || _dlState == 'fetching';
    final pct = _total > 0 ? (_received * 100 ~/ _total) : 0;
    final String sub;
    if (_dlState == 'downloading') {
      sub = '${agent.fs.isLocal ? 'Downloading' : 'The server is downloading'} build b${r?['latestBuild']}… $pct% (${_mb(_received)} of ${_mb(_total)})';
    } else if (_dlState == 'fetching') {
      sub = 'Bringing build b${r?['latestBuild']} to this phone… $pct% (${_mb(_received)} of ${_mb(_total)})';
    } else if (_dlState == 'ready') {
      sub = _installNote ?? 'Build b${r?['latestBuild']} downloaded — tap to install';
    } else if (_dlState == 'error') {
      sub = 'Download failed${_dlMessage != null ? ' ($_dlMessage)' : ''} — tap to retry';
    } else if (r == null) {
      sub = _busy ? 'Checking…' : 'Tap to check for updates';
    } else {
      final curV = (r['currentVersion'] ?? '').toString();
      final head = curV.isEmpty ? 'Build b${r['currentBuild']}' : 'Version $curV · build b${r['currentBuild']}';
      sub = switch (status) {
        'available' => '$head — build b${r['latestBuild']} available, tap to download',
        'current' => '$head — up to date',
        'none' => '$head — no builds published yet',
        'signed-out' => agent.fs.isLocal ? 'Sign in to GitHub in the app to check for updates' : 'Sign in to GitHub on the server (Accounts) to check for updates',
        _ => "Couldn't check${r['message'] != null && '${r['message']}'.trim().isNotEmpty ? ' (${reason('${r['message']}')})' : ''} — tap to retry",
      };
    }
    return SettingsRow(
      icon: LucideIcons.refreshCw,
      color: available ? const Color(0xFF22C55E) : p.accent,
      title: tr('App updates'),
      subtitle: sub,
      trailing: working
          ? Text('$pct%', style: Theme.of(context).textTheme.bodySmall)
          : _dlState == 'ready'
          ? const Icon(LucideIcons.check, size: 18)
          : _busy
          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : available
          ? const Icon(LucideIcons.download, size: 18)
          : null,
      onTap: () {
        if (working) return;
        if (_dlState == 'ready') {
          _install();
        } else if (_dlState == 'error' && _serverPath != null) {
          _fetch(_serverPath!);
        } else if (available) {
          _startDownload();
        } else {
          _check(true);
        }
      },
    );
  }
}
