import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'agent_client.dart' show AgentError;
import 'agent_fs.dart';

/// How [RemoteFs] reaches the host: `AgentClient.call` has exactly this shape.
typedef FsCall = Future<T> Function<T>(String type, [Map<String, dynamic> args]);

/// The agent runs on a server: every operation is an `fs_*` command to the host (agent/src/fs.ts).
///
/// File contents travel as base64 chunks, so no single message gets large, and a write only becomes visible at its
/// path when the last chunk has arrived. Failures come back as [AgentError] with a `code` (`ENOENT`, `EEXIST`,
/// `outside_root`, `read_only`, ...); a refused save is an [FsConflictException], like [LocalFs] throws.
class RemoteFs implements AgentFs {
  RemoteFs(
    this._call, {
    required this.phoneCache,
    this.chunkSize = 192 * 1024,
    this.maxRead = 64 * 1024 * 1024,
    this.waitOnline,
  }) : assert(chunkSize > 0 && chunkSize <= 256 * 1024, 'the host serves at most 256 KB per read');

  final FsCall _call;

  @override
  bool get isLocal => false;

  /// A folder on the phone for files fetched by [toPhoneFile].
  final Directory phoneCache;

  /// Bytes per request. The host caps reads at 256 KB; base64 adds a third on the wire.
  final int chunkSize;

  /// Refuse to pull a bigger file into memory with [read].
  final int maxRead;

  /// Called when the connection to the server drops in the middle of a transfer: resolves once it is back (or throws if
  /// it will not come back). Without it a dropped connection ends the transfer; with it the transfer carries on from
  /// where it was.
  final Future<void> Function()? waitOnline;

  static final _random = Random();

  // -------------------------------------------------------------------------
  // Reading

  @override
  Future<List<FsEntry>> list(String path, {bool detectGit = false}) async {
    final rows = await _call<List>('fs_list', {'path': path, 'detectGit': detectGit});
    return [
      for (final r in rows.cast<Map>())
        FsEntry(
          path: joinPath(path, r['name'] as String),
          type: _type(r['type'] as String?),
          size: (r['size'] as num).toInt(),
          modified: DateTime.fromMillisecondsSinceEpoch((r['mtime'] as num).toInt()),
          isLink: r['link'] == true,
          isGit: r['git'] == true,
        ),
    ];
  }

  @override
  Future<FsStat> stat(String path) async {
    final r = (await _call<Map>('fs_stat', {'path': path})).cast<String, dynamic>();
    if (r['exists'] != true) return const FsStat.missing();
    return FsStat(
      type: _type(r['type'] as String?),
      size: (r['size'] as num).toInt(),
      modified: DateTime.fromMillisecondsSinceEpoch((r['mtime'] as num).toInt()),
    );
  }

  @override
  Future<bool> exists(String path) async => (await stat(path)).exists;

  @override
  Future<Uint8List> read(String path) async {
    final out = BytesBuilder(copy: false);
    await _stream(path, (bytes) async => out.add(bytes), () async => out.clear());
    return out.takeBytes();
  }

  @override
  Future<String> readString(String path) async => utf8.decode(await read(path));

  static bool _lost(AgentError e) => e.code == 'connection_lost' || e.code == 'offline';

  /// Runs one request, and if the connection drops meanwhile waits for it to come back and tries again. For requests
  /// that can safely be repeated (reads).
  Future<T> _again<T>(Future<T> Function() request) async {
    for (var attempt = 0;; attempt++) {
      try {
        return await request();
      } on AgentError catch (e) {
        if (!_lost(e) || waitOnline == null || attempt >= 30) rethrow;
        await waitOnline!();
      }
    }
  }

  /// Reads a file front to back. If it changes while being read (the size or modification time differs between
  /// chunks) the read starts over, a few times, rather than returning a mix of two versions. A dropped connection is
  /// waited out and the read goes on from the same place. [limit] false is for streaming to disk, where the size does
  /// not matter; [onProgress] and [cancel] are for the user.
  Future<void> _stream(
    String path,
    Future<void> Function(Uint8List) add,
    Future<void> Function() reset, {
    bool limit = true,
    Progress? onProgress,
    CancelToken? cancel,
  }) async {
    for (var attempt = 0; attempt < 3; attempt++) {
      await reset();
      var offset = 0;
      int? size;
      int? mtime;
      var changed = false;
      while (true) {
        cancel?.check();
        final at = offset;
        final r = (await _again(() => _call<Map>('fs_read', {'path': path, 'offset': at, 'length': chunkSize}))).cast<String, dynamic>();
        final s = (r['size'] as num).toInt();
        final m = (r['mtime'] as num).toInt();
        if (size == null) {
          if (limit && s > maxRead) throw AgentError('${baseName(path)} is too large to open (${s ~/ (1024 * 1024)} MB)', code: 'too_large');
          size = s;
          mtime = m;
        } else if (s != size || m != mtime) {
          changed = true;
          break;
        }
        final bytes = base64Decode(r['data'] as String);
        if (bytes.isEmpty && r['eof'] != true) {
          changed = true; // the file shrank under us
          break;
        }
        await add(bytes);
        offset += bytes.length;
        onProgress?.call(offset, size);
        if (r['eof'] == true) break;
      }
      if (!changed) return;
    }
    throw AgentError('${baseName(path)} kept changing while it was being read', code: 'conflict');
  }

