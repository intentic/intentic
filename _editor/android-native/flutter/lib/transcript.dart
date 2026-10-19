// The conversation the spike draws (../fixture/soft-deletes.json), inflated to any number of rows, and the turn that
// streams into it. Both follow the rules every arm of the spike shares (see ../core/src/transcript.rs and stream.rs),
// so every arm draws the same text at the same times. Plain Dart: no Flutter import, so the rules test without a view.

import 'dart:convert';
import 'dart:math' as math;

enum Role { user, assistant, notice }

enum ToolStatus { running, done }

class ToolCall {
  ToolCall({required this.name, required this.summary, required this.status});

  final String name;
  final String summary;
  ToolStatus status;
}

/// One row of the conversation. `id` is its position in the transcript: rows are only ever appended.
class TranscriptRow {
  TranscriptRow({required this.id, required this.role, required this.text, List<ToolCall>? tools})
    : tools = tools ?? <ToolCall>[];

  final int id;
  final Role role;
  String text;
  final List<ToolCall> tools;
}

/// The streamed turn as the fixture states it.
class StreamSpec {
  const StreamSpec({
    required this.prose,
    required this.chunk,
    required this.everyMs,
    required this.tools,
    required this.toolMs,
    required this.gapMs,
  });

  factory StreamSpec.fromJson(Map<String, dynamic> json) => StreamSpec(
    prose: json['prose'] as String,
    chunk: json['chunk'] as int,
    everyMs: json['everyMs'] as int,
    tools: (json['tools'] as List<dynamic>).cast<String>(),
    toolMs: json['toolMs'] as int,
    gapMs: json['gapMs'] as int,
  );

  final String prose;
  final int chunk;
  final int everyMs;
  final List<String> tools;
  final int toolMs;
  final int gapMs;
}

class _FixtureRow {
  const _FixtureRow(this.role, this.text, this.tools);

  final Role role;
  final String text;
  final List<({String name, String summary})> tools;
}

Role _roleOf(String name) => switch (name) {
  'user' => Role.user,
  'assistant' => Role.assistant,
  _ => Role.notice,
};

class Fixture {
  Fixture._(this.addition, this.stream, this._rows);

  factory Fixture.parse(String source) {
    final json = jsonDecode(source) as Map<String, dynamic>;
    final rows = (json['rows'] as List<dynamic>).cast<Map<String, dynamic>>().map((row) {
      final tools = (row['tools'] as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .map((tool) => (name: tool['name'] as String, summary: tool['summary'] as String))
          .toList();
      return _FixtureRow(_roleOf(row['role'] as String), row['text'] as String, tools);
    }).toList();
    return Fixture._(json['addition'] as String, StreamSpec.fromJson(json['stream'] as Map<String, dynamic>), rows);
  }

  final String addition;
  final StreamSpec stream;
  final List<_FixtureRow> _rows;

  /// The fixture's rows copied until there are [count] of them; every assistant answer of an even copy gains
  /// [addition] (a list, a table and a TypeScript block) with `{index}` replaced by the copy.
  List<TranscriptRow> inflate(int count) {
    if (_rows.isEmpty && count > 0) {
      throw StateError('the fixture has no rows');
    }
    final rows = <TranscriptRow>[];
    var copy = 0;
    while (rows.length < count) {
      for (final source in _rows) {
        if (rows.length == count) {
          break;
        }
        var text = source.text;
        if (source.role == Role.assistant && copy.isEven) {
          text += addition.replaceAll('{index}', copy.toString());
        }
        rows.add(
          TranscriptRow(
            id: rows.length,
            role: source.role,
            text: text,
            tools: [
              for (final tool in source.tools)
                ToolCall(name: tool.name, summary: tool.summary, status: ToolStatus.done),
            ],
          ),
        );
      }
      copy++;
    }
    return rows;
  }
}

const streamPrompt = 'Run the migration against a copy of the schema, then its tests.';
const streamToolTarget = 'api/src/users.ts';

enum _Phase { prompt, writing, toolRunning, toolGap }

/// The streamed turn as a state machine on the caller's clock: a prompt, then answers that grow by `chunk`
/// characters every `everyMs`, each followed by its tool calls (`toolMs` running, `gapMs` after), until `durationMs`
/// has passed since `startMs`. [tick] runs every step due by `nowMs`, so a late tick catches up on the steps it
/// missed as a timer would have run them.
class TurnStream {
  TurnStream(this.spec, {required int startMs, required int durationMs})
    : _prose = spec.prose.runes.toList(),
      _deadline = startMs + durationMs,
      _next = startMs;

  final StreamSpec spec;
  final List<int> _prose;
  final int _deadline;
  int _next;
  _Phase _phase = _Phase.prompt;
  int _row = 0;
  int _at = 0;
  int _tool = 0;
  bool _done = false;

  bool get done => _done;

  /// Runs every step due by [nowMs] against [rows]. Returns whether any row changed or was added.
  bool tick(List<TranscriptRow> rows, int nowMs) {
    var changed = false;
    while (!_done && _next <= nowMs) {
      switch (_phase) {
        case _Phase.prompt:
          rows.add(TranscriptRow(id: rows.length, role: Role.user, text: streamPrompt));
          _answer(rows);
          changed = true;
        case _Phase.writing:
          if (_next >= _deadline) {
            _done = true;
          } else if (_at < _prose.length) {
            final end = math.min(_at + spec.chunk, _prose.length);
            rows[_row].text += String.fromCharCodes(_prose, _at, end);
            _at = end;
            _next += spec.everyMs;
            changed = true;
          } else if (spec.tools.isEmpty) {
            if (_prose.isEmpty) {
              _done = true; // Nothing to write and nothing to run: the clock would never move.
            } else {
              _answer(rows);
              changed = true;
            }
          } else {
            _startTool(rows, 0);
            changed = true;
          }
        case _Phase.toolRunning:
          rows[_row].tools.last.status = ToolStatus.done;
          _phase = _Phase.toolGap;
          _next += spec.gapMs;
          changed = true;
        case _Phase.toolGap:
          if (_tool + 1 < spec.tools.length) {
            _startTool(rows, _tool + 1);
            changed = true;
          } else if (_next >= _deadline) {
            _done = true;
          } else {
            _answer(rows);
            changed = true;
          }
      }
    }
    return changed;
  }

  void _answer(List<TranscriptRow> rows) {
    rows.add(TranscriptRow(id: rows.length, role: Role.assistant, text: ''));
    _row = rows.length - 1;
    _at = 0;
    _phase = _Phase.writing;
  }

  void _startTool(List<TranscriptRow> rows, int tool) {
    rows[_row].tools.add(ToolCall(name: spec.tools[tool], summary: streamToolTarget, status: ToolStatus.running));
    _tool = tool;
    _phase = _Phase.toolRunning;
    _next += spec.toolMs;
  }
}
