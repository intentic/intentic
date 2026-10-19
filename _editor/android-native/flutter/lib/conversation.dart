// The one screen: the conversation, newest row at the bottom, and a composer under it. Reports ready once the first
// frame (which holds the rows) is rasterized, and streams the turn when launched with `--ez stream true`.

import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter/material.dart';

import 'launch.dart';
import 'row_view.dart';
import 'transcript.dart';

class ConversationScreen extends StatefulWidget {
  const ConversationScreen({super.key, required this.launch, required this.fixture});

  final LaunchParams launch;
  final Fixture fixture;

  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen> with SingleTickerProviderStateMixin {
  final _scroll = ScrollController();
  final _composer = TextEditingController();
  final _clock = Stopwatch();
  late final Ticker _ticker = createTicker(_onTick);
  late MarkdownLook _look;
  final List<TranscriptRow> _rows = [];
  TurnStream? _stream;
  Timer? _streamDelay;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _rows.addAll(widget.fixture.inflate(widget.launch.rows));
    // The rows are in the first frame. The engine reports the first frame's timings as soon as it is rasterized
    // (later ones are batched), so this fires when the transcript is on screen, not just built.
    SchedulerBinding.instance.addTimingsCallback(_onFirstFrameRasterized);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _look = MarkdownLook(Theme.of(context));
  }

  void _onFirstFrameRasterized(List<FrameTiming> timings) {
    SchedulerBinding.instance.removeTimingsCallback(_onFirstFrameRasterized);
    _ready = true;
    reportReady(_rows.length);
    if (widget.launch.stream) {
      _streamDelay = Timer(
        Duration(milliseconds: widget.launch.streamDelayMs),
        () => _startStream(widget.launch.streamMs),
      );
    }
  }

  void _startStream(int durationMs) {
    if (_stream != null) {
      return;
    }
    _clock
      ..reset()
      ..start();
    _stream = TurnStream(widget.fixture.stream, startMs: 0, durationMs: durationMs);
    _pinToNewest();
    _ticker.start();
  }

  void _onTick(Duration _) {
    final stream = _stream;
    if (stream == null) {
      return;
    }
    if (stream.tick(_rows, _clock.elapsedMilliseconds)) {
      setState(() {});
      _pinToNewest();
    }
    if (stream.done) {
      _ticker.stop();
      _clock.stop();
      _stream = null;
      reportStreamDone(_rows.length);
    }
  }

  void _pinToNewest() {
    if (_scroll.hasClients && _scroll.position.pixels != 0) {
      _scroll.jumpTo(0);
    }
  }

  void _send() {
    final text = _composer.text.trim();
    if (text.isEmpty) {
      return;
    }
    setState(() {
      _rows.add(TranscriptRow(id: _rows.length, role: Role.user, text: text));
      _composer.clear();
    });
    _pinToNewest();
  }

  @override
  void dispose() {
    if (!_ready) {
      SchedulerBinding.instance.removeTimingsCallback(_onFirstFrameRasterized);
    }
    _streamDelay?.cancel();
    _ticker.dispose();
    _scroll.dispose();
    _composer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final look = _look;
    final rows = _rows;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              // Reversed, so index 0 is the newest row: it opens at the bottom and only the visible rows build.
              child: ListView.builder(
                controller: _scroll,
                reverse: true,
                padding: const EdgeInsets.symmetric(vertical: 8),
                itemCount: rows.length,
                // Rows keep their state (and their parsed markdown) when a new row pushes them up one index.
                findChildIndexCallback: (key) {
                  final index = rows.length - 1 - (key as ValueKey<int>).value;
                  return index >= 0 && index < rows.length ? index : null;
                },
                itemBuilder: (context, index) {
                  final row = rows[rows.length - 1 - index];
                  return RowView(key: ValueKey(row.id), row: row, look: look);
                },
              ),
            ),
            _Composer(controller: _composer, onSend: _send),
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.onSend});

  final TextEditingController controller;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: Look.canvas,
        border: Border(top: BorderSide(color: Look.card)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                minLines: 1,
                maxLines: 6,
                keyboardType: TextInputType.multiline,
                style: const TextStyle(fontSize: 15, color: Look.content),
                decoration: InputDecoration(
                  hintText: 'Message',
                  hintStyle: const TextStyle(color: Look.muted),
                  filled: true,
                  fillColor: Look.card,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(20), borderSide: BorderSide.none),
                ),
              ),
            ),
            const SizedBox(width: 4),
            IconButton(
              onPressed: onSend,
              icon: const Icon(Icons.arrow_upward_rounded),
              color: Look.canvas,
              style: IconButton.styleFrom(backgroundColor: Look.accent),
              tooltip: 'Send',
            ),
          ],
        ),
      ),
    );
  }
}
