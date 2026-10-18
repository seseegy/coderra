import 'package:flutter_test/flutter_test.dart';

import 'editor_ui_suite.dart';
import 'files_ui_suite.dart';
import 'prompt_ui_suite.dart';

/// Every screen that works on project files, run against one kind of file access.
void fsScreensSuite(FsVariant variant) {
  setUpAll(variant.setUpAll);
  tearDownAll(variant.tearDownAll);
  filesUiSuite(variant);
  editorUiSuite(variant);
  promptAndNewChatSuite(variant);
}
