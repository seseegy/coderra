import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:simple_icons/simple_icons.dart';

import '../agent/agent_controller.dart';
import '../agent/integrations.dart';
import 'kit.dart';
import 'theme.dart';

/// DNS-over-HTTPS and the agent's web search.
class NetworkScreen extends StatefulWidget {
  const NetworkScreen({super.key, required this.agent});
  final AgentController agent;

  @override
  State<NetworkScreen> createState() => _NetworkScreenState();
}

class _NetworkScreenState extends State<NetworkScreen> {
  Integrations get it => widget.agent.integrations;
  final customUrl = TextEditingController();
  bool saving = false;

  @override
  void initState() {
    super.initState();
    it.refreshSettings().then((s) => customUrl.text = s.dnsUrl ?? '', onError: (_) {});
  }

  @override
  void dispose() {
    customUrl.dispose();
    super.dispose();
  }

  Future<void> _save(Map<String, dynamic> patch, {String? done}) async {
    setState(() => saving = true);
    try {
      await it.updateSettings(patch);
      if (done != null && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return ListenableBuilder(
      listenable: it,
      builder: (context, _) {
        final s = it.settings;
        return Scaffold(
          appBar: AppBar(
            title: const Text('Web & DNS'),
            actions: [
              if (saving)
                const Padding(
                  padding: EdgeInsets.only(right: 20),
                  child: SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                ),
            ],
          ),
          body: s == null
              ? const Center(child: SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)))
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 40),
                  children: [
                    const SectionLabel('DNS', padding: EdgeInsets.fromLTRB(4, 8, 4, 10)),
                    Text(
                      'Some networks block sites by answering DNS with a block page. DNS-over-HTTPS sends lookups '
                      'encrypted, so search, model APIs and downloads reach the real servers.',
                      style: text.bodySmall,
                    ),
                    const SizedBox(height: 12),
                    SettingsGroup(
                      children: [
                        _DnsOption(
                          icon: SimpleIcons.cloudflare,
                          color: const Color(0xFFF38020),
                          title: 'Cloudflare',
                          subtitle: '1.1.1.1 over HTTPS · recommended',
                          selected: s.dns == 'cloudflare',
                          onTap: () => _save({'dns': 'cloudflare'}),
                        ),
                        _DnsOption(
                          icon: SimpleIcons.google,
                          color: const Color(0xFF4285F4),
                          title: 'Google',
                          subtitle: '8.8.8.8 over HTTPS',
                          selected: s.dns == 'google',
                          onTap: () => _save({'dns': 'google'}),
                        ),
                        _DnsOption(
                          icon: LucideIcons.link,
                          color: p.accent,
                          title: 'Custom DoH',
                          subtitle: 'Any JSON DNS-over-HTTPS endpoint',
                          selected: s.dns == 'custom',
                          onTap: () => _save({'dns': 'custom', 'dnsUrl': customUrl.text}),
                        ),
                        _DnsOption(
                          icon: LucideIcons.smartphone,
                          color: p.muted,
                          title: 'System',
                          subtitle: 'Whatever the phone and network use',
                          selected: s.dns == 'system',
                          onTap: () => _save({'dns': 'system'}),
                        ),
                      ],
                    ),
                    if (s.dns == 'custom') ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: customUrl,
                        autocorrect: false,
                        keyboardType: TextInputType.url,
                        style: const TextStyle(fontFamily: mono, fontSize: 13.5),
                        decoration: const InputDecoration(
                          labelText: 'DoH URL',
                          hintText: 'https://dns.example/dns-query',
                        ),
                        onSubmitted: (v) => _save({'dns': 'custom', 'dnsUrl': v}, done: 'DNS updated'),
                      ),
                    ],
                    const SizedBox(height: 10),
                    Text(
                      'Applies to the agent, web search, accounts and deploys. The Linux container uses the same provider.',
                      style: text.bodySmall,
                    ),
                    const SectionLabel('Web search'),
                    SurfaceCard(
                      child: Row(
                        children: [
                          const IconTile(icon: SimpleIcons.duckduckgo, color: Color(0xFFDE5833)),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('Built in, no key needed', style: text.titleSmall),
                                const SizedBox(height: 2),
                                Text(
                                  'The agent has web_search and web_fetch tools (DuckDuckGo, then Brave).',
                                  style: text.bodySmall,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text('Optional API keys give faster, more reliable results:', style: text.bodySmall),
                    const SizedBox(height: 10),
                    _KeyField(
                      icon: SimpleIcons.brave,
                      color: const Color(0xFFFB542B),
                      title: 'Brave Search API',
                      saved: s.hasBraveKey,
                      onSave: (v) => _save({'braveKey': v}, done: v.isEmpty ? 'Key removed' : 'Brave key saved'),
                      onLink: () => widget.agent.client.openUrl('https://brave.com/search/api/'),
                    ),
                    const SizedBox(height: 10),
                    _KeyField(
                      icon: LucideIcons.telescope,
                      color: const Color(0xFF0EA5E9),
                      title: 'Tavily',
                      saved: s.hasTavilyKey,
                      onSave: (v) => _save({'tavilyKey': v}, done: v.isEmpty ? 'Key removed' : 'Tavily key saved'),
                      onLink: () => widget.agent.client.openUrl('https://app.tavily.com'),
                    ),
                    const SizedBox(height: 10),
                    _MultiKeyField(
                      icon: LucideIcons.keyRound,
                      color: const Color(0xFF14B8A6),
                      title: 'Search1API',
                      savedCount: s.search1apiKeyCount,
                      onSave: (v) =>
                          _save({'search1apiKeys': v}, done: v.isEmpty ? 'Search1API keys removed' : 'Search1API keys saved'),
                      onAppend: (v) => _save({'search1apiKeysAppend': v}, done: 'Search1API keys added'),
                      onLink: () => widget.agent.client.openUrl('https://s1.dev'),
                    ),
                  ],
                ),
        );
      },
    );
  }
}

