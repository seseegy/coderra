import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show ChangeNotifier;

/// What a path points at. Symbolic links are resolved: a link to a folder is [dir], a broken link is [missing].
enum FsType { file, dir, missing }

/// One entry of a listed folder.
class FsEntry {
  const FsEntry({
    required this.path,
    required this.type,
    required this.size,
    required this.modified,
    this.isLink = false,
    this.isGit = false,
  });

  final String path;
  final FsType type;
  final int size;
  final DateTime modified;

  /// The entry itself is a symbolic link (its [type] is that of the target).
  final bool isLink;

  /// A folder that contains a `.git` folder. Only filled in when the listing asked for it.
  final bool isGit;

  String get name => baseName(path);
  bool get isDir => type == FsType.dir;
}

class FsStat {
  const FsStat({required this.type, required this.size, required this.modified});

  const FsStat.missing() : type = FsType.missing, size = -1, modified = null;

  final FsType type;
  final int size;
  final DateTime? modified;

  bool get exists => type != FsType.missing;
  bool get isDir => type == FsType.dir;
}

/// The files on the machine the agent works on: the project folders and what is inside them.
///
/// Screens use this instead of `dart:io` so the same code can browse and edit files that live on the phone
/// ([LocalFs]) or on a server ([RemoteFs], later). Files that always belong to the phone itself (a photo picked
/// for attaching, the share sheet, app settings) keep using `dart:io`.
///
/// All paths are absolute paths on the agent's machine, with `/` separators.
abstract class AgentFs {
  /// Whether the files are on this phone. Things that only make sense for files the phone itself can open (a web page
  /// finding its images by path) check this.
  bool get isLocal;

  /// Entries directly inside [path], in no particular order. With [detectGit], folders get [FsEntry.isGit].
  Future<List<FsEntry>> list(String path, {bool detectGit = false});

  Future<FsStat> stat(String path);

  /// Whether anything exists at [path] (a broken symbolic link counts as not existing).
  Future<bool> exists(String path);

  Future<Uint8List> read(String path);

  /// UTF-8 text; throws if the bytes are not valid UTF-8.
  Future<String> readString(String path);

  /// Replaces the file's contents and returns its new [FsStat]. With [expectModified] (the modification time the
  /// caller last saw), the write is refused with an [FsConflictException] if the file has changed since, or is gone.
  Future<FsStat> write(String path, Uint8List data, {DateTime? expectModified});

  Future<FsStat> writeString(String path, String text, {DateTime? expectModified});

  /// Creates an empty file (and missing parent folders). An existing file is left alone.
  Future<void> createFile(String path);

  /// Creates a folder and any missing parents.
  Future<void> mkdir(String path);

  /// Moves a file or folder. Moving onto a name that already exists is not defined (a [LocalFs] may replace a file,
  /// a [RemoteFs] refuses): check with [exists] first.
  Future<void> rename(String from, String to);

  /// Copies a file, or a whole folder with everything in it. Same rule about an existing [to] as [rename].
  Future<void> copy(String from, String to);

  Future<void> delete(String path, {bool recursive = false});

  /// Puts a file from the phone at [targetPath] on the agent's machine. [onProgress] hears about it as it goes; with
  /// [cancel] the transfer can be stopped (it then throws [Cancelled] and nothing is left at [targetPath]).
  Future<void> upload(String phonePath, String targetPath, {Progress? onProgress, CancelToken? cancel});

  /// A path on the phone that holds the contents of [path], for the share sheet and "save to Downloads".
  /// For [LocalFs] that is [path] itself. Same [onProgress] and [cancel] as [upload].
  Future<String> toPhoneFile(String path, {Progress? onProgress, CancelToken? cancel});
}

/// Progress of a copy between the phone and the agent's machine: bytes done of bytes in all.
typedef Progress = void Function(int done, int total);

/// Lets the user stop a transfer that is under way. Checked between pieces; a stopped transfer throws [Cancelled] and
/// leaves nothing half-finished at the destination.
class CancelToken extends ChangeNotifier {
  bool _cancelled = false;

  bool get cancelled => _cancelled;

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    notifyListeners();
  }

  void check() {
    if (_cancelled) throw const Cancelled();
  }
}

class Cancelled implements Exception {
  const Cancelled();

  @override
  String toString() => 'Cancelled';
}

/// A save was refused because the file changed (or disappeared) after it was read.
class FsConflictException implements Exception {
  const FsConflictException(this.path);
  final String path;

  @override
  String toString() => '${baseName(path)} changed since it was opened';
}

/// The agent runs on this phone: plain `dart:io`.
class LocalFs implements AgentFs {
  const LocalFs();

  @override
  bool get isLocal => true;

  @override
  Future<List<FsEntry>> list(String path, {bool detectGit = false}) async {
    final out = <FsEntry>[];
    await for (final e in Directory(path).list(followLinks: false)) {
      // stat() follows links, so a link to a folder lists as a folder.
      final stat = await e.stat();
      final type = switch (stat.type) {
        FileSystemEntityType.directory => FsType.dir,
        FileSystemEntityType.notFound => FsType.missing,
        _ => FsType.file,
      };
      final isDir = type == FsType.dir;
      out.add(
        FsEntry(
          path: e.path,
          type: type,
          size: stat.size,
          modified: stat.modified,
          isLink: e is Link,
          isGit: detectGit && isDir && await Directory('${e.path}/.git').exists(),
        ),
      );
    }
    return out;
  }

