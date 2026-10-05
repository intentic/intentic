package dev.intentic.device.touch

import dev.intentic.device.tools.FrameMath
import dev.intentic.device.tools.ToolFailed

/** One line of a listing: what the node is, what it says, and the ref the agent acts on it by. */
class Element(
    val ref: String,
    val node: UiNode,
    val role: String,
    /** What it is called: its text, description or hint; empty when it has none. */
    val label: String,
    /** What a field holds. Null for anything that is not a field, for an empty one, and always for a password. */
    val value: String?,
    val flags: List<String>,
    val bounds: Bounds,
    val password: Boolean,
)

class Listing(
    val packageName: String?,
    val screenWidth: Int,
    val screenHeight: Int,
    val elements: List<Element>,
    /** How many earned a line, before the cut. */
    val total: Int,
    /** The tree was bigger than one listing reads, so some of the screen is missing. */
    val incomplete: Boolean,
)

/** The refs of the newest listing, and nothing older: a ref names an element of the screen as it was then. */
class RefTable {
    @Volatile
    private var current: Listing? = null

    fun store(listing: Listing) {
        current = listing
    }

    fun latest(): Listing? = current

    /** The element a ref names, or a sentence saying why not and what to do. */
    fun resolve(ref: String): Element {
        val listing = current ?: throw ToolFailed("There is no element listing yet: call ui_elements first, then use its refs.")
        val wanted = ref.trim().removePrefix("[").removeSuffix("]").lowercase()
        return listing.elements.firstOrNull { it.ref == wanted }
            ?: throw ToolFailed(
                "There is no element [$wanted] in the last listing" +
                    (if (listing.elements.isEmpty()) ", which had none" else " (it has [${listing.elements.first().ref}] to [${listing.elements.last().ref}])") +
                    ". Call ui_elements again.",
            )
    }
}

/**
 * The screen's tree as a flat list an agent can read and name: every visible node a person could operate or read, in
 * reading order, each with a ref. A control with no text of its own is called by the text inside it, and that text is not
 * listed twice. A password field is listed without its content.
 */
object Elements {
    const val MAX_SHOWN = 250
    private const val MAX_VISITED = 5_000
    private const val MAX_DEPTH = 80
    private const val MAX_LABEL = 80

    fun list(root: UiNode, screenWidth: Int, screenHeight: Int): Listing {
        val found = ArrayList<Pending>()
        var visited = 0
        var incomplete = false

        fun walk(node: UiNode, depth: Int, absorbed: Boolean) {
            visited += 1
            if (visited > MAX_VISITED || depth > MAX_DEPTH) {
                incomplete = true
                return
            }
            if (!node.isVisibleToUser) {
                return
            }
            val own = ownLabel(node)
            val interactive = interactive(node)
            val derived = if (own.isEmpty() && interactive && !node.isEditable && !node.isPassword) derivedLabel(node) else ""
            val label = own.ifEmpty { derived }
            val textOnly = !interactive && !node.isScrollable
            val listed = !node.bounds.isEmpty && (interactive || node.isScrollable || label.isNotEmpty()) && !(absorbed && textOnly)
            if (listed) {
                found += Pending(node, label, valueOf(node))
            }
            // What an operable node swallowed as its name is not listed again below it.
            val below = absorbed || derived.isNotEmpty()
            for (child in node.children) {
                walk(child, depth + 1, below)
            }
        }
        walk(root, 0, false)

        val shown = found.take(MAX_SHOWN)
        val elements = shown.mapIndexed { index, pending ->
            val node = pending.node
            Element("e${index + 1}", node, roleOf(node), cut(pending.label), pending.value, flagsOf(node), node.bounds, node.isPassword)
        }
        return Listing(root.packageName, screenWidth, screenHeight, elements, found.size, incomplete || found.size > shown.size)
    }

    private class Pending(val node: UiNode, val label: String, val value: String?)

    private fun interactive(node: UiNode): Boolean = node.isClickable || node.isLongClickable || node.isEditable || node.isCheckable

    /** What the node calls itself. A field is named by its description or hint, never by what is typed in it. */
    fun ownLabel(node: UiNode): String {
        if (node.isEditable || node.isPassword) {
            return clean(node.contentDescription).ifEmpty { clean(node.hintText) }.ifEmpty { if (node.isShowingHint) clean(node.text) else "" }
        }
        return clean(node.text).ifEmpty { clean(node.contentDescription) }.ifEmpty { clean(node.hintText) }
    }

    private fun valueOf(node: UiNode): String? {
        if (node.isPassword || !node.isEditable || node.isShowingHint) {
            return null
        }
        return clean(node.text).ifEmpty { null }?.let(::cut)
    }