  // -------------------------------------------------------------------------
  // Writing

  @override
  Future<FsStat> write(String path, Uint8List data, {DateTime? expectModified}) => _send(
    path,
    data.length,
    (offset, length) async => Uint8List.sublistView(data, offset, offset + length),
    expectModified,
  );

  @override
  Future<FsStat> writeString(String path, String text, {DateTime? expectModified}) =>
      write(path, Uint8List.fromList(utf8.encode(text)), expectModified: expectModified);

  /// Sends [total] bytes in chunks. The host stages them and moves the file into place after the last one.
  ///
  /// If the connection drops the transfer waits for it and asks the host how much of the upload it has, so no chunk is
  /// sent twice or skipped; if the host has lost the upload (it restarted) the file is sent again from the start.
  Future<FsStat> _send(
    String path,
    int total,
    Future<Uint8List> Function(int offset, int length) chunk,
    DateTime? expectModified, {
    Progress? onProgress,
    CancelToken? cancel,
  }) async {
    final before = waitOnline == null ? null : await stat(path).then<FsStat?>((s) => s, onError: (Object _) => null);
    for (var restarts = 0;; restarts++) {
      try {
        return await _sendOnce(path, total, chunk, expectModified, before, onProgress, cancel);
      } on _UploadLost {
        if (restarts >= 2) throw AgentError('The upload of ${baseName(path)} kept being lost on the server', code: 'connection_lost');
      }
    }
  }

  Future<FsStat> _sendOnce(
    String path,
    int total,
    Future<Uint8List> Function(int offset, int length) chunk,
    DateTime? expectModified,
    FsStat? before,
    Progress? onProgress,
    CancelToken? cancel,
  ) async {
    final id = _newUploadId();
    var finished = false;
    try {
      var offset = 0;
      while (true) {
        cancel?.check();
        final length = min(chunkSize, total - offset);
        final bytes = length == 0 ? Uint8List(0) : await chunk(offset, length);
        final last = offset + length >= total;
        final args = {
          'path': path,
          'data': base64Encode(bytes),
          'offset': offset,
          'final': last,
          'uploadId': id,
          'expectMtime': ?expectModified?.millisecondsSinceEpoch,
        };
        final r = await _chunk(id, path, total, offset, length, last, args, before);
        offset += length;
        onProgress?.call(offset, total);
        if (last) {
          finished = true;
          return FsStat(
            type: FsType.file,
            size: (r['size'] as num).toInt(),
            modified: DateTime.fromMillisecondsSinceEpoch((r['mtime'] as num).toInt()),
          );
        }
      }
    } on AgentError catch (e) {
      // The host drops what it had staged when a chunk fails for its own reasons; a lost connection is different.
      if (!_lost(e)) finished = true;
      if (e.code == 'conflict') throw FsConflictException(path);
      rethrow;
    } finally {
      // Anything else (a cancel, a failed read of the phone file, a connection that did not come back) leaves a staged file.
      if (!finished) unawaited(_abort(id));
    }
  }

  /// One chunk. When the connection drops while it is in flight nobody knows whether it arrived: ask the host.
  Future<Map<String, dynamic>> _chunk(
    String id,
    String path,
    int total,
    int offset,
    int length,
    bool last,
    Map<String, dynamic> args,
    FsStat? before,
  ) async {
    while (true) {
      try {
        return (await _call<Map>('fs_write', args)).cast<String, dynamic>();
      } on AgentError catch (e) {
        if (!_lost(e) || waitOnline == null) rethrow;
        await waitOnline!();
        final where = (await _again(() => _call<Map>('fs_write', {'uploadId': id, 'status': true}))).cast<String, dynamic>();
        final received = (where['received'] as num?)?.toInt();
        if (received == offset) continue; // it did not arrive: send it again
        if (received == offset + length && !last) return {'received': received}; // it did, only the answer was lost
        if (received == null && last) {
          // Either the last chunk arrived and the file is in place, or the upload is gone. The file tells which.
          final now = await _again(() => stat(path));
          if (now.exists && now.size == total && (before == null || !before.exists || now.modified != before.modified || before.size != total)) {
            return {'size': now.size, 'mtime': now.modified!.millisecondsSinceEpoch};
          }
        }
        throw _UploadLost();
      }
    }
  }

