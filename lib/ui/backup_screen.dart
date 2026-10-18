import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../agent/agent_controller.dart';
import 'code_view.dart';
import 'kit.dart';
import 'theme.dart';
import 'transfer_dialog.dart';

/// Back up and restore sessions, skills, templates and settings as a zip.
class BackupScreen extends StatefulWidget {
  const BackupScreen({super.key, required this.agent, this.pickFile});
  final AgentController agent;

  /// Chooses a zip on the phone; tests replace the system file picker.
  final Future<String?> Function()? pickFile;

  @override
  State<BackupScreen> createState() => _BackupScreenState();
}

class _BackupScreenState extends State<BackupScreen> {
  /// Remembered for the app's lifetime so Restore defaults to it.
  static String? _lastBackup;

  late final _path = TextEditingController(text: _lastBackup ?? '');
  bool _includeWorkspace = false;
  bool _backingUp = false;
  bool _restoring = false;
  ({String path, int files, int bytes, int left})? _result;
  ({int files, int bytes, int tooLarge})? _estimate;

  /// A zip put on the server by "Choose file", to be removed again once it is restored.
  String? _uploaded;

  AgentController get agent => widget.agent;

  static String _mb(int bytes) => bytes < 1024 * 1024 ? '${(bytes / 1024).toStringAsFixed(0)} KB' : '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';

  @override
  void dispose() {
    _path.dispose();
    super.dispose();
  }

  void _snack(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  bool get _server => !agent.fs.isLocal;

  Future<void> _backup() async {
    setState(() => _backingUp = true);
    try {
      final r = await agent.features.backup(includeWorkspace: _includeWorkspace);
      _lastBackup = r.path;
      if (mounted) {
        setState(() {
          _result = r;
          _path.text = r.path;
        });
      }
    } catch (e) {
      _snack('$e');
    } finally {
      if (mounted) setState(() => _backingUp = false);
    }
  }

  /// With the workspace in, say how much that is before it is made: a big one is slow to make and slower to bring home.
  Future<void> _setIncludeWorkspace(bool on) async {
    setState(() {
      _includeWorkspace = on;
      _estimate = null;
    });
    if (!on) return;
    try {
      final e = await agent.features.backupEstimate(includeWorkspace: true);
      if (mounted && _includeWorkspace) setState(() => _estimate = e);
    } catch (_) {
      // Only a hint; making the backup will say what is wrong.
    }
  }

  /// Brings the backup that was made on the server to this phone, and puts it in Downloads.
  Future<void> _download() async {
    final r = _result;
    if (r == null) return;
    final local = await runTransfer<String>(
      context,
      title: 'Downloading the backup',
      task: (h) => agent.fs.toPhoneFile(r.path, onProgress: h.onProgress, cancel: h.cancel),
    );
    if (local == null) return;
    try {
      _snack('Saved to ${await agent.client.saveToDownloads(local)}');
    } catch (e) {
      _snack('$e');
    }
  }

  Future<void> _choose() async {
    try {
      final picked = widget.pickFile != null
          ? await widget.pickFile!()
          : (await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['zip'])).firstOrNull?.path;
      if (picked == null || !mounted) return;
      if (!_server) {
        setState(() => _path.text = picked);
        return;
      }
      // The backup has to be where the agent is: put it on the server, restore from there.
      final name = picked.split('/').last;
      final dir = '${agent.info['workspace'] ?? ''}/backups';
      final target = '$dir/.restore-$name';
      final ok = await runTransfer<bool>(
        context,
        title: 'Sending $name',
        task: (h) async {
          await agent.fs.mkdir(dir);
          await agent.fs.upload(picked, target, onProgress: h.onProgress, cancel: h.cancel);
          return true;
        },
      );
      if (ok == true && mounted) {
        await _dropUploaded();
        setState(() {
          _uploaded = target;
          _path.text = target;
        });
      }
    } catch (e) {
      _snack('$e');
    }
  }

  Future<void> _dropUploaded() async {
    final u = _uploaded;
    _uploaded = null;
    if (u != null) await agent.fs.delete(u).catchError((Object _) {});
  }

