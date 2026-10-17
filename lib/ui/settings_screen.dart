import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../agent/agent_controller.dart';
import '../agent/models.dart';
import 'login_flow.dart';
import 'kit.dart';
import 'theme.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.agent});
  final AgentController agent;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  String query = '';

  @override
  void initState() {
    super.initState();
    widget.agent.refreshProviders();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return ListenableBuilder(
      listenable: widget.agent,
      builder: (context, _) {
        final agent = widget.agent;
        final q = query.toLowerCase();
        final connected = agent.providers.where((x) => x.configured).toList();
        final others = agent.providers
            .where((x) => !x.configured && (q.isEmpty || x.name.toLowerCase().contains(q) || x.id.contains(q)))
            .toList();

        return Scaffold(
          appBar: AppBar(
            title: const Text('Models & providers'),
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(1),
              child: Divider(height: 1, color: p.border),
            ),
          ),
          body: ListView(
            padding: const EdgeInsets.only(bottom: 32),
            children: [
              const _Header('Connected'),
              if (connected.isEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                  child: Text('No providers yet. Pick one below.', style: text.bodySmall),
                ),
              for (final pr in connected) _ProviderTile(provider: pr, agent: agent),
              const _Header('Add provider'),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                child: TextField(
                  onChanged: (v) => setState(() => query = v),
                  decoration: const InputDecoration(
                    hintText: 'Search providers',
                    prefixIcon: Icon(LucideIcons.search, size: 18),
                  ),
                ),
              ),
              for (final pr in others) _ProviderTile(provider: pr, agent: agent),
              const _Header('Custom provider'),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                child: Text(
                  'Add any OpenAI-compatible endpoint with its base URL, API key and a model ID — '
                  'a router, a proxy, or a local server such as Ollama or LM Studio.',
                  style: text.bodySmall,
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: OutlinedButton(
                  onPressed: () async {
                    final saved = await showCustomProviderForm(context, agent);
                    if (saved == true && context.mounted) {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('Custom provider saved')));
                    }
                  },
                  child: const Text('Add custom provider'),
                ),
              ),
              const _Header('Environment'),
              _InfoRow('pi', agent.info['version']?.toString() ?? '—'),
              _InfoRow('Node.js', agent.info['node']?.toString() ?? '—'),
              _InfoRow('Workspace', agent.info['workspace']?.toString() ?? '—', mono: true),
              _InfoRow('Agent directory', agent.info['agentDir']?.toString() ?? '—', mono: true),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                child: OutlinedButton(onPressed: agent.busy ? null : agent.restart, child: const Text('Restart agent')),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
    child: Text(label.toUpperCase(), style: Theme.of(context).textTheme.labelSmall),
  );
}

class _InfoRow extends StatelessWidget {
  const _InfoRow(this.label, this.value, {this.mono = false});
  final String label;
  final String value;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: text.labelMedium),
          const SizedBox(height: 2),
          SelectableText(
            value,
            style: mono
                ? TextStyle(fontFamily: 'GeistMono', fontSize: 12.5, color: p.text, height: 1.5)
                : text.bodyMedium,
          ),
        ],
      ),
    );
  }
}

