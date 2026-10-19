package dev.intentic.spike.compose

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.compose.MarkdownSuccess
import com.mikepenz.markdown.compose.components.MarkdownComponents
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownHighlightedCodeBlock
import com.mikepenz.markdown.compose.elements.MarkdownHighlightedCodeFence
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.model.rememberMarkdownState
import dev.snipme.highlights.Highlights
import dev.snipme.highlights.model.SyntaxThemes

// How one row draws: a prompt in a right-aligned bubble, an answer as full-width markdown, a notice as small muted
// text, and a row's tool calls one line each. Markdown is mikepenz's multiplatform-markdown-renderer (m3), fenced
// code is its -code module (SnipMe Highlights).

/**
 * The markdown components every row shares: the library's highlighted code, in its default theme's dark variant.
 * Each code block remembers its own Highlights builder, as the library's default does: a builder is mutable and
 * the blocks highlight concurrently.
 */
val markdownLook: MarkdownComponents = markdownComponents(
    codeBlock = {
        MarkdownHighlightedCodeBlock(it.content, it.node, highlightsBuilder = remember { darkHighlights() })
    },
    codeFence = {
        MarkdownHighlightedCodeFence(it.content, it.node, highlightsBuilder = remember { darkHighlights() })
    },
)

private fun darkHighlights() = Highlights.Builder().theme(SyntaxThemes.default(darkMode = true))

/** One row. [onParsed] hears when its markdown has been parsed and composed, which is what readiness waits for. */
@Composable
fun RowView(row: Row, onParsed: (Int) -> Unit) {
    when (row.role) {
        Role.User -> Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            Box(Modifier.fillMaxWidth(0.82f), contentAlignment = Alignment.CenterEnd) {
                Surface(color = Look.card, shape = RoundedCornerShape(18.dp)) {
                    Body(row, onParsed, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), fill = false)
                }
            }
        }
        Role.Assistant -> Body(row, onParsed, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), fill = true)
        Role.Notice -> Text(
            row.text,
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            color = Look.muted,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun Body(row: Row, onParsed: (Int) -> Unit, modifier: Modifier, fill: Boolean) {
    Column(modifier, horizontalAlignment = if (fill) Alignment.Start else Alignment.End) {
        if (row.text.isNotEmpty()) {
            // Parsed off the main thread by the library; `retainState` keeps a streamed answer on screen while its
            // next chunk parses, rather than blinking to the empty loading state.
            val markdown = rememberMarkdownState(row.text, retainState = true)
            Markdown(
                markdown,
                modifier = if (fill) Modifier.fillMaxWidth() else Modifier,
                components = markdownLook,
                success = { state, components, successModifier ->
                    MarkdownSuccess(state, components, successModifier)
                    SideEffect { onParsed(row.id) }
                },
            )
        }
        for (tool in row.tools) {
            ToolLine(tool)
        }
    }
}

@Composable
private fun ToolLine(tool: ToolCall) {
    val running = tool.status == ToolStatus.Running
    val line = remember(tool) {
        buildAnnotatedString {
            withStyle(SpanStyle(color = if (running) Look.accent else Look.muted)) {
                append(if (running) "◌ " else "▸ ")
            }
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = Look.content)) { append(tool.name) }
            if (tool.summary.isNotEmpty()) {
                withStyle(SpanStyle(fontFamily = Mono, color = Look.muted)) { append("  " + tool.summary.take(64)) }
            }
        }
    }
    Text(line, Modifier.padding(top = 6.dp), fontSize = 13.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}
