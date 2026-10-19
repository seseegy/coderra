import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../agent/agent_client.dart';
import '../agent/agent_controller.dart';
import '../agent/remote_profile.dart';
import 'i18n.dart';
import 'kit.dart';
import 'theme.dart';

Color _stateColor(Palette p, Connection c) => switch (c.state) {
  LinkState.connected => p.success,
  LinkState.connecting || LinkState.reconnecting => p.warning,
  LinkState.offline => p.danger,
};

/// Which agent this is and whether it can be reached: a small badge for the chat's title bar. Only shown once a server
/// has been set up, so someone who never uses one never sees it.
class ConnectionChip extends StatelessWidget {
  const ConnectionChip({super.key, required this.agent});

  final AgentController agent;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([agent.remote, agent.client.connection]),
      builder: (context, _) {
        if (!agent.remote.configured) return const SizedBox.shrink();
        final p = context.palette;
        final server = agent.remote.active;
        final c = agent.client.connection.value;
        final label = !server
            ? tr('Phone')
            : switch (c.state) {
                LinkState.connected => tr('Server'),
                LinkState.connecting || LinkState.reconnecting => tr('Reconnecting'),
                LinkState.offline => tr('Offline'),
              };
        return Padding(
          padding: const EdgeInsets.only(right: 4),
          child: InkWell(
            borderRadius: BorderRadius.circular(99),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ServerScreen(agent: agent))),
            child: Pill(label, color: server ? _stateColor(p, c) : p.muted, dot: true, icon: server ? LucideIcons.server : LucideIcons.smartphone),
          ),
        );
      },
    );
  }
}

/// Shown above the chat while the server cannot be reached: what is happening and a way to hurry it along.
class ConnectionBanner extends StatefulWidget {
  const ConnectionBanner({super.key, required this.agent});

  final AgentController agent;

  @override
  State<ConnectionBanner> createState() => _ConnectionBannerState();
}

class _ConnectionBannerState extends State<ConnectionBanner> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // The countdown to the next attempt.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.agent.client.connection.value.retryAt != null) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;
    return ValueListenableBuilder<Connection>(
      valueListenable: agent.client.connection,
      builder: (context, c, _) {
        if (!agent.client.isRemote || c.connected) return const SizedBox.shrink();
        final p = context.palette;
        final color = _stateColor(p, c);
        final wait = c.retryAt?.difference(DateTime.now());
        final String title;
        final String action;
        if (c.kicked) {
          title = tr('Another device is using the server agent');
          action = tr('Take over');
        } else if (c.state == LinkState.offline) {
          title = tr('Not connected to the server');
          action = tr('Reconnect');
        } else {
          title = c.attempt <= 1 && wait == null
              ? tr('Connecting to the server…')
              : '${tr('Reconnecting to the server')}${wait != null && wait.inSeconds > 0 ? ' · ${wait.inSeconds} s' : '…'}';
          action = tr('Retry now');
        }
        return Material(
          color: color.withValues(alpha: 0.12),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
            child: Row(
              children: [
                if (c.state == LinkState.offline)
                  Icon(LucideIcons.cloudOff, size: 16, color: color)
                else
                  SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2, color: color)),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                      if (c.reason != null && c.reason!.trim().isNotEmpty && !c.kicked)
                        Text(c.reason!.trim().split('\n').last, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: p.muted)),
                      Text(tr('The agent keeps working on the server.'), style: TextStyle(fontSize: 11.5, color: p.muted)),
                    ],
                  ),
                ),
                TextButton(onPressed: agent.client.reconnectNow, child: Text(action)),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// "The last request was cut off": the chat stopped half way and nothing is running. One button carries on.
class InterruptedBar extends StatelessWidget {
  const InterruptedBar({super.key, required this.agent});

  final AgentController agent;

  @override
  Widget build(BuildContext context) {
    if (!agent.interrupted || agent.busy) return const SizedBox.shrink();
    final p = context.palette;
    return Material(
      color: p.warning.withValues(alpha: 0.12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 8, 6),
        child: Row(
          children: [
            Icon(LucideIcons.circleAlert, size: 16, color: p.warning),
            const SizedBox(width: 10),
            Expanded(child: Text(tr('The last request was cut off before it finished.'), style: const TextStyle(fontSize: 13))),
            TextButton(onPressed: agent.continueSession, child: Text(tr('Continue'))),
          ],
        ),
      ),
    );
  }
}

