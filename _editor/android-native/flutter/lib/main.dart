import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'conversation.dart';
import 'launch.dart';
import 'row_view.dart';
import 'transcript.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Read before runApp, so the first frame Flutter draws is already the transcript: the launch theme stays up until
  // then instead of an empty list.
  final (launch, source) = await (LaunchParams.read(), rootBundle.loadString('assets/soft-deletes.json')).wait;
  runApp(SpikeApp(launch: launch, fixture: Fixture.parse(source)));
}

class SpikeApp extends StatelessWidget {
  const SpikeApp({super.key, required this.launch, required this.fixture});

  final LaunchParams launch;
  final Fixture fixture;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Spike Flutter',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: Look.accent,
          brightness: Brightness.dark,
          surface: Look.canvas,
          onSurface: Look.content,
        ),
        scaffoldBackgroundColor: Look.canvas,
      ),
      home: ConversationScreen(launch: launch, fixture: fixture),
    );
  }
}