class _DnsOption extends StatelessWidget {
  const _DnsOption({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return SettingsRow(
      icon: icon,
      color: color,
      title: title,
      subtitle: subtitle,
      onTap: onTap,
      trailing: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: selected ? p.accent : null,
          border: selected ? null : Border.all(color: p.border, width: 2),
        ),
        child: selected ? const Icon(LucideIcons.check, size: 13, color: Colors.white) : null,
      ),
    );
  }
}

class _KeyField extends StatefulWidget {
  const _KeyField({
    required this.icon,
    required this.color,
    required this.title,
    required this.saved,
    required this.onSave,
    required this.onLink,
  });
  final IconData icon;
  final Color color;
  final String title;
  final bool saved;
  final Future<void> Function(String value) onSave;
  final VoidCallback onLink;

  @override
  State<_KeyField> createState() => _KeyFieldState();
}

class _KeyFieldState extends State<_KeyField> {
  final key = TextEditingController();

  @override
  void dispose() {
    key.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              IconTile(icon: widget.icon, color: widget.color, size: 32),
              const SizedBox(width: 12),
              Expanded(child: Text(widget.title, style: text.titleSmall)),
              if (widget.saved) ...[
                Pill('Saved', color: p.success, dot: true),
                IconButton(
                  tooltip: 'Remove key',
                  icon: const Icon(LucideIcons.trash2, size: 16),
                  onPressed: () => widget.onSave(''),
                ),
              ] else
                IconButton(
                  tooltip: 'Get a key',
                  icon: const Icon(LucideIcons.externalLink, size: 16),
                  onPressed: widget.onLink,
                ),
            ],
          ),
          if (!widget.saved) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: key,
                    obscureText: true,
                    autocorrect: false,
                    enableSuggestions: false,
                    decoration: const InputDecoration(hintText: 'API key'),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () async {
                    if (key.text.trim().isEmpty) return;
                    await widget.onSave(key.text.trim());
                    key.clear();
                  },
                  child: const Text('Save'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// Paste-any-number-of-keys field for Search1API. Keys are write-only: the
/// card shows how many are stored, new pastes are appended on the host, and
/// the trash button clears them all. The web tools rotate through the keys
/// automatically, so a key that runs out of credits is skipped for the next.
class _MultiKeyField extends StatefulWidget {
  const _MultiKeyField({
    required this.icon,
    required this.color,
    required this.title,
    required this.savedCount,
    required this.onSave,
    required this.onAppend,
    required this.onLink,
  });
  final IconData icon;
  final Color color;
  final String title;
  final int savedCount;
  final Future<void> Function(String value) onSave;
  final Future<void> Function(String value) onAppend;
  final VoidCallback onLink;

  @override
  State<_MultiKeyField> createState() => _MultiKeyFieldState();
}

class _MultiKeyFieldState extends State<_MultiKeyField> {
  final keys = TextEditingController();

  @override
  void dispose() {
    keys.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final hasKeys = widget.savedCount > 0;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              IconTile(icon: widget.icon, color: widget.color, size: 32),
              const SizedBox(width: 12),
              Expanded(child: Text(widget.title, style: text.titleSmall)),
              if (hasKeys) ...[
                Pill('${widget.savedCount} keys', color: p.success, dot: true),
                IconButton(
                  tooltip: 'Remove all keys',
                  icon: const Icon(LucideIcons.trash2, size: 16),
                  onPressed: () => widget.onSave(''),
                ),
              ] else
                IconButton(
                  tooltip: 'Get keys',
                  icon: const Icon(LucideIcons.externalLink, size: 16),
                  onPressed: widget.onLink,
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Powers web_search, web_fetch and web_screenshot. Paste as many keys as you like, one per line — when a key runs out of credits or errors, the agent rotates to the next one automatically.',
            style: text.bodySmall,
          ),
          const SizedBox(height: 10),
          TextField(
            controller: keys,
            autocorrect: false,
            enableSuggestions: false,
            maxLines: 4,
            style: const TextStyle(fontFamily: mono, fontSize: 13),
            decoration: InputDecoration(hintText: hasKeys ? 'Paste more keys, one per line' : 'Paste API keys, one per line'),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              onPressed: () async {
                if (keys.text.trim().isEmpty) return;
                if (hasKeys) {
                  await widget.onAppend(keys.text);
                } else {
                  await widget.onSave(keys.text);
                }
                keys.clear();
              },
              child: Text(hasKeys ? 'Add keys' : 'Save keys'),
            ),
          ),
        ],
      ),
    );
  }
}
