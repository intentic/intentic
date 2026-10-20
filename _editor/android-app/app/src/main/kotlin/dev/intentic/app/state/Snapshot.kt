package dev.intentic.app.state

import dev.intentic.app.core.BoardCard
import dev.intentic.app.core.Event
import dev.intentic.app.core.LinkState
import dev.intentic.app.core.SandboxRow
import dev.intentic.app.core.SessionState

/**
 * What the core last said about each part of the app's state. Every state event carries the whole of its part, so
 * applying one is a replacement, never a merge. Boards and links are kept per sandbox: the core says a sandbox's board
 * just before the Sandboxes event that makes it the open one.
 */
data class Snapshot(
    /** Null until the core's first word, which it sends within milliseconds of starting. */
    val session: SessionState? = null,
    val sandboxes: List<SandboxRow> = emptyList(),
    val open: String? = null,
    val boards: Map<String, List<BoardCard>> = emptyMap(),
    val links: Map<String, LinkState> = emptyMap(),
    /** Why the core is not running, when it did not start. */
    val failure: String? = null,
) {
    val openSandbox: SandboxRow? get() = sandboxes.firstOrNull { it.id == open }

    /** The open sandbox's cards, or null before the core has said any. */
    val board: List<BoardCard>? get() = open?.let(boards::get)

    val link: LinkState? get() = open?.let(links::get)

    fun with(event: Event): Snapshot =
        when (event) {
            // Signing out forgets every account's state, so nothing of one account is shown to the next.
            is Event.Session ->
                if (event.content.state is SessionState.SignedOut) Snapshot(session = event.content.state)
                else copy(session = event.content.state)
            is Event.Sandboxes -> copy(sandboxes = event.content.sandboxes, open = event.content.open)
            is Event.Board -> copy(boards = boards + (event.content.sandbox to event.content.cards))
            is Event.Link -> copy(links = links + (event.content.sandbox to event.content.state))
            // Replies and conversation rows are not state: Calls and the conversation screen take those.
            else -> this
        }
}
