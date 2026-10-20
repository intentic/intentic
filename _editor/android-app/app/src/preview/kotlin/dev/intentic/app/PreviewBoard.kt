package dev.intentic.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.BoardLane
import dev.intentic.app.core.Event
import dev.intentic.app.core.EventBoardInner
import dev.intentic.app.core.EventLinkInner
import dev.intentic.app.core.EventSandboxesInner
import dev.intentic.app.core.EventSessionInner
import dev.intentic.app.core.LinkState
import dev.intentic.app.core.LinkStatePasskeyRequiredInner
import dev.intentic.app.core.LinkStateReconnectingInner
import dev.intentic.app.core.SandboxRow
import dev.intentic.app.core.SessionState
import dev.intentic.app.core.SessionStateSignedInInner
import dev.intentic.app.state.AppState
import dev.intentic.app.ui.MainActivity

/**
 * Debug builds only. Says a made-up signed-in state into AppState, as the core would, and opens the app on it, so the
 * board's layout can be looked at without signing in to anything:
 * `adb shell am start -n dev.intentic.app/.PreviewBoard`. The core itself stays signed out, so nothing here reaches
 * the network, and the next real Session event puts the app back where the core says it is. `--es link passkey` (or
 * `addPasskey`) shows the banner of a sandbox that asks for a passkey.
 */
class PreviewBoard : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val now = System.currentTimeMillis().toDouble()
        val minute = 60_000.0
        fun card(id: String, title: String?, lane: BoardLane, ago: Double, status: String = "idle") =
            BoardCard(id = id, title = title, lane = lane, status = status, working = false, unread = false, updatedAt = now - ago)
        val cards = listOf(
            card("a1", "Review the store migration plan", BoardLane.Attention, 2 * minute, "awaiting").copy(unread = true),
            card("w1", "Bridge the conversation rows", BoardLane.Active, 0.5 * minute, "working")
                .copy(working = true, activity = "Edit src/conversation/row.rs", checklistDone = 2u, checklistTotal = 5u),
            card("w2", null, BoardLane.Active, 14 * minute, "working").copy(working = true, activity = "Run cargo test --manifest-path _editor/mobile-core/Cargo.toml"),
            card("s1", "A subagent, nested under its parent", BoardLane.Active, minute).copy(parent = "w1"),
            card("f1", "Phase 0 skeleton", BoardLane.Finished, 3 * 60 * minute),
            card("f2", "Fix the flaky upload test", BoardLane.Finished, 2 * 24 * 60 * minute, "failed").copy(failure = "cargo test failed: 2 tests"),
            card("f3", "Older work", BoardLane.Finished, 9 * 24 * 60 * minute),
        )
        val sandboxes = listOf(
            SandboxRow(id = "sb1", name = "intentic", role = "owner", asleep = false),
            SandboxRow(id = "sb2", name = "website", role = "admin", asleep = true),
        )
        listOf(
            Event.Session(EventSessionInner(SessionState.SignedIn(SessionStateSignedInInner("preview@example.com")))),
            Event.Board(EventBoardInner(sandbox = "sb1", cards = cards)),
            Event.Sandboxes(EventSandboxesInner(sandboxes = sandboxes, open = "sb1")),
            Event.Link(EventLinkInner(sandbox = "sb1", state = link(intent.getStringExtra("link")))),
        ).forEach(AppState::apply)
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    // `--es link passkey` or `addPasskey`: the banner of a sandbox that wants one; anything else, a reconnecting link.
    private fun link(asked: String?): LinkState = when (asked) {
        "passkey" -> LinkState.PasskeyRequired(LinkStatePasskeyRequiredInner(enrolled = true))
        "addPasskey" -> LinkState.PasskeyRequired(LinkStatePasskeyRequiredInner(enrolled = false))
        else -> LinkState.Reconnecting(LinkStateReconnectingInner(retryInMs = 4_000u))
    }
}
