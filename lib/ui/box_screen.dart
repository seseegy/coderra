import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../agent/agent_client.dart';
import '../agent/agent_controller.dart';
import '../agent/integrations.dart';
import 'i18n.dart';
import 'kit.dart';
import 'task_log.dart';
import 'terminal_screen.dart';
import 'theme.dart';

String _size(int bytes) {
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  if (bytes < 1024 * 1024 * 1024) return '${(bytes / (1024 * 1024)).toStringAsFixed(0)} MB';
  return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
}

String _upFor(DateTime since) {
  final d = DateTime.now().toUtc().difference(since.toUtc());
  if (d.inDays >= 1) return '${d.inDays} d ${d.inHours % 24} h';
  if (d.inHours >= 1) return '${d.inHours} h ${d.inMinutes % 60} min';
  return '${d.inMinutes.clamp(0, 59)} min';
}

/// The agent's box on a server: the rootless container its commands run in. What it is doing, what it uses, and the few
/// things that sometimes need doing about it.
class BoxScreen extends StatefulWidget {
  const BoxScreen({super.key, required this.agent, this.refreshEvery = const Duration(seconds: 10)});

  final AgentController agent;

  /// How often the numbers are read again while the screen is open.
  final Duration refreshEvery;

  @override
  State<BoxScreen> createState() => _BoxScreenState();
}

class _BoxScreenState extends State<BoxScreen> {
  Integrations get it => widget.agent.integrations;
  Timer? _timer;
  String? _loadError;
  bool _checking = false;
  bool _working = false;
  ({bool ok, String message})? _checked;

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(widget.refreshEvery, (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      await it.refreshContainer();
      if (mounted && _loadError != null) setState(() => _loadError = null);
    } catch (e) {
      if (mounted) setState(() => _loadError = e is AgentError && e.code == 'offline' ? tr('Not connected to the server.') : '$e');
    }
  }

