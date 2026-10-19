// How one row draws: a prompt in a right-aligned bubble, an answer as full-width markdown, a notice as small muted
// text, and a row's tool calls one line each. Markdown is flutter_markdown_plus, fenced code is re_highlight.

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:re_highlight/languages/javascript.dart';
import 'package:re_highlight/languages/typescript.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/github-dark.dart';

import 'transcript.dart';

/// The palette the Kotlin arm uses (android/app/src/main/res/values/colors.xml), so the arms look alike.
abstract final class Look {
  static const canvas = Color(0xFF15171C);
  static const card = Color(0xFF22262E);
  static const content = Color(0xFFE6E8EC);
  static const muted = Color(0xFF8B93A1);
  static const accent = Color(0xFF7AA2F7);
  static const codeBlock = Color(0xFF0D1117);
  static const inlineCode = Color(0xFF2D333F);
  static const mono = 'monospace';
}

final Highlight _highlight = Highlight()
  ..registerLanguage('typescript', langTypescript)
  ..registerLanguage('javascript', langJavascript);

/// A fenced code block highlighted by its info string (`ts` is an alias of typescript); an unknown language draws
/// plain.
class CodeBlockBuilder extends MarkdownElementBuilder {
  CodeBlockBuilder(this.style, this.padding);

  final TextStyle style;
  final EdgeInsets padding;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final code = element.children?.whereType<md.Element>().where((child) => child.tag == 'code').firstOrNull;
    final source = element.textContent.replaceAll(RegExp(r'\n$'), '');
    final language = code?.attributes['class']?.replaceFirst('language-', '');
    TextSpan span;
    if (language != null && _highlight.getLanguage(language) != null) {
      final renderer = TextSpanRenderer(style, githubDarkTheme);
      _highlight.highlight(code: source, language: language).render(renderer);
      span = TextSpan(style: style, children: [?renderer.span]);
    } else {
      span = TextSpan(style: style, text: source);
    }
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: padding,
      child: Text.rich(span, softWrap: false),
    );
  }
}

/// The style sheet and builders every row shares, made once per theme.
class MarkdownLook {
  MarkdownLook(ThemeData theme)
    : sheet = MarkdownStyleSheet.fromTheme(theme).copyWith(
        p: const TextStyle(fontSize: 15, height: 1.4, color: Look.content),
        strong: const TextStyle(fontWeight: FontWeight.w700),
        em: const TextStyle(fontStyle: FontStyle.italic),
        code: const TextStyle(
          fontFamily: Look.mono,
          fontSize: 13.5,
          color: Color(0xFFE5C07B),
          backgroundColor: Look.inlineCode,
        ),
        listBullet: const TextStyle(fontSize: 15, color: Look.muted),
        blockSpacing: 10,
        codeblockDecoration: BoxDecoration(color: Look.codeBlock, borderRadius: BorderRadius.circular(8)),
        tableHead: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Look.content),
        tableBody: const TextStyle(fontSize: 14, color: Look.content),
        tableBorder: TableBorder.all(color: const Color(0xFF3A404C)),
        tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        tableHeadCellsDecoration: const BoxDecoration(color: Look.card),
      ),
      builders = {
        'pre': CodeBlockBuilder(
          const TextStyle(fontFamily: Look.mono, fontSize: 13, height: 1.45, color: Color(0xFFC9D1D9)),
          const EdgeInsets.all(12),
        ),
      };

  final MarkdownStyleSheet sheet;
  final Map<String, MarkdownElementBuilder> builders;
}

class RowView extends StatelessWidget {
  const RowView({super.key, required this.row, required this.look});

  final TranscriptRow row;
  final MarkdownLook look;

  @override
  Widget build(BuildContext context) {
    return switch (row.role) {
      Role.user => Padding(
        padding: const EdgeInsets.fromLTRB(56, 8, 12, 8),
        child: Align(
          alignment: Alignment.centerRight,
          child: DecoratedBox(
            decoration: BoxDecoration(color: Look.card, borderRadius: BorderRadius.circular(18)),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: _body(fitContent: true),
            ),
          ),
        ),
      ),
      Role.assistant => Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 8), child: _body(fitContent: false)),
      Role.notice => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        child: Text(row.text, style: const TextStyle(fontSize: 13, color: Look.muted)),
      ),
    };
  }

  Widget _body({required bool fitContent}) {
    final markdown = MarkdownBody(
      data: row.text,
      styleSheet: look.sheet,
      builders: look.builders,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      fitContent: fitContent,
    );
    if (row.tools.isEmpty) {
      return markdown;
    }
    return Column(
      crossAxisAlignment: fitContent ? CrossAxisAlignment.end : CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [if (row.text.isNotEmpty) markdown, for (final tool in row.tools) _ToolLine(tool)],
    );
  }
}

class _ToolLine extends StatelessWidget {
  const _ToolLine(this.tool);

  final ToolCall tool;

  @override
  Widget build(BuildContext context) {
    final running = tool.status == ToolStatus.running;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: running ? '◌ ' : '▸ ',
              style: TextStyle(color: running ? Look.accent : Look.muted),
            ),
            TextSpan(
              text: tool.name,
              style: const TextStyle(fontWeight: FontWeight.w600, color: Look.content),
            ),
            if (tool.summary.isNotEmpty)
              TextSpan(
                text: '  ${tool.summary.length > 64 ? tool.summary.substring(0, 64) : tool.summary}',
                style: const TextStyle(fontFamily: Look.mono, color: Look.muted),
              ),
          ],
        ),
        style: const TextStyle(fontSize: 13.5),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}