/// Set up, check, install and switch to the agent on the user's server.
class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key, required this.agent});

  final AgentController agent;

  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> {
  AgentController get agent => widget.agent;
  final address = TextEditingController();
  final code = TextEditingController();
  final topic = TextEditingController();
  final ntfyUrl = TextEditingController(text: 'https://ntfy.sh');
  String? command;
  String? codeError;
  String? setupError;
  ServerCheck? checked;
  bool testing = false;
  bool installing = false;
  String? installNote;
  bool? installOk;
  Map<String, dynamic>? health;
  bool changingServer = false;

  @override
  void initState() {
    super.initState();
    _loadCommand();
    agent.client.connection.addListener(_onLink);
    _loadHealth();
  }

  @override
  void dispose() {
    agent.client.connection.removeListener(_onLink);
    for (final c in [address, code, topic, ntfyUrl]) {
      c.dispose();
    }
    super.dispose();
  }

  void _onLink() {
    if (agent.client.connection.value.connected) _loadHealth();
    if (mounted) setState(() {});
  }

  Future<void> _loadCommand() async {
    if (agent.remote.setup == null) return;
    try {
      final c = await agent.remote.bootstrapCommand(address: address.text.trim());
      if (mounted) setState(() => command = c);
    } catch (e) {
      if (mounted) setState(() => setupError = '$e');
    }
  }

  Future<void> _loadHealth() async {
    if (!agent.remote.active || !agent.client.connection.value.connected) return;
    try {
      final h = (await agent.client.call<Map>('health')).cast<String, dynamic>();
      final s = await agent.integrations.refreshSettings();
      if (!mounted) return;
      setState(() {
        health = h;
        topic.text = s.notifyTopic ?? '';
        if (s.notifyUrl != null) ntfyUrl.text = s.notifyUrl!;
      });
    } catch (_) {}
  }

  void _saveCode() {
    try {
      agent.remote.saveCode(code.text);
      setState(() {
        codeError = null;
        code.clear();
        changingServer = false;
        checked = null;
      });
    } on FormatException catch (e) {
      setState(() => codeError = e.message);
    }
  }

  Future<void> _test() async {
    setState(() {
      testing = true;
      checked = null;
    });
    final r = await agent.remote.test();
    if (mounted) {
      setState(() {
        testing = false;
        checked = r;
      });
    }
  }

  Future<void> _install() async {
    setState(() {
      installing = true;
      installOk = null;
      installNote = tr('Preparing…');
    });
    final r = await agent.remote.install(onProgress: (l) => mounted ? setState(() => installNote = l) : null);
    if (!mounted) return;
    setState(() {
      installing = false;
      installOk = r.ok;
      installNote = r.message;
    });
    if (r.ok) unawaited(_test());
  }

  Future<void> _use(bool server) async {
    if (server) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(tr('Use the server agent?')),
          content: Text(
            tr(
              'Chats, files and projects will be the ones on your server. The ones on this phone stay here, untouched, and come back when you switch back.',
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: Text(tr('Cancel'))),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(tr('Use the server'))),
          ],
        ),
      );
      if (ok != true) return;
    }
    await agent.remote.use(server);
    if (mounted) {
      setState(() => health = null);
      _loadHealth();
    }
  }

  Future<void> _forget() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(tr('Forget this server?')),
        content: Text(tr('The app deletes its key for the server and the saved address. Nothing on the server is touched.')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: Text(tr('Cancel'))),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(tr('Forget'))),
        ],
      ),
    );
    if (ok == true) {
      await agent.remote.forget();
      _loadCommand();
      if (mounted) setState(() => checked = null);
    }
  }

  Future<void> _saveNotify({bool? enabled}) async {
    try {
      await agent.integrations.updateSettings({
        'notify': {'enabled': enabled ?? agent.integrations.settings?.notifyEnabled ?? true, 'url': ntfyUrl.text.trim(), 'topic': topic.text.trim()},
      });
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tr('Notifications saved'))));
    } on AgentError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
    if (mounted) setState(() {});
  }

  static String _newTopic() {
    final r = Random.secure();
    return 'coderra-${List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
  }

  Future<void> _copy(String text, String what) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${tr('Copied')}: $what')));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return ListenableBuilder(
      listenable: Listenable.merge([agent.remote, agent.integrations]),
      builder: (context, _) {
        final mode = agent.remote;
        final profile = mode.profile;
        final link = agent.client.connection.value;
        return Scaffold(
          appBar: AppBar(title: Text(tr('Server agent'))),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 40),
            children: [
              SurfaceCard(
                child: Row(
                  children: [
                    IconTile(icon: mode.active ? LucideIcons.server : LucideIcons.smartphone, color: p.accent),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(mode.active ? tr('Your server runs the agent') : tr('This phone runs the agent'), style: text.titleSmall),
                          const SizedBox(height: 2),
                          Text(
                            mode.active
                                ? tr('It keeps working when the app is closed or the phone is off.')
                                : tr('Set up a server to let the agent work around the clock.'),
                            style: text.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    if (mode.active)
                      Pill(
                        switch (link.state) {
                          LinkState.connected => tr('Connected'),
                          LinkState.connecting || LinkState.reconnecting => tr('Reconnecting'),
                          LinkState.offline => link.kicked ? tr('Another device') : tr('Offline'),
                        },
                        color: _stateColor(p, link),
                        dot: true,
                      ),
                  ],
                ),
              ),
              if (mode.active && health != null) _healthCard(context, health!),
              if (profile == null || changingServer) ..._setup(context),
              if (profile != null) ..._server(context, profile),
              if (mode.active && link.connected && agent.integrations.settings != null) ..._notifications(context),
            ],
          ),
        );
      },
    );
  }

  Widget _healthCard(BuildContext context, Map<String, dynamic> h) {
    final p = context.palette;
    String gb(num? bytes) => bytes == null ? '?' : '${(bytes / (1 << 30)).toStringAsFixed(1)} GB';
    final disk = (h['disk'] as Map?)?.cast<String, dynamic>() ?? const {};
    final mem = (h['memory'] as Map?)?.cast<String, dynamic>() ?? const {};
    final runs = (h['runs'] as Map?)?.cast<String, dynamic>() ?? const {};
    final uptime = Duration(seconds: (h['uptimeSec'] as num?)?.toInt() ?? 0);
    final low = disk['level'] != null && disk['level'] != 'ok';
    String line(String k, String v) => '$k  $v';
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: SurfaceCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(tr('Server health'), style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            for (final l in [
              line(tr('Disk free'), '${gb(disk['freeBytes'] as num?)} of ${gb(disk['totalBytes'] as num?)}'),
              line(tr('Agent memory'), gb(mem['rssBytes'] as num?)),
              line(tr('Running'), '${runs['running'] ?? 0} · ${tr('queued')} ${runs['queued'] ?? 0}'),
              line(tr('Up for'), uptime.inHours >= 1 ? '${uptime.inHours} h ${uptime.inMinutes % 60} min' : '${uptime.inMinutes} min'),
              line(tr('Node'), '${h['node'] ?? '?'}'),
            ])
              Padding(padding: const EdgeInsets.symmetric(vertical: 1), child: Text(l, style: TextStyle(fontFamily: mono, fontSize: 12.5, color: p.muted))),
            if (low)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  disk['level'] == 'critical' ? tr('The disk is almost full. New work is refused until space is freed.') : tr('Disk space is getting low.'),
                  style: TextStyle(color: p.warning, fontSize: 12.5),
                ),
              ),
          ],
        ),
      ),
    );
  }

  List<Widget> _setup(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return [
      SectionLabel(tr('1 · Set up the server')),
      Text(
        tr('On the server (Ubuntu or Debian) run the script in the server/ folder of the CoderRa repository, as root, with this app\'s key:'),
        style: text.bodySmall,
      ),
      const SizedBox(height: 10),
      TextField(
        controller: address,
        autocorrect: false,
        keyboardType: TextInputType.url,
        style: const TextStyle(fontFamily: mono, fontSize: 13.5),
        decoration: InputDecoration(labelText: tr('Server address (name or IP)'), hintText: 'agent.example.com'),
        onChanged: (_) => _loadCommand(),
      ),
      const SizedBox(height: 10),
      if (command == null && setupError == null)
        const Center(child: SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)))
      else if (setupError != null)
        Text(setupError!, style: TextStyle(color: p.danger))
      else
        Container(
          padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
          decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.border)),
          child: Row(
            children: [
              Expanded(child: SelectableText(command!, style: TextStyle(fontFamily: mono, fontSize: 12, color: p.text))),
              IconButton(tooltip: tr('Copy'), icon: const Icon(LucideIcons.copy, size: 18), onPressed: () => _copy(command!, tr('command'))),
            ],
          ),
        ),
      SectionLabel(tr('2 · Paste the setup code')),
      Text(tr('The script prints it at the end. The app trusts exactly that server and nothing that only looks like it.'), style: text.bodySmall),
      const SizedBox(height: 10),
      TextField(
        controller: code,
        autocorrect: false,
        enableSuggestions: false,
        minLines: 2,
        maxLines: 5,
        style: const TextStyle(fontFamily: mono, fontSize: 12.5),
        decoration: InputDecoration(labelText: tr('Setup code'), hintText: 'coderra1:…', errorText: codeError, errorMaxLines: 4),
        onChanged: (_) {
          if (codeError != null) setState(() => codeError = null);
        },
      ),
      const SizedBox(height: 10),
      Row(
        children: [
          Expanded(child: PrimaryButton(label: tr('Save server'), icon: LucideIcons.check, onPressed: _saveCode)),
          if (changingServer) TextButton(onPressed: () => setState(() => changingServer = false), child: Text(tr('Cancel'))),
        ],
      ),
    ];
  }

  List<Widget> _server(BuildContext context, RemoteProfile profile) {
    final p = context.palette;
    final mode = agent.remote;
    return [
      SectionLabel(tr('Server')),
      SettingsGroup(
        children: [
          SettingsRow(icon: LucideIcons.globe, color: p.accent, title: profile.address, subtitle: '${tr('user')} ${profile.user}'),
          SettingsRow(
            icon: LucideIcons.fingerprint,
            color: p.muted,
            title: tr('Host key'),
            subtitle: '${profile.hostKey.split(' ').first} · …${profile.hostKey.substring(profile.hostKey.length - 12)}',
            trailing: IconButton(icon: const Icon(LucideIcons.copy, size: 18), tooltip: tr('Copy'), onPressed: () => _copy(profile.hostKey, tr('host key'))),
          ),
          SettingsRow(
            icon: LucideIcons.plugZap,
            color: p.accent,
            title: tr('Test connection'),
            subtitle: testing ? tr('Connecting…') : tr('Checks the key, the host key and the agent'),
            trailing: testing ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)) : null,
            onTap: testing ? null : _test,
          ),
          SettingsRow(
            icon: LucideIcons.download,
            color: p.accent,
            title: tr('Install / update agent'),
            subtitle: installing ? (installNote ?? '') : tr('Copies the agent to the server and restarts it'),
            trailing: installing ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)) : null,
            onTap: installing ? null : _install,
          ),
        ],
      ),
      if (checked != null)
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: _Result(ok: checked!.ok, message: checked!.message, detail: checked!.detail),
        ),
      if (installOk != null && !installing)
        Padding(padding: const EdgeInsets.only(top: 10), child: _Result(ok: installOk!, message: installNote ?? '')),
      const SizedBox(height: 12),
      SettingsGroup(
        children: [
          SettingsRow(
            icon: LucideIcons.server,
            color: p.accent,
            title: tr('Use the server agent'),
            subtitle: mode.active ? tr('Chats and files are the server\'s') : tr('Chats and files are on this phone'),
            trailing: Switch(value: mode.active, onChanged: _use),
            onTap: () => _use(!mode.active),
          ),
          SettingsRow(
            icon: LucideIcons.refreshCw,
            color: p.muted,
            title: tr('Use a different server'),
            onTap: () => setState(() {
              changingServer = true;
              _loadCommand();
            }),
          ),
          SettingsRow(icon: LucideIcons.trash2, color: p.danger, title: tr('Forget this server'), destructive: true, onTap: _forget),
        ],
      ),
    ];
  }

  List<Widget> _notifications(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final s = agent.integrations.settings!;
    return [
      SectionLabel(tr('Notifications')),
      Text(
        tr(
          'When the app is closed the server can push a short message (no project names, no content) through ntfy. Install the ntfy app on this phone and subscribe to the topic below.',
        ),
        style: text.bodySmall,
      ),
      const SizedBox(height: 10),
      TextField(
        controller: ntfyUrl,
        autocorrect: false,
        keyboardType: TextInputType.url,
        style: const TextStyle(fontFamily: mono, fontSize: 13),
        decoration: InputDecoration(labelText: tr('ntfy server')),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: topic,
        autocorrect: false,
        style: const TextStyle(fontFamily: mono, fontSize: 13),
        decoration: InputDecoration(
          labelText: tr('Topic (keep it secret)'),
          suffixIcon: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(tooltip: tr('Make a new one'), icon: const Icon(LucideIcons.dices, size: 18), onPressed: () => setState(() => topic.text = _newTopic())),
              IconButton(tooltip: tr('Copy'), icon: const Icon(LucideIcons.copy, size: 18), onPressed: topic.text.isEmpty ? null : () => _copy(topic.text, tr('topic'))),
            ],
          ),
        ),
      ),
      const SizedBox(height: 10),
      Row(
        children: [
          Expanded(child: PrimaryButton(label: tr('Save'), onPressed: topic.text.trim().isEmpty ? null : () => _saveNotify())),
        ],
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(tr('Send notifications')),
        subtitle: s.notifyTopic == null ? Text(tr('Not set up yet'), style: TextStyle(color: p.muted)) : null,
        value: s.notifyEnabled && s.notifyTopic != null,
        onChanged: s.notifyTopic == null ? null : (v) => _saveNotify(enabled: v),
      ),
    ];
  }
}

class _Result extends StatelessWidget {
  const _Result({required this.ok, required this.message, this.detail});

  final bool ok;
  final String message;
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final color = ok ? p.success : p.danger;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(12), border: Border.all(color: color.withValues(alpha: 0.3))),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(ok ? LucideIcons.circleCheck : LucideIcons.circleAlert, size: 18, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(message, style: const TextStyle(fontSize: 13.5)),
                if (detail != null && detail!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: SelectableText(detail!, style: TextStyle(fontFamily: mono, fontSize: 11, color: p.muted)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
