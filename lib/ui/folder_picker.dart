import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../agent/agent_controller.dart';
import '../agent/agent_fs.dart';
import 'kit.dart';
import 'theme.dart';

/// The last path segment, for showing a folder by name.
String folderName(String path) => path.split('/').where((s) => s.isNotEmpty).lastOrNull ?? path;

/// Folder name to show for a session's cwd, or null for the workspace root.
String? sessionFolder(String cwd, String workspace) {
  if (cwd.isEmpty || cwd == workspace || cwd == '$workspace/') return null;
  return folderName(cwd);
}

/// Browse the app workspace or phone storage and pick a folder to work in.
/// Pops with the chosen absolute path.
class FolderPicker extends StatefulWidget {
  const FolderPicker({super.key, required this.agent});
  final AgentController agent;

  static Future<String?> pick(BuildContext context, AgentController agent) =>
      Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => FolderPicker(agent: agent)));

  @override
  State<FolderPicker> createState() => _FolderPickerState();
}

enum _Root { workspace, phone }

class _FolderPickerState extends State<FolderPicker> with WidgetsBindingObserver {
  _Root root = _Root.workspace;
  late String workspace = widget.agent.info['workspace'] as String? ?? '/';
  String phoneRoot = '/storage/emulated/0';
  bool phoneGranted = false;

  /// False in the Play build, which has no "All files access": only the workspace is offered.
  bool phoneAvailable = true;
  late String path = workspace;
  bool showHidden = false;

  /// The folders under [path], filled in by [_load].
  List<FsEntry> folders = const [];
  bool loading = true;
  int _loadId = 0;

