package dev.intentic.device.tools

/**
 * Turns the relative path an agent sends into the folder names to walk inside one picked folder. The folder is a
 * Storage Access Framework tree reached by display name, never by a filesystem path, so the one way out of it is `..`,
 * and that is refused outright rather than resolved.
 */
object SafePath {
    private const val MAX_SEGMENT = 255

    /**
     * The segments of [path], empty for the folder itself (blank, or only "."). Throws [ToolFailed]
     * for an absolute path, any `..` segment, a NUL character, or a segment too long for a file name. Both `/` and `\`
     * separate segments, so `a\..\b` is caught as well.
     */
    fun segments(path: String): List<String> {
        if (path.contains('\u0000')) {
            throw ToolFailed("A path may not contain a NUL character.")
        }
        if (path.startsWith("/") || path.startsWith("\\")) {
            throw ToolFailed("Paths are relative to the folder; \"$path\" starts with a slash. Name the folder in `folder` and give the path inside it.")
        }
        val parts = path.split('/', '\\').filter { it.isNotEmpty() && it != "." }
        if (parts.any { it == ".." }) {
            throw ToolFailed("\"$path\" goes up with \"..\", which is refused: a path stays inside the folder it names.")
        }
        if (parts.any { it.length > MAX_SEGMENT }) {
            throw ToolFailed("A name in \"$path\" is longer than a file name can be.")
        }
        return parts
    }

    /** Like [segments], for a call that needs a file or folder inside the folder, not the folder itself. */
    fun nonEmpty(path: String): List<String> {
        val parts = segments(path)
        if (parts.isEmpty()) {
            throw ToolFailed("Give a path inside the folder; \"$path\" is the folder itself.")
        }
        return parts
    }
}
