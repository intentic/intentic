package dev.intentic.app.state

import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.BoardLane
import dev.intentic.app.core.Event
import dev.intentic.app.core.EventBoardInner
import dev.intentic.app.core.EventLinkInner
import dev.intentic.app.core.EventSandboxesInner
import dev.intentic.app.core.EventSessionInner
import dev.intentic.app.core.LinkState
import dev.intentic.app.core.SandboxRow
import dev.intentic.app.core.SessionState
import dev.intentic.app.core.SessionStateSignedInInner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SnapshotTest {
    private val signedIn = Event.Session(EventSessionInner(SessionState.SignedIn(SessionStateSignedInInner("a@example.com"))))
    private val card = BoardCard(id = "a1", lane = BoardLane.Active, status = "working", working = true, unread = false, updatedAt = 1.0)
    private val row = SandboxRow(id = "s1", name = "one", role = "owner", asleep = false)

    @Test
    fun aBoardSaidBeforeItsSandboxOpensIsThereWhenItDoes() {
        val state = Snapshot()
            .with(signedIn)
            .with(Event.Board(EventBoardInner(sandbox = "s1", cards = listOf(card))))
            .with(Event.Sandboxes(EventSandboxesInner(sandboxes = listOf(row), open = "s1")))
        assertEquals(listOf(card), state.board)
        assertEquals(row, state.openSandbox)
    }

    @Test
    fun theLinkShownIsTheOpenSandboxs() {
        val state = Snapshot()
            .with(Event.Sandboxes(EventSandboxesInner(sandboxes = listOf(row), open = "s1")))
            .with(Event.Link(EventLinkInner(sandbox = "s2", state = LinkState.Live)))
        assertNull(state.link)
        assertEquals(LinkState.Connecting, state.with(Event.Link(EventLinkInner(sandbox = "s1", state = LinkState.Connecting))).link)
    }

    @Test
    fun signingOutForgetsEverythingTheAccountSaw() {
        val state = Snapshot()
            .with(signedIn)
            .with(Event.Sandboxes(EventSandboxesInner(sandboxes = listOf(row), open = "s1")))
            .with(Event.Board(EventBoardInner(sandbox = "s1", cards = listOf(card))))
            .with(Event.Session(EventSessionInner(SessionState.SignedOut)))
        assertEquals(Snapshot(session = SessionState.SignedOut), state)
    }
}