  void _say(String text) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  /// Runs a change to the box. If the agent is using it right now the host refuses; the user decides whether to go on.
  Future<void> _change(Future<void> Function(bool force) job) async {
    setState(() => _working = true);
    try {
      try {
        await job(false);
      } on AgentError catch (e) {
        if (e.code != 'busy' || !mounted) rethrow;
        final go = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text(tr('The agent is using the box')),
            content: Text('${e.message}\n\n${tr('Doing this now stops the command it is running.')}'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context, false), child: Text(tr('Wait'))),
              FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(tr('Do it anyway'))),
            ],
          ),
        );
        if (go != true) return;
        await job(true);
      }
    } catch (e) {
      _say(e is AgentError ? e.message : '$e');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<bool> _confirm(String title, String body, String action) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: Text(tr('Cancel'))),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: context.palette.danger, foregroundColor: Colors.white),
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ==
      true;

  Future<void> _check() async {
    setState(() {
      _checking = true;
      _checked = null;
    });
    try {
      final r = await it.checkBox();
      if (mounted) setState(() => _checked = r);
      unawaited(_refresh());
    } catch (e) {
      if (mounted) setState(() => _checked = (ok: false, message: e is AgentError ? e.message : '$e'));
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _setShell(bool on) async {
    if (!on) {
      final ok = await _confirm(
        tr('Run the agent\'s commands on the server itself?'),
        tr(
          'Without the box, every command the agent runs happens directly on the server, as the coderra user. The box is what keeps an apt install or a careless command from touching the server. Turn it off only if you know why.',
        ),
        tr('Turn the box off'),
      );
      if (!ok) return;
    }
    setState(() => _working = true);
    try {
      await it.setContainerShell(on);
      await widget.agent.refreshState();
    } catch (e) {
      _say(e is AgentError ? e.message : '$e');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _rebuild() async {
    if (!await _confirm(
      tr('Rebuild the box image?'),
      tr('Builds the image again from the Containerfile on the server (a few minutes) and then throws the current container away, so the next command starts a fresh one. Anything installed inside it with apt is lost; the workspace and the box\'s home folder are kept.'),
      tr('Rebuild'),
    )) {
      return;
    }
    await _change((force) async {
      await runWithLog<bool>(
        context,
        title: tr('Rebuilding the box'),
        task: (log, _) async {
          await it.installContainer('', onLine: log, force: force);
          return true;
        },
      );
    });
  }

  Future<void> _reset() async {
    if (!await _confirm(
      tr('Reset the box?'),
      tr('Throws the container away. Anything installed inside it with apt is lost, and the next command makes a fresh one. The workspace and the box\'s home folder are kept.'),
      tr('Reset'),
    )) {
      return;
    }
    await _change((force) => it.removeContainer(force: force));
  }

  Future<void> _stop() => _change((force) => it.stopBox(force: force));

  Future<void> _wipe() async {
    if (!await _confirm(
      tr('Empty the box\'s home folder?'),
      tr('Removes what the box keeps in its home: its ssh and git settings, shell history, anything the agent saved there. The container is removed too. The workspace is not touched.'),
      tr('Empty it'),
    )) {
      return;
    }
    await _change((force) async {
      final n = await it.wipeBoxHome(force: force);
      _say('${tr('Removed')} $n');
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return ListenableBuilder(
      listenable: it,
      builder: (context, _) {
        final c = it.container;
        return Scaffold(
          appBar: AppBar(
            title: Text(tr('The agent\'s box')),
            actions: [IconButton(tooltip: tr('Refresh'), icon: const Icon(LucideIcons.refreshCw, size: 20), onPressed: _refresh)],
          ),
          body: c == null
              ? Center(
                  child: _loadError == null
                      ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!, textAlign: TextAlign.center, style: TextStyle(color: p.danger))),
                )
              : !c.available
              ? _none(context, c)
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 40),
                  children: [
                    _header(context, c),
                    if (_loadError != null)
                      Padding(padding: const EdgeInsets.only(top: 10), child: Text(_loadError!, style: TextStyle(color: p.warning, fontSize: 12.5))),
                    if (c.problem != null) Padding(padding: const EdgeInsets.only(top: 12), child: _Note(c.problem!, p.warning)),
                    if (c.usage != null) _usage(context, c),
                    SectionLabel(tr('Agent')),
                    SettingsGroup(
                      children: [
                        SettingsRow(
                          icon: LucideIcons.shield,
                          color: p.accent,
                          title: tr('Run the agent\'s commands in the box'),
                          subtitle: c.enabled ? tr('Every command happens inside the box, not on the server') : tr('Off: commands run directly on the server'),
                          trailing: Switch(value: c.enabled, onChanged: _working ? null : _setShell),
                        ),
                        SettingsRow(
                          icon: LucideIcons.terminal,
                          color: const Color(0xFF22C55E),
                          title: tr('Open a shell in the box'),
                          subtitle: tr('The same place the agent works in'),
                          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => TerminalScreen(agent: widget.agent, command: 'box'))),
                        ),
                        SettingsRow(
                          icon: LucideIcons.heartPulse,
                          color: p.accent,
                          title: tr('Test the box'),
                          subtitle: _checking ? tr('Running a command in it…') : tr('Runs a command inside it, the way the agent does'),
                          trailing: _checking ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)) : null,
                          onTap: _checking ? null : _check,
                        ),
                      ],
                    ),
                    if (_checked != null) Padding(padding: const EdgeInsets.only(top: 10), child: _Note(_checked!.message, _checked!.ok ? p.success : p.danger)),
                    SectionLabel(tr('Manage')),
                    SettingsGroup(
                      children: [
                        SettingsRow(
                          icon: LucideIcons.power,
                          color: p.muted,
                          title: tr('Stop the box'),
                          subtitle: tr('Frees its memory; the next command starts it again'),
                          onTap: _working || c.state != 'running' ? null : _stop,
                        ),
                        SettingsRow(
                          icon: LucideIcons.rotateCcw,
                          color: p.warning,
                          title: tr('Reset the box'),
                          subtitle: tr('Throws the container away; the next command makes a fresh one'),
                          onTap: _working || c.state == 'none' ? null : _reset,
                        ),
                        SettingsRow(
                          icon: LucideIcons.hammer,
                          color: p.warning,
                          title: tr('Rebuild the image'),
                          subtitle: tr('Builds it again from the Containerfile on the server'),
                          onTap: _working ? null : _rebuild,
                        ),
                        SettingsRow(
                          icon: LucideIcons.trash2,
                          color: p.danger,
                          title: tr('Empty the box\'s home folder'),
                          subtitle: tr('Its ssh and git settings, history and saved files'),
                          destructive: true,
                          onTap: _working ? null : _wipe,
                        ),
                      ],
                    ),
                    if (c.limits.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 14),
                        child: Text(
                          '${tr('Limits')}: ${tr('memory')} ${c.limits['memory']} · ${tr('swap')} ${c.limits['swap']} · ${c.limits['cpus']} CPU. ${tr('Set in ~/.coderra/box.conf on the server; they apply when the container is next made.')}',
                          style: text.bodySmall,
                        ),
                      ),
                  ],
                ),
        );
      },
    );
  }

  Widget _header(BuildContext context, ContainerStatus c) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final (label, color) = switch (c.state) {
      'running' => (tr('Running'), p.success),
      'stopped' => (tr('Stopped'), p.muted),
      'none' => (c.installed ? tr('Not started yet') : tr('Not built'), p.muted),
      _ => (tr('Unknown'), p.warning),
    };
    return SurfaceCard(
      highlight: c.enabled && c.state == 'running',
      padding: const EdgeInsets.all(20),
      child: Row(
        children: [
          IconTile(icon: LucideIcons.container, color: p.accent, size: 48),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(tr('A container on your server'), style: text.titleMedium),
                const SizedBox(height: 3),
                Text(
                  c.state == 'running' && c.startedAt != null ? '${c.image ?? ''} · ${tr('up for')} ${_upFor(c.startedAt!)}' : c.image ?? '',
                  style: TextStyle(fontFamily: mono, fontSize: 12, color: p.muted),
                ),
              ],
            ),
          ),
          Pill(label, color: color, dot: true),
        ],
      ),
    );
  }

  Widget _usage(BuildContext context, ContainerStatus c) {
    final p = context.palette;
    final u = c.usage!;
    final limit = u.memoryLimitBytes;
    final fraction = limit == null || limit <= 0 ? null : (u.memoryBytes / limit).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: SurfaceCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(tr('Using now'), style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 10),
            Text('${tr('Memory')}  ${_size(u.memoryBytes)}${limit == null ? '' : ' ${tr('of')} ${_size(limit)}'}', style: TextStyle(fontFamily: mono, fontSize: 12.5, color: p.muted)),
            if (fraction != null)
              Padding(
                padding: const EdgeInsets.only(top: 6, bottom: 4),
                child: LinearProgressIndicator(
                  value: fraction,
                  minHeight: 4,
                  borderRadius: BorderRadius.circular(2),
                  color: fraction > 0.9 ? p.danger : (fraction > 0.7 ? p.warning : p.accent),
                ),
              ),
            Text('${tr('Processes')}  ${u.processes}', style: TextStyle(fontFamily: mono, fontSize: 12.5, color: p.muted)),
          ],
        ),
      ),
    );
  }

  Widget _none(BuildContext context, ContainerStatus c) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 40),
      children: [
        SurfaceCard(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(icon: LucideIcons.container, color: p.warning, size: 44),
              const SizedBox(height: 14),
              Text(tr('There is no box on this server'), style: text.titleMedium),
              const SizedBox(height: 6),
              Text(c.problem ?? '', style: text.bodySmall),
              const SizedBox(height: 10),
              Text(
                tr('To add one, run the setup script on the server again without --no-box. Until then the agent\'s commands run directly on the server.'),
                style: text.bodySmall,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.message, this.color);

  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(12), border: Border.all(color: color.withValues(alpha: 0.3))),
      child: SelectableText(message, style: const TextStyle(fontSize: 13)),
    );
  }
}