  Future<void> _restore() async {
    final path = _path.text.trim();
    if (path.isEmpty) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Restore backup?'),
        content: const Text(
          'Sessions, skills, templates and settings are overwritten with the backup\'s copies. '
          'This cannot be undone.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Restore')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _restoring = true);
    try {
      final r = await agent.features.restoreBackup(path);
      if (path == _uploaded) await _dropUploaded();
      if (mounted && r.skippedCount > 0) {
        await showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('Restored ${r.restored} ${r.restored == 1 ? 'file' : 'files'}'),
            content: SingleChildScrollView(
              child: Text('${r.skippedCount} could not be restored:\n\n${r.skipped.join('\n')}${r.skippedCount > r.skipped.length ? '\n…' : ''}'),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
          ),
        );
      } else {
        _snack('Restored ${r.restored} ${r.restored == 1 ? 'file' : 'files'}');
      }
    } catch (e) {
      _snack('$e');
    } finally {
      if (mounted) setState(() => _restoring = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final text = Theme.of(context).textTheme;
    final r = _result;
    return Scaffold(
      appBar: AppBar(title: const Text('Backup & restore')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 40),
        children: [
          const SectionLabel('Back up', padding: EdgeInsets.fromLTRB(4, 8, 4, 10)),
          SurfaceCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    IconTile(icon: LucideIcons.archive, color: p.accent),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Sessions, skills, templates, schedules and settings in one zip.',
                        style: text.bodyMedium,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _includeWorkspace,
                  onChanged: _backingUp ? null : _setIncludeWorkspace,
                  title: Text('Include workspace files', style: text.titleSmall),
                  subtitle: Text(
                    _estimate == null
                        ? 'Your project folders too; the zip can get large.'
                        : '${_estimate!.files} files · ${_mb(_estimate!.bytes)}${_estimate!.tooLarge > 0 ? ' · ${_estimate!.tooLarge} too big to include' : ''}${_server && _estimate!.bytes > 200 * 1024 * 1024 ? '\nA big one: bringing it to this phone will take a while.' : ''}',
                    style: text.bodySmall,
                  ),
                ),
                const SizedBox(height: 8),
                PrimaryButton(label: 'Create backup', icon: LucideIcons.download, busy: _backingUp, onPressed: _backup),
                if (r != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
                    decoration: BoxDecoration(color: p.raised, borderRadius: BorderRadius.circular(14)),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('${r.files} files · ${_mb(r.bytes)}${r.left > 0 ? ' · ${r.left} left out (too big, or links)' : ''}', style: text.labelSmall),
                              const SizedBox(height: 2),
                              SelectableText(
                                r.path,
                                style: text.bodySmall?.copyWith(fontFamily: mono, color: p.text),
                              ),
                            ],
                          ),
                        ),
                        CopyButton(text: r.path, showLabel: false),
                      ],
                    ),
                  ),
                  if (_server)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: _download,
                        icon: const Icon(LucideIcons.smartphone, size: 16),
                        label: const Text('Download to this phone'),
                      ),
                    ),
                ],
                const SizedBox(height: 12),
                Row(
                  children: [
                    Icon(LucideIcons.keyRound, size: 14, color: p.muted),
                    const SizedBox(width: 6),
                    Expanded(child: Text('Provider keys and tokens are not included.', style: text.bodySmall)),
                  ],
                ),
              ],
            ),
          ),
          const SectionLabel('Restore'),
          SurfaceCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    IconTile(icon: LucideIcons.archiveRestore, color: p.warning),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        _server ? 'Enter the path of a backup zip on the server, or choose one from your phone: it is sent to the server first.' : 'Enter the path of a backup zip, or choose one from your phone.',
                        style: text.bodyMedium,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _path,
                  autocorrect: false,
                  onChanged: (_) => setState(() {}),
                  style: const TextStyle(fontFamily: mono, fontSize: 13),
                  decoration: const InputDecoration(labelText: 'Backup file', hintText: '/…/coderra-backup.zip'),
                ),
                const SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: _restoring ? null : _choose,
                    icon: const Icon(LucideIcons.folderOpen, size: 16),
                    label: const Text('Choose file'),
                  ),
                ),
                const SizedBox(height: 8),
                PrimaryButton(
                  label: 'Restore',
                  icon: LucideIcons.rotateCcw,
                  busy: _restoring,
                  onPressed: _path.text.trim().isEmpty ? null : _restore,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
