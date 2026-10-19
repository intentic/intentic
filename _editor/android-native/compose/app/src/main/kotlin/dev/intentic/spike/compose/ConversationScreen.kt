package dev.intentic.spike.compose

import android.os.SystemClock
import androidx.activity.compose.LocalFullyDrawnReporterOwner
import androidx.activity.compose.ReportDrawnWhen
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateSetOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The one screen: the conversation, newest row at the bottom, and a composer under it. With `stream`, the turn
 * starts `streamDelayMs` after the first composition and runs once a frame until `streamMs` has passed.
 */
@Composable
fun ConversationScreen(rows: SnapshotStateList<Row>, spec: StreamSpec, launch: Launch, onStreamDone: (Int) -> Unit) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // Rows whose markdown has been parsed and composed, kept until the first screen of them is reported drawn.
    val parsed = remember { mutableStateSetOf<Int>() }
    val reporter = LocalFullyDrawnReporterOwner.current?.fullyDrawnReporter

    // Ready once every row on screen shows its parsed markdown: the library parses off the main thread, so the first
    // frame with rows holds them still loading. activity-compose calls reportFullyDrawn on the frame drawn after this.
    ReportDrawnWhen {
        val visible = list.layoutInfo.visibleItemsInfo
        visible.isNotEmpty() && visible.all { item ->
            val row = rows[item.key as Int]
            row.role == Role.Notice || row.text.isEmpty() || row.id in parsed
        }
    }

    if (launch.stream) {
        LaunchedEffect(Unit) {
            delay(launch.streamDelayMs)
            val stream = TurnStream(spec, SystemClock.uptimeMillis(), launch.streamMs)
            while (!stream.done) {
                val pinned = !list.canScrollBackward
                val before = rows.size
                withFrameMillis { stream.tick(rows, SystemClock.uptimeMillis()) }
                // A new row lands below the one the list is anchored to: follow it while pinned to the newest.
                if (pinned && rows.size > before) list.scrollToItem(0)
            }
            onStreamDone(rows.size)
        }
    }

    Column(Modifier.fillMaxSize().background(Look.canvas).safeDrawingPadding()) {
        // Reversed, so index 0 is the newest row: it opens at the bottom and only the visible rows compose.
        LazyColumn(
            state = list,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            reverseLayout = true,
            contentPadding = PaddingValues(vertical = 8.dp),
        ) {
            items(rows.asReversed(), key = { it.id }, contentType = { it.role }) { row ->
                RowView(row) { id -> if (reporter?.isFullyDrawnReported == false && id !in parsed) parsed += id }
            }
        }
        Composer(onSend = { text ->
            rows += Row(rows.size, Role.User, text)
            scope.launch { list.scrollToItem(0) }
        })
    }
}

@Composable
private fun Composer(onSend: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, end = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        TextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text("Message") },
            maxLines = 6,
            textStyle = MaterialTheme.typography.bodyLarge,
            shape = RoundedCornerShape(20.dp),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Look.card,
                unfocusedContainerColor = Look.card,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                focusedPlaceholderColor = Look.muted,
                unfocusedPlaceholderColor = Look.muted,
            ),
        )
        Spacer(Modifier.width(8.dp))
        Button(
            onClick = {
                val message = text.trim()
                if (message.isNotEmpty()) {
                    onSend(message)
                    text = ""
                }
            },
            modifier = Modifier.padding(bottom = 4.dp),
        ) {
            Text("Send")
        }
    }
}
