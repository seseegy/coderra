import 'dart:io';

import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/agent_fs.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/files_ui_suite.dart';
import 'support/fs_screens_suite.dart';

/// The file screens on the phone's own disk.
class LocalVariant extends FsVariant {
  @override
  Directory makeDir() => Directory.systemTemp.createTempSync('files_ui_test_');

  /// An agent whose platform channels are stubbed: no host process, phone storage not granted.
  @override
  Future<AgentFs> makeFs() async => const LocalFs();

  @override
  Future<AgentController> makeAgent(WidgetTester tester, Directory dir) async {
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent/events'), (_) async => null);
    messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent'), (call) async {
      if (call.method == 'storageAccess') return {'available': true, 'granted': false, 'root': '/storage/emulated/0'};
      return null;
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent/events'), null);
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent'), null);
    });
    return AgentController(AgentClient())..info = {'workspace': dir.path};
  }
}

void main() => fsScreensSuite(LocalVariant());
