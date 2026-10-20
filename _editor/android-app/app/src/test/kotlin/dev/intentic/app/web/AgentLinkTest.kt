package dev.intentic.app.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentLinkTest {
    private val web = "https://app.intentic.dev"

    @Test
    fun conversation() {
        assertEquals(AgentLink("ag_1", null, null, false), AgentLink.of("https://app.intentic.dev/agents/ag_1", web))
        assertEquals(AgentLink("ag_1", "sb 2", null, false), AgentLink.of("https://app.intentic.dev/agents/ag_1/?sandbox=sb%202", web))
    }

    @Test
    fun pageAndChanges() {
        assertEquals(AgentLink("ag_1", null, "pg_9", false), AgentLink.of("https://app.intentic.dev/agents/ag_1/pages/pg_9", web))
        assertEquals(AgentLink("ag_1", "sb", null, true), AgentLink.of("https://APP.intentic.dev/agents/ag_1?view=changes&sandbox=sb", web))
    }

    @Test
    fun otherLinksAreNotAgents() {
        assertNull(AgentLink.of("https://app.intentic.dev/agents", web))
        assertNull(AgentLink.of("https://app.intentic.dev/agents/ag_1/files/x", web))
        assertNull(AgentLink.of("https://app.intentic.dev/workspace", web))
        assertNull(AgentLink.of("https://evil.example/agents/ag_1", web))
        assertNull(AgentLink.of("http://app.intentic.dev/agents/ag_1", web))
        assertNull(AgentLink.of("intentic://auth?handoff=1", web))
    }
}