  Future<void> _abort(String id) async {
    try {
      await _call<Object?>('fs_write', {'uploadId': id, 'abort': true});
    } catch (_) {
      // Best effort; the host sweeps abandoned uploads anyway.
    }
  }

  static String _newUploadId() =>
      '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${_random.nextInt(1 << 32).toRadixString(36)}';

  @override
  Future<void> createFile(String path) async {
    if (await exists(path)) return;
    await mkdir(parentPath(path));
    await write(path, Uint8List(0));
  }

  @override
  Future<void> mkdir(String path) async {
    await _call<Object?>('fs_mkdir', {'path': path, 'recursive': true});
  }

  /// The host refuses to move onto an existing name (`EEXIST`); check first if that matters.
  @override
  Future<void> rename(String from, String to) async {
    await _call<Object?>('fs_rename', {'from': from, 'to': to});
  }

  /// The host refuses to copy onto an existing name (`EEXIST`); check first if that matters.
  @override
  Future<void> copy(String from, String to) async {
    await _call<Object?>('fs_copy', {'from': from, 'to': to});
  }

  @override
  Future<void> delete(String path, {bool recursive = false}) async {
    await _call<Object?>('fs_delete', {'path': path, 'recursive': recursive});
  }

  // -------------------------------------------------------------------------
  // Between phone and server

  @override
  Future<void> upload(String phonePath, String targetPath, {Progress? onProgress, CancelToken? cancel}) async {
    final file = await File(phonePath).open();
    try {
      final total = await file.length();
      await _send(targetPath, total, (offset, length) async {
        await file.setPosition(offset);
        return file.read(length);
      }, null, onProgress: onProgress, cancel: cancel);
    } finally {
      await file.close();
    }
  }

  final _downloads = <String, Future<String>>{};

  @override
  Future<String> toPhoneFile(String path, {Progress? onProgress, CancelToken? cancel}) async {
    final st = await _again(() => stat(path));
    if (!st.exists) throw AgentError('${baseName(path)} does not exist', code: 'ENOENT');
    if (st.isDir) throw AgentError('${baseName(path)} is a folder', code: 'EISDIR');
    // Keyed by where it is and what version it is, so an unchanged file is not fetched twice.
    final key = '${_fnv1a(path).toRadixString(16)}-${st.modified!.millisecondsSinceEpoch}-${st.size}';
    final dir = Directory('${phoneCache.path}/remote/$key');
    final file = File('${dir.path}/${baseName(path)}');
    if (await file.exists() && await file.length() == st.size) {
      onProgress?.call(st.size, st.size);
      return file.path;
    }
    // Two askers for the same version share one download (they would write the same partial file).
    final running = _downloads[key];
    if (running != null) return running;
    final job = () async {
      await dir.create(recursive: true);
      final part = File('${file.path}.part');
      final sink = await part.open(mode: FileMode.write);
      try {
        await _stream(
          path,
          (bytes) async {
            await sink.writeFrom(bytes);
          },
          () async {
            await sink.setPosition(0);
            await sink.truncate(0);
          },
          limit: false,
          onProgress: onProgress,
          cancel: cancel,
        );
        await sink.close();
        await part.rename(file.path);
        return file.path;
      } catch (_) {
        await sink.close().catchError((Object _) {});
        if (await part.exists()) await part.delete();
        rethrow;
      }
    }();
    _downloads[key] = job;
    try {
      return await job;
    } finally {
      unawaited(_downloads.remove(key));
    }
  }

  static FsType _type(String? t) => switch (t) {
    'dir' => FsType.dir,
    'file' => FsType.file,
    _ => FsType.missing,
  };

  /// A hash that is the same on every run (String.hashCode makes no such promise).
  static int _fnv1a(String s) {
    var h = 0xcbf29ce484222325;
    for (final b in utf8.encode(s)) {
      h = ((h ^ b) * 0x100000001b3) & 0x7fffffffffffffff;
    }
    return h;
  }
}

/// The host no longer has the upload in progress (it was restarted): the file has to be sent again.
class _UploadLost implements Exception {}
