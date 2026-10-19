// The app's line to MainActivity.kt: the intent extras it was launched with, and the logcat lines the measuring
// harness waits for (tag `Spike`), which Kotlin writes so the tag is exact.

import 'package:flutter/services.dart';

const _channel = MethodChannel('dev.intentic.spike/launch');

class LaunchParams {
  const LaunchParams({this.rows = 2000, this.stream = false, this.streamDelayMs = 1500, this.streamMs = 10000});

  /// How many rows to inflate the fixture to (`--ei rows`).
  final int rows;

  /// Whether to start the streamed turn by itself (`--ez stream`), `streamDelayMs` after the rows are drawn.
  final bool stream;
  final int streamDelayMs;

  /// How long the turn streams for (`--ei streamMs`).
  final int streamMs;

  static Future<LaunchParams> read() async {
    final extras = await _channel.invokeMapMethod<String, Object?>('launch') ?? const <String, Object?>{};
    const defaults = LaunchParams();
    return LaunchParams(
      rows: extras['rows'] as int? ?? defaults.rows,
      stream: extras['stream'] as bool? ?? defaults.stream,
      streamDelayMs: extras['streamDelayMs'] as int? ?? defaults.streamDelayMs,
      streamMs: extras['streamMs'] as int? ?? defaults.streamMs,
    );
  }
}

/// The first frame with the transcript's rows has been drawn: `Activity.reportFullyDrawn()` and `SPIKE_READY`.
Future<void> reportReady(int rows) => _channel.invokeMethod<void>('ready', rows);

/// The streamed turn has ended: `SPIKE_STREAM_DONE`.
Future<void> reportStreamDone(int rows) => _channel.invokeMethod<void>('streamDone', rows);