  String get base => root == _Root.workspace ? workspace : phoneRoot;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkAccess();
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // The grant happens in system settings; re-check when the user comes back.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkAccess();
  }

  Future<void> _checkAccess() async {
    // With a server agent the folders are the server's: this phone's storage is not on offer, and neither is the
    // permission to read it.
    if (widget.agent.client.isRemote) {
      if (!mounted) return;
      setState(() {
        phoneAvailable = false;
        phoneGranted = false;
        root = _Root.workspace;
      });
      return;
    }
    final a = await widget.agent.client.storageAccess();
    if (!mounted) return;
    setState(() {
      phoneGranted = a.granted;
      phoneAvailable = a.available;
      if (!phoneAvailable && root == _Root.phone) {
        root = _Root.workspace;
        path = base;
      }
      phoneRoot = a.root;
    });
    _load();
  }

  void _switch(_Root r) {
    setState(() {
      root = r;
      path = base;
    });
    _load();
  }

  /// Shows [target] and lists its folders.
  void _go(String target) {
    setState(() => path = target);
    _load();
  }

  /// Lists the folders under [path] (not links, hidden ones only on request). Call after [path], [root] or
  /// [showHidden] changes.
  Future<void> _load() async {
    final id = ++_loadId;
    if (!loading && mounted) setState(() => loading = true);
    List<FsEntry> dirs;
    try {
      dirs = (await widget.agent.fs.list(path, detectGit: true))
          .where((e) => e.isDir && !e.isLink && (showHidden || !e.name.startsWith('.')))
          .toList();
      dirs.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    } catch (_) {
      dirs = const [];
    }
    if (!mounted || id != _loadId) return;
    setState(() {
      folders = dirs;
      loading = false;
    });
  }

  /// Deletes a project folder from the workspace, permanently.
  ///
  /// Only offered for folders inside the workspace (never phone storage and
  /// never the workspace root itself). The folder the active session is
  /// working in — or any folder containing it — is refused.
  Future<void> _deleteProject(FsEntry dir) async {
    final name = dir.name;
    final cwd = widget.agent.cwd;
    if (cwd == dir.path || cwd.startsWith('${dir.path}/')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('That project is in use by the current chat. Switch chats before deleting it.')),
      );
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete project?'),
        content: Text(
          '"$name" and everything inside it will be deleted from the workspace. This cannot be undone.',
        ),
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
      await widget.agent.fs.delete(dir.path, recursive: true);
      widget.agent.integrations.refreshProjects().catchError((_) {});
      if (mounted) {
        _load();
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Project "$name" deleted')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not delete it: $e')));
    }
  }

  /// Actions for one listed folder: open it, or (in the workspace) delete it.
  Future<void> _folderActions(FsEntry dir) async {
    final canDelete = root == _Root.workspace;
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(LucideIcons.folderOpen, size: 20),
              title: Text('Open ${folderName(dir.path)}'),
              onTap: () => Navigator.of(context).pop('open'),
            ),
            if (canDelete)
              ListTile(
                leading: Icon(LucideIcons.trash2, size: 20, color: context.palette.danger),
                title: Text('Delete project', style: TextStyle(color: context.palette.danger)),
                subtitle: const Text('Removes the folder and everything inside it from the workspace'),
                onTap: () => Navigator.of(context).pop('delete'),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (action == 'open') {
      _go(dir.path);
    } else if (action == 'delete') {
      await _deleteProject(dir);
    }
  }

  Future<void> _newFolder() async {
    final name = await showDialog<String>(
      context: context,
      builder: (_) => const _NameDialog(title: 'New folder', hint: 'my-project', action: 'Create'),
    );
    final clean = name?.trim().replaceAll(RegExp(r'[/\\:*?"<>|]+'), '-');
    if (clean == null || clean.isEmpty) return;
    try {
      final target = '$path/$clean';
      await widget.agent.fs.mkdir(target);
      if (mounted) _go(target);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not create it: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final locked = root == _Root.phone && !phoneGranted;
    final crumbs = path.substring(base.length).split('/').where((s) => s.isNotEmpty).toList();
    final children = locked ? const <FsEntry>[] : folders;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Choose a folder'),
        actions: [
          IconButton(
            tooltip: showHidden ? 'Hide hidden folders' : 'Show hidden folders',
            icon: Icon(showHidden ? LucideIcons.eye : LucideIcons.eyeOff, size: 18),
            onPressed: () {
              setState(() => showHidden = !showHidden);
              _load();
            },
          ),
          if (!locked)
            IconButton(
              tooltip: 'New folder',
              icon: const Icon(LucideIcons.folderPlus, size: 20),
              onPressed: _newFolder,
            ),
          const SizedBox(width: 4),
        ],
      ),
      body: Column(
        children: [
          if (!phoneAvailable)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                'Projects live in the CoderRa workspace. To bring in files from your phone, open a project and use '
                'Files → Import from phone.',
                style: text.bodySmall,
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
              child: SegmentedButton<_Root>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(
                    value: _Root.workspace,
                    icon: Icon(LucideIcons.boxes, size: 16),
                    label: Text('Workspace'),
                  ),
                  ButtonSegment(
                    value: _Root.phone,
                    icon: Icon(LucideIcons.smartphone, size: 16),
                    label: Text('Phone storage'),
                  ),
                ],
                selected: {root},
                onSelectionChanged: (s) => _switch(s.first),
              ),
            ),
          // Breadcrumbs: tap a segment to jump back up.
          SizedBox(
            height: 36,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              children: [
                _Crumb(
                  label: root == _Root.workspace ? (widget.agent.client.isRemote ? 'server' : 'workspace') : 'phone',
                  icon: root == _Root.workspace ? LucideIcons.boxes : LucideIcons.smartphone,
                  active: crumbs.isEmpty,
                  onTap: () => _go(base),
                ),
                for (var i = 0; i < crumbs.length; i++) ...[
                  Icon(LucideIcons.chevronRight, size: 14, color: p.faint),
                  _Crumb(
                    label: crumbs[i],
                    active: i == crumbs.length - 1,
                    onTap: () => _go('$base/${crumbs.take(i + 1).join('/')}'),
                  ),
                ],
              ],
            ),
          ),
          Divider(height: 16, color: p.border),
          Expanded(
            child: locked
                ? ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      SurfaceCard(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const IconTile(icon: LucideIcons.folderLock, color: Color(0xFFF59E0B), size: 44),
                            const SizedBox(height: 14),
                            Text('Allow file access', style: text.titleMedium),
                            const SizedBox(height: 6),
                            Text(
                              'To work in Download, Documents or any other folder on your phone, CoderRa needs '
                              '"All files access". Turn it on for CoderRa on the next screen, then come back.',
                              style: text.bodySmall,
                            ),
                            const SizedBox(height: 16),
                            PrimaryButton(
                              label: 'Allow access',
                              icon: LucideIcons.shieldCheck,
                              onPressed: widget.agent.client.requestStorageAccess,
                            ),
                          ],
                        ),
                      ),
                    ],
                  )
                : loading && children.isEmpty
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : children.isEmpty
                ? Center(child: Text('No folders here', style: text.bodySmall))
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(8, 0, 8, 16),
                    itemCount: children.length,
                    itemBuilder: (context, i) {
                      final d = children[i];
                      final git = d.isGit;
                      return ListTile(
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12),
                        leading: IconTile(
                          icon: git ? LucideIcons.folderGit2 : LucideIcons.folder,
                          color: git ? p.accent : p.muted,
                          size: 34,
                        ),
                        title: Text(folderName(d.path), style: text.bodyMedium),
                        subtitle: git ? Text('git repository', style: text.bodySmall) : null,
                        trailing: root == _Root.workspace
                            ? IconButton(
                                tooltip: 'Project actions',
                                icon: Icon(LucideIcons.ellipsisVertical, size: 18, color: p.faint),
                                onPressed: () => _folderActions(d),
                              )
                            : Icon(LucideIcons.chevronRight, size: 16, color: p.faint),
                        onTap: () => _go(d.path),
                        onLongPress: root == _Root.workspace ? () => _folderActions(d) : null,
                      );
                    },
                  ),
          ),
          if (!locked)
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: PrimaryButton(
                  label: crumbs.isEmpty
                      ? 'Open ${root == _Root.workspace ? 'workspace' : 'phone storage'}'
                      : 'Open ${crumbs.last}',
                  icon: LucideIcons.folderOpen,
                  onPressed: () => Navigator.pop(context, path),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _Crumb extends StatelessWidget {
  const _Crumb({required this.label, required this.active, required this.onTap, this.icon});
  final String label;
  final bool active;
  final VoidCallback onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        child: Row(
          children: [
            if (icon != null) ...[Icon(icon, size: 14, color: active ? p.accent : p.muted), const SizedBox(width: 5)],
            Text(
              label,
              style: TextStyle(
                fontFamily: mono,
                fontSize: 12.5,
                color: active ? p.text : p.muted,
                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Asks for one line of text. The dialog owns its controller, so the controller is disposed only once the dialog has
/// left the tree; disposing it right after `showDialog` returns would leave the closing dialog using a dead controller.
class _NameDialog extends StatefulWidget {
  const _NameDialog({required this.title, required this.hint, required this.action});
  final String title;
  final String hint;
  final String action;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  final controller = TextEditingController();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: InputDecoration(hintText: widget.hint),
        onSubmitted: (v) => Navigator.pop(context, v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: Text(widget.action)),
      ],
    );
  }
}
