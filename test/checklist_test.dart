import 'package:andropi/agent/agent_client.dart';
import 'package:andropi/agent/agent_controller.dart';
import 'package:andropi/agent/features.dart';
import 'package:andropi/agent/models.dart';
import 'package:andropi/ui/chat_extras.dart';
import 'package:andropi/ui/kit.dart';
import 'package:andropi/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// The `tasks` tool on the app side: what the records look like, what the card shows, how a call is summarised.
Map<String, dynamic> record(String session, List<Map<String, dynamic>> items) => {
  'type': 'tasks',
  'sessionId': session,
  'items': items,
  'counts': {},
};

Map<String, dynamic> item(String id, String title, [String status = 'todo', String? note]) => {
  'id': id,
  'title': title,
  'status': status,
  'note': ?note,
};

void main() {
  group('TaskList', () {
    test('reads the host record and counts', () {
      final list = TaskList.fromJson(
        record('s1', [
          item('t1', 'a', 'done'),
          item('t2', 'b', 'in_progress'),
          item('t3', 'c', 'blocked', 'no key'),
          item('t4', 'd'),
        ]),
      );
      expect(list.sessionId, 's1');
      expect([list.total, list.done, list.blocked], [4, 1, 1]);
      expect(list.active?.id, 't2');
      expect(list.complete, isFalse);
      expect(list.items[2].status, TaskStatus.blocked);
      expect(list.items[2].note, 'no key');
      expect(list.items[3].note, isNull);
    });

    test('an unknown status counts as todo, and a list can be empty', () {
      expect(TaskList.fromJson(record('s', [item('t1', 'a', 'whatever')])).items.single.status, TaskStatus.todo);
      final none = TaskList.fromJson({'sessionId': 's'});
      expect(none.items, isEmpty);
      expect(none.complete, isFalse, reason: 'nothing written down is not the same as done');
      expect(none.active, isNull);
    });

    test('complete means everything is done', () {
      expect(TaskList.fromJson(record('s', [item('t1', 'a', 'done'), item('t2', 'b', 'done')])).complete, isTrue);
      expect(TaskList.fromJson(record('s', [item('t1', 'a', 'done'), item('t2', 'b', 'blocked')])).complete, isFalse);
    });
  });

  group('Features', () {
    late Features features;
    setUp(() {
      TestWidgetsFlutterBinding.ensureInitialized();
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent/events'), (_) async => null);
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent'), (_) async => null);
      features = Features(AgentClient());
    });
    tearDown(() {
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent/events'), null);
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent'), null);
    });

    test('keeps one checklist per chat and replaces it when a newer one arrives', () {
      var notified = 0;
      features.addListener(() => notified++);
      features.handleRecord(record('a', [item('t1', 'first')]));
      features.handleRecord(record('b', [item('t1', 'other chat')]));
      features.handleRecord(record('a', [item('t1', 'first', 'done')]));
      expect(features.tasksFor('a')!.items.single.status, TaskStatus.done);
      expect(features.tasksFor('b')!.items.single.title, 'other chat');
      expect(features.tasksFor('c'), isNull);
      expect(features.tasksFor(null), isNull);
      expect(notified, 3);
    });

    test('remembers a limited number of chats, dropping the one not touched for longest', () {
      for (var i = 0; i < 25; i++) {
        features.handleRecord(record('s$i', [item('t1', 'x')]));
      }
      features.handleRecord(record('s3', [item('t1', 'x', 'done')])); // touched again
      features.handleRecord(record('s25', [item('t1', 'x')]));
      expect(features.tasksFor('s0'), isNull);
      expect(features.tasksFor('s3'), isNotNull, reason: 'a chat in use is kept');
      expect(features.tasksFor('s24'), isNotNull);
      expect(features.tasksFor('s25'), isNotNull);
    });
  });

  group('tool card', () {
    test('summarises a sub-agent call by its role and job', () {
      String? sum(Map<String, dynamic> args) => toolSummary('subagent', args);
      expect(sum({'task': 'Find where login is handled', 'title': 'Find login'}), 'explorer: Find login');
      expect(sum({'task': 'Add a test\nfor foo', 'role': 'worker'}), 'worker: Add a test');
      expect(sum({'role': 'worker'}), '{"role":"worker"}', reason: 'while the arguments are still streaming in');
      expect(toolIcon('subagent'), isNot(toolIcon('nope')));
    });

    test('summarises what a tasks call does', () {
      String? sum(Map<String, dynamic> args) => toolSummary('tasks', args);
      expect(sum({'action': 'set', 'items': List.filled(4, {'title': 'x'})}), 'set 4 tasks');
      expect(sum({'action': 'set', 'items': [{}]}), 'set 1 task');
      expect(sum({'action': 'set'}), 'set', reason: 'while the arguments are still streaming in');
      expect(sum({'action': 'add', 'title': 'write docs'}), 'add write docs');
      expect(sum({'action': 'update', 'id': 't2', 'status': 'done'}), 't2 → done');
      expect(sum({'action': 'update', 'id': 't2', 'title': 'new'}), 't2 renamed');
      expect(sum({'action': 'remove', 'id': 't3'}), 'remove t3');
      expect(sum({'action': 'list'}), 'list');
      // Nothing useful yet: falls back to the raw arguments.
      expect(sum({'foo': 1}), '{"foo":1}');
    });

    test('has its own icon', () {
      expect(toolIcon('tasks'), LucideIcons.listChecks);
    });
  });

  group('ChecklistCard', () {
    late AgentController agent;

    Future<void> show(WidgetTester tester, {String session = 's1'}) async {
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent/events'), (_) async => null);
      messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent'), (_) async => null);
      addTearDown(() {
        messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent/events'), null);
        messenger.setMockMethodCallHandler(const MethodChannel('andropi/agent'), null);
      });
      agent = AgentController(AgentClient())..sessionId = session;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTheme(Brightness.light),
          home: Scaffold(body: Column(children: [ChecklistCard(agent: agent)])),
        ),
      );
    }

    Future<void> send(WidgetTester tester, String session, List<Map<String, dynamic>> items) async {
      agent.features.handleRecord(record(session, items));
      await tester.pump();
    }

    testWidgets('shows nothing until the agent has made a list, and nothing for another chat\'s list', (tester) async {
      await show(tester);
      expect(find.text('Checklist'), findsNothing);
      await send(tester, 's1', []);
      expect(find.text('Checklist'), findsNothing, reason: 'an empty list is not worth a card');
      await send(tester, 'other-chat', [item('t1', 'not mine')]);
      expect(find.text('Checklist'), findsNothing);
      expect(find.text('not mine'), findsNothing);
    });

    testWidgets('collapsed it shows progress and what the agent is on; opened it shows every task and note', (tester) async {
      await show(tester);
      await send(tester, 's1', [
        item('t1', 'set up project', 'done'),
        item('t2', 'write the parser', 'in_progress'),
        item('t3', 'deploy it', 'blocked', 'needs a server key'),
        item('t4', 'write docs'),
      ]);
      expect(find.text('Checklist'), findsOneWidget);
      expect(find.text('1/4'), findsOneWidget);
      expect(find.text('write the parser'), findsOneWidget, reason: 'the task in progress, as the subtitle');
      expect(find.text('set up project'), findsNothing);
      expect(find.text('needs a server key'), findsNothing);
      final bar = tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator));
      expect(bar.value, 0.25);

      await tester.tap(find.text('Checklist'));
      await tester.pump();
      for (final text in ['set up project', 'write the parser', 'deploy it', 'needs a server key', 'write docs']) {
        expect(find.text(text), findsOneWidget, reason: text);
      }
      // One icon per kind of state.
      expect(find.byIcon(LucideIcons.circleCheck), findsOneWidget);
      expect(find.byIcon(LucideIcons.triangleAlert), findsOneWidget);
      expect(find.byIcon(LucideIcons.circle), findsOneWidget);
      expect(find.byIcon(LucideIcons.circleDot), findsOneWidget, reason: 'in progress, but the agent is idle');
      final done = tester.widget<Text>(find.text('set up project'));
      expect(done.style?.decoration, TextDecoration.lineThrough);

      await tester.tap(find.text('Checklist'));
      await tester.pump();
      expect(find.text('deploy it'), findsNothing, reason: 'closed again');
    });

    testWidgets('follows the agent as it works, and spins on the task in progress only while running', (tester) async {
      await show(tester);
      await send(tester, 's1', [item('t1', 'a', 'in_progress'), item('t2', 'b')]);
      await tester.tap(find.text('Checklist'));
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsNothing);

      agent.busy = true;
      await send(tester, 's1', [item('t1', 'a', 'in_progress'), item('t2', 'b')]);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await send(tester, 's1', [item('t1', 'a', 'done'), item('t2', 'b', 'in_progress')]);
      expect(find.text('1/2'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget, reason: 'it moved on to the next task');
      expect(find.byIcon(LucideIcons.circleCheck), findsOneWidget);
    });

    testWidgets('a finished list says so', (tester) async {
      await show(tester);
      await send(tester, 's1', [item('t1', 'a', 'done'), item('t2', 'b', 'done')]);
      expect(find.text('2/2'), findsOneWidget);
      expect(find.byIcon(LucideIcons.circleCheck), findsOneWidget, reason: 'the header icon; the rows are closed');
      expect(find.byIcon(LucideIcons.listChecks), findsNothing);
    });

    testWidgets('switching to another chat shows that chat\'s list', (tester) async {
      await show(tester);
      await send(tester, 's1', [item('t1', 'chat one task', 'in_progress')]);
      await send(tester, 's2', [item('t1', 'chat two task', 'in_progress'), item('t2', 'more')]);
      expect(find.text('chat one task'), findsOneWidget);
      expect(find.text('chat two task'), findsNothing);

      agent.sessionId = 's2';
      await send(tester, 's2', [item('t1', 'chat two task', 'in_progress'), item('t2', 'more')]);
      expect(find.text('chat two task'), findsOneWidget);
      expect(find.text('chat one task'), findsNothing);
      expect(find.text('0/2'), findsOneWidget);
    });
  });
}
