package dev.intentic.app.core

/**
 * The numbers [Core.row] answers with. The core holds the same ones (`src/conversation/row.rs` for the view kinds,
 * `src/render/mod.rs` for the span kinds), and a change there is a change here.
 */
object Spans {
    // A row's view kind: the first int of its answer.
    const val VIEW_USER = 0
    const val VIEW_ASSISTANT = 1
    const val VIEW_NOTICE = 2
    const val VIEW_CARD = 3
    const val VIEW_PAGE = 4

    // A span's kind, the third int of each quad; what its fourth (`arg`) means is noted where it means anything.
    const val BOLD = 1
    const val ITALIC = 2
    /** arg: the background, ARGB. */
    const val CODE = 3
    /** A fenced block; arg: the background, ARGB. */
    const val BLOCK = 4
    /** arg: the colour, ARGB. */
    const val COLOR = 5
    const val LINK = 6
    /** arg: the level, 1 to 6. */
    const val HEADING = 7
    /** A table, drawn monospace. */
    const val TABLE = 8
    /** A tool line; arg: 0 running, 1 done, 2 failed. */
    const val TOOL = 9
    const val STRIKE = 10
    const val QUOTE = 11
    const val THINKING = 12
    /** A checklist item; arg: 0 pending, 1 in progress, 2 done. */
    const val TODO = 13
    const val MUTED = 14
    /** A card's title. */
    const val TITLE = 15
}
