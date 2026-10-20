package dev.intentic.app.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The messages `_editor/web/src/app/environments/nativeApp.ts` posts, as its NativeMessage type writes them.
class BridgeTest {
    @Test
    fun eachMessageThePagePostsReadsAsItsKind() {
        assertEquals(PageMessage.Open("/agents/a%2Fb"), PageMessage.of("""{"kind":"open","path":"/agents/a%2Fb"}"""))
        assertEquals(PageMessage.SignOut, PageMessage.of("""{"kind":"signOut"}"""))
        assertEquals(PageMessage.Compose("c1", "fix it"), PageMessage.of("""{"kind":"compose","conversationId":"c1","text":"fix it"}"""))
        assertEquals(PageMessage.SetLook("sanctum"), PageMessage.of("""{"kind":"setLook","look":"sanctum"}"""))
        assertEquals(
            PageMessage.Routed("/workspace?dir=drop", "Workspace", true),
            PageMessage.of("""{"kind":"routed","path":"/workspace?dir=drop","title":"Workspace","canGoBack":true}"""),
        )
    }

    @Test
    fun aMessageThisAppDoesNotKnowOrCannotReadIsNothing() {
        assertNull(PageMessage.of("""{"kind":"somethingNewer","x":1}"""))
        assertNull(PageMessage.of("""{"kind":"open"}"""))
        assertNull(PageMessage.of("not json"))
        assertNull(PageMessage.of("[1,2]"))
    }

    @Test
    fun theScreensTheAppDrawsAreTheOnesThePageHandsOver() {
        assertEquals(NativeScreen.CONVERSATION to "a b+c", nativeScreenOf("/agents/a%20b+c"))
        assertEquals(NativeScreen.CONVERSATION to "x", nativeScreenOf("/agents/x?view=chat"))
        assertEquals(NativeScreen.HOME to null, nativeScreenOf("/agents?lane=active"))
        assertEquals(NativeScreen.HOME to null, nativeScreenOf("/menu"))
        assertEquals(NativeScreen.HOME to null, nativeScreenOf("/login/confirm?token=t"))
        assertEquals(NativeScreen.NONE to null, nativeScreenOf("/workspace"))
    }
}