    /** The text of what is inside a control that has none of its own: "Pay now" from a button made of two text views. */
    private fun derivedLabel(node: UiNode): String {
        val parts = ArrayList<String>()
        fun gather(from: UiNode, depth: Int) {
            if (parts.size >= 3 || depth > 6 || !from.isVisibleToUser) {
                return
            }
            for (child in from.children) {
                // A field, or a control with a line of its own, is not part of what its neighbour is called.
                if (child.isPassword || child.isEditable || interactive(child)) {
                    continue
                }
                val text = clean(child.text).ifEmpty { clean(child.contentDescription) }
                if (text.isNotEmpty()) {
                    parts += text
                }
                gather(child, depth + 1)
            }
        }
        gather(node, 0)
        return parts.distinct().joinToString(" ")
    }

    /** A short word for what the node is. */
    fun roleOf(node: UiNode): String {
        val name = node.className.orEmpty().substringAfterLast('.')
        return when {
            node.isPassword -> "password field"
            node.isEditable -> "text field"
            name.contains("Switch") || name.contains("Toggle") -> "switch"
            name.contains("CheckBox") -> "checkbox"
            name.contains("RadioButton") -> "radio button"
            name.contains("Button") -> "button"
            name.contains("Spinner") -> "dropdown"
            name.contains("SeekBar") || name.contains("Slider") -> "slider"
            name.contains("ImageView") || name.contains("Image") -> "image"
            name.contains("WebView") -> "web view"
            name.contains("Tab") -> "tab"
            node.isScrollable -> "scrolling area"
            node.isCheckable -> "checkbox"
            node.isClickable -> "control"
            else -> "text"
        }
    }

    fun flagsOf(node: UiNode): List<String> {
        val flags = ArrayList<String>()
        if (node.isClickable) flags += "clickable"
        if (node.isLongClickable) flags += "long-clickable"
        if (node.isCheckable) flags += if (node.isChecked) "checked" else "unchecked"
        if (node.isScrollable) flags += "scrollable"
        if (node.isFocused) flags += "focused"
        if (!node.isEnabled) flags += "disabled"
        if (node.isPassword && !node.text.isNullOrEmpty()) flags += "filled"
        return flags
    }

    /** The element at a point: the smallest one that contains it, so a button wins over the list it sits in. */
    fun hitTest(listing: Listing, x: Int, y: Int): Element? =
        listing.elements.filter { it.bounds.contains(x, y) }.minByOrNull { it.bounds.area }

    /** The listing as the agent reads it. Positions are in [frame]'s pixels when it shows this screen, else in phone pixels. */
    fun format(listing: Listing, appLabel: String?, frame: FrameMath.Frame?): String {
        val inFrame = frame != null && frame.phoneWidth == listing.screenWidth && frame.phoneHeight == listing.screenHeight
        val shownNote = if (listing.elements.size < listing.total) ", the first ${listing.elements.size} shown" else ""
        val header = "Foreground app: ${appLabel ?: listing.packageName ?: "unknown"}${if (appLabel != null && listing.packageName != null) " (${listing.packageName})" else ""}. " +
            "${listing.total} elements$shownNote" +
            (if (listing.incomplete && listing.elements.size == listing.total) "; the screen has more than could be read, so some are missing" else "") + "."
        if (listing.elements.isEmpty()) {
            return "$header This screen offers nothing to its accessibility tree; use a screenshot and coordinates instead."
        }
        val where = if (inFrame) "Positions are pixels in f${frame!!.id}." else "Positions are phone pixels (${listing.screenWidth}x${listing.screenHeight}); take a screenshot to read coordinates in a frame."
        val rows = listing.elements.map { element ->
            val b = element.bounds
            val at = if (inFrame) {
                val box = FrameMath.toFrame(frame!!, b.left, b.top, b.right, b.bottom)
                "at ${box.x},${box.y} ${box.width}x${box.height}"
            } else {
                "at ${b.left},${b.top} ${b.width}x${b.height}"
            }
            val label = if (element.label.isEmpty()) "" else " ${quoted(element.label)}"
            val value = if (element.value == null) "" else " = ${quoted(element.value)}"
            "[${element.ref}] ${element.role}$label$value $at${if (element.flags.isEmpty()) "" else " (${element.flags.joinToString(", ")})"}"
        }
        return (listOf(header, "$where Act on an element by its ref with ui_act; refs hold until the next listing.") + rows).joinToString("\n")
    }

    private fun quoted(text: String): String = "\"${text.replace("\"", "'")}\""

    private fun clean(text: CharSequence?): String = text?.toString()?.replace(Regex("\\s+"), " ")?.trim().orEmpty()

    private fun cut(text: String): String = if (text.length <= MAX_LABEL) text else text.take(MAX_LABEL) + "..."
}
