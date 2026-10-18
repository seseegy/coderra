import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:andropi/agent/agent_client.dart';

/// A host's file service in memory, with faults on demand: the connection dropping before a request arrives, or after it
/// was carried out but before the answer got back. It follows what agent/src/fs.ts does for `fs_write`, `fs_read` and
/// `fs_stat`, so RemoteFs can be tried against every way a transfer can be cut.
class FakeHost {
  final files = <String, Uint8List>{};
  final mtimes = <String, int>{};
  final uploads = <String, ({String path, BytesBuilder bytes})>{};
  var clock = 1000;
  final log = <String>[];

  /// Called with the request type and arguments; return 'before' to drop the connection before it is carried out, 'after'
  /// to carry it out and drop the answer, or null.
  String? Function(String type, Map<String, dynamic> args)? fault;
  var onlineCalls = 0;
  var wipeUploadsWhenBackOnline = false;
  Object? onlineError;

  Future<void> waitOnline() async {
    onlineCalls++;
    if (onlineError != null) throw onlineError!;
    if (wipeUploadsWhenBackOnline) uploads.clear();
  }

  Future<T> call<T>(String type, [Map<String, dynamic> args = const {}]) async {
    final f = fault?.call(type, args);
    log.add('$type${args['offset'] != null ? '@${args['offset']}' : ''}${args['abort'] == true ? ' abort' : ''}${args['status'] == true ? ' status' : ''}${f != null ? ' ($f)' : ''}');
    if (f == 'before') throw AgentError('The connection to the server was lost.', code: 'connection_lost');
    final result = _run(type, args);
    if (f == 'after') throw AgentError('The connection to the server was lost.', code: 'connection_lost');
    return result as T;
  }

  Object? _run(String type, Map<String, dynamic> a) {
    switch (type) {
      case 'fs_stat':
        final p = a['path'] as String;
        if (!files.containsKey(p)) return {'exists': false};
        return {'exists': true, 'type': 'file', 'size': files[p]!.length, 'mtime': mtimes[p]};
      case 'fs_read':
        final p = a['path'] as String;
        final data = files[p];
        if (data == null) throw AgentError('no such file', code: 'ENOENT');
        final off = a['offset'] as int;
        final end = min(data.length, off + (a['length'] as int));
        return {'data': base64Encode(data.sublist(off, end)), 'size': data.length, 'mtime': mtimes[p], 'eof': end >= data.length};
      case 'fs_write':
        final id = a['uploadId'] as String;
        if (a['abort'] == true) {
          uploads.remove(id);
          return {};
        }
        if (a['status'] == true) return {'received': uploads[id]?.bytes.length};
        final bytes = base64Decode(a['data'] as String);
        final offset = a['offset'] as int;
        if (offset == 0) {
          uploads[id] = (path: a['path'] as String, bytes: BytesBuilder());
        }
        final u = uploads[id];
        if (u == null) throw AgentError('No upload in progress for that file', code: 'bad_offset');
        if (u.bytes.length != offset) throw AgentError('Expected offset ${u.bytes.length}, got $offset', code: 'bad_offset');
        u.bytes.add(bytes);
        if (a['final'] != true) return {'received': u.bytes.length};
        files[u.path] = u.bytes.takeBytes();
        mtimes[u.path] = ++clock;
        uploads.remove(id);
        return {'size': files[u.path]!.length, 'mtime': mtimes[u.path]};
    }
    throw StateError('unexpected $type');
  }
}

Uint8List bytes(int n, [int seed = 1]) {
  final r = Random(seed);
  return Uint8List.fromList(List.generate(n, (_) => r.nextInt(256)));
}

