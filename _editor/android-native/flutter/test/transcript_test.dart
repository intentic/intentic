import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:intentic_spike_flutter/transcript.dart';

void main() {
  final fixture = Fixture.parse(File('assets/soft-deletes.json').readAsStringSync());

  test('inflates to the exact count with additions on even copies', () {
    final rows = fixture.inflate(2000);
    expect(rows, hasLength(2000));
    expect(rows.first.role, Role.user);
    // Row 1 is the first answer: copy 0 gains the addition, copy 1 (row 10) does not, copy 2 (row 19) does.
    expect(rows[1].text, contains('What changed in step 0:'));
    expect(rows[10].text, isNot(contains('What changed')));
    expect(rows[19].text, contains('What changed in step 2:'));
    expect(rows[1].tools.map((tool) => tool.status), everyElement(ToolStatus.done));
    expect([for (final row in rows) row.id], List.generate(2000, (index) => index));
  });

  test('streams a prompt, then an answer on the clock, then its tools', () {
    const spec = StreamSpec(prose: 'abcdefghij', chunk: 4, everyMs: 16, tools: ['Read', 'Bash'], toolMs: 50, gapMs: 30);
    final rows = <TranscriptRow>[];
    final stream = TurnStream(spec, startMs: 1000, durationMs: 10000);
    expect(stream.tick(rows, 999), isFalse, reason: 'nothing is due before the start');
    stream.tick(rows, 1000);
    expect(rows[0].role, Role.user);
    expect(rows[0].text, streamPrompt);
    expect(rows[1].role, Role.assistant);
    expect(rows[1].text, 'abcd', reason: 'the first chunk lands with the empty answer');
    stream.tick(rows, 1032);
    expect(rows[1].text, 'abcdefghij');
    // Prose ran out at 1048: Read starts, finishes at 1098, Bash starts after the 30 ms gap at 1128.
    stream.tick(rows, 1100);
    expect(rows[1].tools, hasLength(1));
    expect(rows[1].tools[0].status, ToolStatus.done);
    stream.tick(rows, 1128);
    expect(rows[1].tools[1].name, 'Bash');
    expect(rows[1].tools[1].status, ToolStatus.running);
    expect(rows[1].tools[1].summary, streamToolTarget);
    // Bash ends at 1178, its gap at 1208, and the next answer starts with its first chunk.
    stream.tick(rows, 1208);
    expect(rows, hasLength(3));
    expect(rows[2].text, 'abcd');
    expect(stream.done, isFalse);
  });

  test('a late tick catches up, and writing stops at the deadline', () {
    final rows = <TranscriptRow>[];
    final stream = TurnStream(fixture.stream, startMs: 0, durationMs: 20);
    stream.tick(rows, 1000);
    expect(stream.done, isTrue);
    // Chunks at 0 and 16 only: the one due at 32 is past the deadline.
    expect(rows[1].text, fixture.stream.prose.substring(0, 2 * fixture.stream.chunk));
  });

  test('the fixture stream streams its prose in full', () {
    final rows = fixture.inflate(9);
    final stream = TurnStream(fixture.stream, startMs: 0, durationMs: 10000);
    final spec = fixture.stream;
    final writing = ((spec.prose.length + spec.chunk - 1) ~/ spec.chunk) * spec.everyMs;
    stream.tick(rows, writing);
    expect(rows[10].text, spec.prose);
    expect(rows[10].tools, hasLength(1));
    expect(rows[10].tools.single.name, spec.tools.first);
  });
}
