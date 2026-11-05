package dev.intentic.app.web

import dev.intentic.app.core.SandboxRow
import java.text.Normalizer

/*
 * How the web app's addresses name a sandbox since 2026-11-05 (the shared sandbox-segment.ts, read here the same way):
 * by its name's words and the tail of its platform id, `/s/intentic-zi4n3i/agents/<id>`, the tail being the key and the
 * words only for the reader. An address from before, and the daemon's push, name it by its whole id, which is read too.
 */

// The shortest tail of an id a segment carries.
private const val KEY_LENGTH = 6

// The longest the name's words run, cut back to a whole word.
private const val SLUG_MAX = 40

private val LETTERS_AND_DIGITS = Regex("^[A-Za-z0-9]+$")

// Only an id of letters and digits has a tail to stand for it; any other is written whole.
private fun hasTail(id: String): Boolean = id.length > KEY_LENGTH && LETTERS_AND_DIGITS.matches(id)

/** A name as a segment's words: lowercase letters and digits, dashes between them, accents dropped. Empty for none. */
internal fun sandboxSlug(name: String): String {
    val dashed = Normalizer.normalize(name, Normalizer.Form.NFKD)
        .replace(Regex("\\p{M}+"), "")
        .lowercase()
        .replace(Regex("[^a-z0-9]+"), "-")
        .trim('-')
    if (dashed.length <= SLUG_MAX) {
        return dashed
    }
    val cut = dashed.take(SLUG_MAX + 1)
    val wordEnd = cut.lastIndexOf('-')
    return (if (wordEnd > 0) cut.take(wordEnd) else dashed.take(SLUG_MAX)).trimEnd('-')
}

/**
 * The listed sandbox an address's segment names: the one whose id it is, else the one whose id ends with its key (what
 * follows its last dash), the name's words deciding only between two that end alike. Null when it names none of them.
 */
fun sandboxOfSegment(segment: String, sandboxes: List<SandboxRow>): SandboxRow? {
    sandboxes.firstOrNull { it.id == segment }?.let { return it }
    val dash = segment.lastIndexOf('-')
    val key = segment.substring(dash + 1)
    if (key.length < KEY_LENGTH) {
        return null
    }
    val ending = sandboxes.filter { hasTail(it.id) && it.id.endsWith(key) }
    if (ending.size <= 1) {
        return ending.firstOrNull()
    }
    val slug = if (dash == -1) "" else segment.substring(0, dash)
    return ending.filter { sandboxSlug(it.name) == slug }.singleOrNull()
}