  @override
  Future<FsStat> stat(String path) async {
    final s = await FileStat.stat(path);
    return switch (s.type) {
      FileSystemEntityType.notFound => const FsStat.missing(),
      FileSystemEntityType.directory => FsStat(type: FsType.dir, size: s.size, modified: s.modified),
      _ => FsStat(type: FsType.file, size: s.size, modified: s.modified),
    };
  }

  @override
  Future<bool> exists(String path) async => await FileSystemEntity.type(path) != FileSystemEntityType.notFound;

  @override
  Future<Uint8List> read(String path) => File(path).readAsBytes();

  @override
  Future<String> readString(String path) => File(path).readAsString();

  /// Modification times are compared to the millisecond, the precision the server side reports too.
  Future<void> _checkUnchanged(String path, DateTime? expected) async {
    if (expected == null) return;
    final s = await stat(path);
    if (!s.exists || s.modified!.millisecondsSinceEpoch != expected.millisecondsSinceEpoch) {
      throw FsConflictException(path);
    }
  }

  @override
  Future<FsStat> write(String path, Uint8List data, {DateTime? expectModified}) async {
    await _checkUnchanged(path, expectModified);
    await File(path).writeAsBytes(data);
    return stat(path);
  }

  @override
  Future<FsStat> writeString(String path, String text, {DateTime? expectModified}) async {
    await _checkUnchanged(path, expectModified);
    await File(path).writeAsString(text);
    return stat(path);
  }

  @override
  Future<void> createFile(String path) async {
    await File(path).create(recursive: true);
  }

  @override
  Future<void> mkdir(String path) async {
    await Directory(path).create(recursive: true);
  }

  @override
  Future<void> rename(String from, String to) async {
    if (await FileSystemEntity.isDirectory(from)) {
      await Directory(from).rename(to);
    } else {
      await File(from).rename(to);
    }
  }

  @override
  Future<void> copy(String from, String to) async {
    if (await FileSystemEntity.isDirectory(from)) {
      await _copyDir(Directory(from), Directory(to));
    } else {
      await File(from).copy(to);
    }
  }

  Future<void> _copyDir(Directory from, Directory to) async {
    await to.create(recursive: true);
    await for (final child in from.list(followLinks: false)) {
      final dest = joinPath(to.path, baseName(child.path));
      if (child is Directory) {
        await _copyDir(child, Directory(dest));
      } else if (child is File) {
        await child.copy(dest);
      } else if (child is Link) {
        await Link(dest).create(await child.target());
      }
    }
  }

  @override
  Future<void> delete(String path, {bool recursive = false}) async {
    if (await FileSystemEntity.isDirectory(path)) {
      await Directory(path).delete(recursive: recursive);
    } else {
      await File(path).delete();
    }
  }

  @override
  Future<void> upload(String phonePath, String targetPath, {Progress? onProgress, CancelToken? cancel}) async {
    cancel?.check();
    final total = await File(phonePath).length();
    await File(phonePath).copy(targetPath);
    onProgress?.call(total, total);
  }

  @override
  Future<String> toPhoneFile(String path, {Progress? onProgress, CancelToken? cancel}) async {
    cancel?.check();
    if (!await File(path).exists()) throw PathNotFoundException(path, const OSError('Not a file'));
    return path;
  }
}

/// UTF-8 decoding that never throws, for showing files that may not be clean text.
String decodeLenient(List<int> bytes) => utf8.decode(bytes, allowMalformed: true);

/// The last segment of a `/` path, ignoring a trailing slash.
String baseName(String path) {
  final trimmed = path.length > 1 && path.endsWith('/') ? path.substring(0, path.length - 1) : path;
  return trimmed.substring(trimmed.lastIndexOf('/') + 1);
}

/// Everything before the last segment; `/` for a top-level path.
String parentPath(String path) {
  final trimmed = path.length > 1 && path.endsWith('/') ? path.substring(0, path.length - 1) : path;
  final i = trimmed.lastIndexOf('/');
  if (i < 0) return '.';
  if (i == 0) return '/';
  return trimmed.substring(0, i);
}

/// A name next to [path] that nothing uses yet: `a copy.txt`, then `a copy 2.txt`, ...
Future<String> freeCopyPath(AgentFs fs, String path) async {
  final name = baseName(path);
  final dot = name.lastIndexOf('.');
  final stem = dot > 0 ? name.substring(0, dot) : name;
  final ext = dot > 0 ? name.substring(dot) : '';
  final dir = parentPath(path);
  for (var n = 1;; n++) {
    final candidate = joinPath(dir, '$stem copy${n > 1 ? ' $n' : ''}$ext');
    if (!await fs.exists(candidate)) return candidate;
  }
}

String joinPath(String dir, String name) => dir.endsWith('/') ? '$dir$name' : '$dir/$name';