class _ProviderTile extends StatelessWidget {
  const _ProviderTile({required this.provider, required this.agent});
  final ProviderInfo provider;
  final AgentController agent;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final subtitle = provider.custom
        ? (provider.baseUrl ?? 'Custom provider')
        : provider.configured
        ? (provider.oauth ? 'Signed in' : 'API key')
        : '${provider.modelCount} models';
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      leading: BrandTile(id: provider.id, size: 38),
      title: Text(provider.name, style: Theme.of(context).textTheme.titleSmall),
      subtitle: Text(subtitle),
      trailing: provider.custom
          ? Pill('Custom', color: p.accent)
          : provider.configured
          ? Pill('Connected', color: p.success, dot: true)
          : Icon(LucideIcons.chevronRight, size: 18, color: p.faint),
      onTap: () => _open(context),
    );
  }

  Future<void> _open(BuildContext context) async {
    if (provider.custom) {
      await _openCustom(context);
      return;
    }
    final methods = provider.methods;
    if (provider.configured) {
      final disconnect = await showModalBottomSheet<bool>(
        context: context,
        builder: (context) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(provider.name, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 4),
                Text('Remove the stored credential from this device.', style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 20),
                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: context.palette.danger),
                  onPressed: () => Navigator.of(context).pop(true),
                  child: const Text('Disconnect'),
                ),
              ],
            ),
          ),
        ),
      );
      if (disconnect == true) await agent.logout(provider.id);
      return;
    }
    if (methods.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('${provider.name} uses ambient credentials and cannot be set up here.')));
      return;
    }
    var method = methods.first;
    if (methods.length > 1) {
      final picked = await showModalBottomSheet<String>(
        context: context,
        builder: (context) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                title: const Text('Sign in with account'),
                subtitle: const Text('Use your subscription through the browser'),
                onTap: () => Navigator.of(context).pop('oauth'),
              ),
              ListTile(
                title: const Text('Use an API key'),
                subtitle: const Text('Paste a key from the provider console'),
                onTap: () => Navigator.of(context).pop('api_key'),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      );
      if (picked == null) return;
      method = picked;
    }
    if (!context.mounted) return;
    final ok = await showLoginSheet(context, agent, provider, method);
    if (ok == true && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${provider.name} connected')));
    }
  }

  /// Sheet for a user-added provider: show its endpoint, edit it, or remove
  /// it together with its stored API key.
  Future<void> _openCustom(BuildContext context) async {
    final ids = provider.customModelIds;
    final modelsLabel = ids.isEmpty
        ? '—'
        : '${ids.length} · ${ids.take(3).join(', ')}${ids.length > 3 ? ', …' : ''}';
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(provider.name, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text('Custom OpenAI-compatible provider', style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 12),
              _InfoRow('Base URL', provider.baseUrl ?? '—', mono: true),
              _InfoRow('Models', modelsLabel, mono: true),
              const SizedBox(height: 12),
              FilledButton(onPressed: () => Navigator.of(context).pop('edit'), child: const Text('Edit')),
              const SizedBox(height: 8),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: context.palette.danger),
                onPressed: () => Navigator.of(context).pop('delete'),
                child: const Text('Delete provider'),
              ),
            ],
          ),
        ),
      ),
    );
    if (!context.mounted) return;
    if (action == 'edit') {
      final saved = await showCustomProviderForm(context, agent, existing: provider);
      if (saved == true && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Custom provider saved')));
      }
      return;
    }
    if (action != 'delete') return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete provider?'),
        content: Text('"${provider.name}" and its stored API key will be removed from this device.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: context.palette.danger),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await agent.deleteCustomProvider(provider.id);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${provider.name} deleted')));
      }
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }
}

/// Form to add (or edit) an OpenAI-compatible custom provider.
/// Resolves true when a provider was saved.
Future<bool?> showCustomProviderForm(BuildContext context, AgentController agent, {ProviderInfo? existing}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: _CustomProviderForm(agent: agent, existing: existing),
    ),
  );
}

String _providerSlug(String name) =>
    name.trim().toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');

class _CustomProviderForm extends StatefulWidget {
  const _CustomProviderForm({required this.agent, this.existing});
  final AgentController agent;
  final ProviderInfo? existing;

  @override
  State<_CustomProviderForm> createState() => _CustomProviderFormState();
}

class _CustomProviderFormState extends State<_CustomProviderForm> {
  late final name = TextEditingController(text: widget.existing?.name ?? '');
  late final baseUrl = TextEditingController(text: widget.existing?.baseUrl ?? '');
  late final models = TextEditingController(text: widget.existing?.customModelIds.join('\n') ?? '');
  final apiKey = TextEditingController();

  /// Metadata reported by the endpoint for models it listed, keyed by model
  /// ID. Seeded from the stored entries when editing, so a re-save keeps the
  /// context windows and capabilities the provider already had.
  final fetchedMeta = <String, Map<String, dynamic>>{};
  String? error;
  bool saving = false;
  bool fetching = false;

