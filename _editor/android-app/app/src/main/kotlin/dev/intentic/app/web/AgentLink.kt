package dev.intentic.app.web

import java.net.URI
import java.net.URLDecoder

/**
 * A web link to an agent that Android handed this app (App Links, verified against app.intentic.dev's asset links):
 * `/agents/<id>`, `/agents/<id>/pages/<page>` or `/agents/<id>?view=changes`, each maybe with `sandbox=`. The
 * conversation opens natively; a page or the changes open over it on the shared WebView, as they would from inside.
 */
data class AgentLink(val agent: String, val sandbox: String?, val page: String?, val changes: Boolean) {
    companion object {
        /** The link as an [AgentLink], or null when it is not one of [webUrl]'s agent routes. */
        fun of(link: String, webUrl: String): AgentLink? {
            val uri = runCatching { URI(link) }.getOrNull() ?: return null
            val web = runCatching { URI(webUrl) }.getOrNull() ?: return null
            if (uri.scheme != web.scheme || !uri.host.equals(web.host, ignoreCase = true) || uri.port != web.port) {
                return null
            }
            val parts = uri.rawPath.orEmpty().split('/').filter { it.isNotEmpty() }.map(::decoded)
            if (parts.size < 2 || parts[0] != "agents") {
                return null
            }
            val page = when {
                parts.size == 2 -> null
                parts.size == 4 && parts[2] == "pages" -> parts[3]
                else -> return null
            }
            val query = uri.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
                decoded(it.substringBefore('=')) to decoded(it.substringAfter('=', ""))
            }
            return AgentLink(parts[1], query["sandbox"]?.ifEmpty { null }, page, changes = page == null && query["view"] == "changes")
        }

        private fun decoded(part: String): String = URLDecoder.decode(part.replace("+", "%2B"), "UTF-8")
    }
}
