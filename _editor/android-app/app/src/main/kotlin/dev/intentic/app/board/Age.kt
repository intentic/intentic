package dev.intentic.app.board

/** How long ago a card last did something, in the one unit it is shown in. */
sealed interface Age {
    data object Now : Age

    data class Minutes(val count: Int) : Age

    data class Hours(val count: Int) : Age

    data class Days(val count: Int) : Age

    /** A week or more: the calendar day reads better than a sum of days. */
    data class On(val at: Long) : Age
}

private const val MINUTE = 60_000L

/**
 * The web's `timeAgo(at, { days: true })` (_editor/ui/src/lib/format.ts): always rounded down, since an age is a
 * floor, and a time a little ahead of this phone's clock reads as now.
 */
fun ageOf(updatedAt: Double, now: Long): Age {
    val minutes = ((now - updatedAt.toLong()) / MINUTE).toInt()
    val hours = minutes / 60
    val days = hours / 24
    return when {
        minutes < 1 -> Age.Now
        minutes < 60 -> Age.Minutes(minutes)
        hours < 24 -> Age.Hours(hours)
        days < 7 -> Age.Days(days)
        else -> Age.On(updatedAt.toLong())
    }
}