  bool get editing => widget.existing != null;
  String get providerId => editing ? widget.existing!.id : _providerSlug(name.text);

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    if (existing != null) {
      for (final m in existing.customModels) {
        final id = m['id'];
        if (id is String) fetchedMeta[id] = _metaFromStored(m);
      }
    }
  }

  /// Converts a stored models.json entry back into the descriptor shape the
  /// host accepts on save.
  static Map<String, dynamic> _metaFromStored(Map<String, dynamic> m) {
    final input = m['input'];
    return {
      'id': m['id'],
      if (m['name'] is String) 'name': m['name'],
      if (m['contextWindow'] is num) 'contextWindow': (m['contextWindow'] as num).toInt(),
      if (m['maxTokens'] is num) 'maxTokens': (m['maxTokens'] as num).toInt(),
      if (m['reasoning'] == true) 'reasoning': true,
      if (input is List && input.contains('image')) 'vision': true,
    };
  }

  /// The model IDs currently in the text field: split on whitespace, commas
  /// and semicolons, deduplicated, order preserved.
  List<String> get _modelIds {
    final seen = <String>{};
    final out = <String>[];
    for (final part in models.text.split(RegExp(r'[\s,;]+'))) {
      final id = part.trim();
      if (id.isNotEmpty && seen.add(id)) out.add(id);
    }
    return out;
  }

  @override
  void dispose() {
    name.dispose();
    baseUrl.dispose();
    models.dispose();
    apiKey.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final url = Uri.tryParse(baseUrl.text.trim());
    final ids = _modelIds;
    String? problem;
    if (name.text.trim().isEmpty) {
      problem = 'Give the provider a name.';
    } else if (providerId.isEmpty) {
      problem = 'The name must contain at least one letter or digit.';
    } else if (url == null || (url.scheme != 'http' && url.scheme != 'https') || url.host.isEmpty) {
      problem = 'Base URL must be a full http(s) URL, e.g. https://example.com/v1.';
    } else if (ids.isEmpty) {
      problem = 'Add at least one model ID, or fetch the list from the server.';
    } else if (!editing && apiKey.text.trim().isEmpty) {
      problem = 'Paste the API key for this endpoint.';
    }
    if (problem != null) {
      setState(() => error = problem);
      return;
    }
    setState(() {
      saving = true;
      error = null;
    });
    try {
      await widget.agent.saveCustomProvider(
        id: providerId,
        name: name.text.trim(),
        baseUrl: baseUrl.text.trim(),
        apiKey: apiKey.text.trim(),
        models: [for (final id in ids) fetchedMeta[id] ?? {'id': id}],
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          saving = false;
          error = '$e';
        });
      }
    }
  }

  /// Pulls the endpoint's model catalog and lets the user tick which models
  /// to register; the picked IDs (with their metadata) fill the form.
  Future<void> _fetchModels() async {
    final url = Uri.tryParse(baseUrl.text.trim());
    if (url == null || (url.scheme != 'http' && url.scheme != 'https') || url.host.isEmpty) {
      setState(() => error = 'Fill in a valid base URL first.');
      return;
    }
    setState(() {
      fetching = true;
      error = null;
    });
    try {
      final fetched = await widget.agent.fetchCustomProviderModels(
        baseUrl: baseUrl.text.trim(),
        apiKey: apiKey.text.trim(),
        providerId: editing ? widget.existing!.id : null,
      );
      if (!mounted) return;
      setState(() => fetching = false);
      final picked = await _pickModels(fetched);
      if (picked == null || !mounted) return;
      setState(() {
        final fetchedIds = {for (final m in fetched) m['id'] as String};
        for (final m in fetched) {
          final id = m['id'] as String;
          if (picked.contains(id)) fetchedMeta[id] = m;
        }
        final manual = _modelIds.where((id) => !fetchedIds.contains(id));
        models.text = [...picked, ...manual].join('\n');
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          fetching = false;
          error = '$e';
        });
      }
    }
  }

  /// Checklist dialog over a fetched catalog, with a text filter.
  /// Resolves the chosen model IDs, or null when cancelled.
  Future<Set<String>?> _pickModels(List<Map<String, dynamic>> fetched) {
    return showDialog<Set<String>>(
      context: context,
      builder: (dialogContext) {
        final selected = {for (final m in fetched) m['id'] as String};
        var query = '';
        return StatefulBuilder(
          builder: (context, setLocal) {
            final q = query.trim().toLowerCase();
            final visible = [
              for (final m in fetched)
                if (q.isEmpty ||
                    (m['id'] as String).toLowerCase().contains(q) ||
                    ((m['name'] as String?)?.toLowerCase().contains(q) ?? false))
                  m,
            ];
            return AlertDialog(
              title: Text('${fetched.length} models found'),
              content: SizedBox(
                width: double.maxFinite,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      autocorrect: false,
                      decoration: const InputDecoration(
                        hintText: 'Filter models',
                        prefixIcon: Icon(LucideIcons.search),
                      ),
                      onChanged: (v) => setLocal(() => query = v),
                    ),
                    Row(
                      children: [
                        TextButton(
                          onPressed: () =>
                              setLocal(() => selected.addAll([for (final m in visible) m['id'] as String])),
                          child: const Text('Select all'),
                        ),
                        TextButton(
                          onPressed: () =>
                              setLocal(() => selected.removeAll([for (final m in visible) m['id'] as String])),
                          child: const Text('Clear'),
                        ),
                      ],
                    ),
                    Flexible(
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: visible.length,
                        itemBuilder: (context, i) {
                          final m = visible[i];
                          final id = m['id'] as String;
                          final modelName = m['name'] as String?;
                          return CheckboxListTile(
                            dense: true,
                            value: selected.contains(id),
                            onChanged: (v) => setLocal(() {
                              if (v == true) {
                                selected.add(id);
                              } else {
                                selected.remove(id);
                              }
                            }),
                            title: Text(modelName ?? id, maxLines: 1, overflow: TextOverflow.ellipsis),
                            subtitle: modelName == null
                                ? null
                                : Text(id, maxLines: 1, overflow: TextOverflow.ellipsis),
                          );
                        },
                      ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
                FilledButton(
                  onPressed: selected.isEmpty ? null : () => Navigator.pop(dialogContext, selected),
                  child: Text('Use ${selected.length} models'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(editing ? 'Edit custom provider' : 'Add custom provider', style: text.titleLarge),
            const SizedBox(height: 4),
            Text(
              'Any endpoint that speaks the OpenAI Chat Completions API. The key is stored only on this device.',
              style: text.bodySmall,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: name,
              autocorrect: false,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: 'Name',
                hintText: 'My router',
                helperText: providerId.isEmpty ? null : 'Provider ID: $providerId',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: baseUrl,
              autocorrect: false,
              keyboardType: TextInputType.url,
              style: const TextStyle(fontFamily: 'GeistMono', fontSize: 14),
              decoration: const InputDecoration(labelText: 'Base URL', hintText: 'https://example.com/v1'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: apiKey,
              autocorrect: false,
              obscureText: true,
              style: const TextStyle(fontFamily: 'GeistMono', fontSize: 14),
              decoration: InputDecoration(
                labelText: 'API key',
                hintText: editing ? 'Leave blank to keep the current key' : 'Paste the API key',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: models,
              autocorrect: false,
              minLines: 3,
              maxLines: 6,
              onChanged: (_) => setState(() {}),
              style: const TextStyle(fontFamily: 'GeistMono', fontSize: 14),
              decoration: const InputDecoration(
                labelText: 'Models',
                hintText: 'One model ID per line',
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                OutlinedButton.icon(
                  onPressed: (saving || fetching) ? null : _fetchModels,
                  icon: const Icon(LucideIcons.download, size: 18),
                  label: Text(fetching ? 'Fetching…' : 'Fetch from server'),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    _modelIds.isEmpty
                        ? 'Fetch pulls the list from the endpoint.'
                        : '${_modelIds.length} model${_modelIds.length == 1 ? '' : 's'}',
                    style: text.bodySmall,
                  ),
                ),
              ],
            ),
            if (error != null) ...[
              const SizedBox(height: 12),
              Text(error!, style: text.bodySmall?.copyWith(color: p.danger)),
            ],
            const SizedBox(height: 20),
            FilledButton(
              onPressed: saving ? null : _save,
              child: Text(saving ? 'Saving…' : (editing ? 'Save changes' : 'Add provider')),
            ),
          ],
        ),
      ),
    );
  }
}
