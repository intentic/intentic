package dev.intentic.device.touch

import dev.intentic.device.policy.Confirm
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppPolicyTest {
    private val list = HashMap<String, AllowedApp>()
    private var destructive = false
    private val policy = AppPolicy("dev.intentic.device", { setOf("com.launcher") }, { list[it] }, { destructive })

    private fun allow(pkg: String, mode: AppMode, sensitive: Boolean = false) {
        list[pkg] = AllowedApp(pkg, pkg.substringAfterLast('.'), mode, sensitive)
    }

    private fun refusal(pkg: String?, need: AppMode): String = (policy.check(pkg, pkg?.substringAfterLast('.'), need) as Access.Refused).message

    @Test
    fun `nothing on screen is a refusal that says the screen may be locked`() {
        assertTrue(refusal(null, AppMode.READ).contains("no active window"))
    }

    @Test
    fun `an app that is not on the list is refused, naming ask_access and the package`() {
        val said = refusal("com.bank", AppMode.READ)
        assertTrue(said, said.contains("ask_access") && said.contains("\"com.bank\"") && said.contains("then stop"))
        assertTrue(refusal("com.bank", AppMode.ACT).contains("ask_access"))
    }

    @Test
    fun `read lets the agent look and act lets it touch, and read is not enough to touch`() {
        allow("com.notes", AppMode.READ)
        assertTrue(policy.check("com.notes", "Notes", AppMode.READ) is Access.Granted)
        val said = refusal("com.notes", AppMode.ACT)
        assertTrue(said, said.contains("look at") && said.contains("mode \"act\""))
        allow("com.notes", AppMode.ACT)
        assertTrue(policy.check("com.notes", "Notes", AppMode.ACT) is Access.Granted)
        assertTrue(policy.check("com.notes", "Notes", AppMode.READ) is Access.Granted)
    }

    @Test
    fun `this app, the home screen, Settings and Android's system screens are never actable, even on the list`() {
        val never = listOf(
            "dev.intentic.device", "com.launcher", "com.android.settings", "com.android.systemui", "com.android.permissioncontroller",
            "com.google.android.permissioncontroller", "com.android.packageinstaller", "android",
        )
        for (pkg in never) {
            allow(pkg, AppMode.ACT)
            assertTrue("$pkg is never actable", policy.neverActable(pkg))
            val said = refusal(pkg, AppMode.ACT)
            assertTrue(said, said.contains("not offered") && said.contains("do that step themselves"))
        }
        // Looking is the person's call: Settings on the list may be read.
        assertTrue(policy.check("com.android.settings", "Settings", AppMode.READ) is Access.Granted)
        assertFalse(policy.neverActable("com.bank"))
    }

    @Test
    fun `an app marked sensitive is not actable unless destructive actions are on, but can be looked at`() {
        allow("com.bank", AppMode.ACT, sensitive = true)
        val said = refusal("com.bank", AppMode.ACT)
        assertTrue(said, said.contains("marked sensitive") && said.contains("Destructive actions"))
        assertTrue(policy.check("com.bank", "Bank", AppMode.READ) is Access.Granted)
        destructive = true
        assertTrue(policy.check("com.bank", "Bank", AppMode.ACT) is Access.Granted)
    }
}

class ConfirmRulesTest {
    private val plain = AllowedApp("com.app", "App", AppMode.ACT, sensitive = false)
    private val sensitiveApp = AllowedApp("com.bank", "Bank", AppMode.ACT, sensitive = true)

    private fun act(action: String, label: String = "", password: Boolean = false, passwordFocus: Boolean = false) = PlannedAct(action, label, password, passwordFocus)

    @Test
    fun `words that pay, buy, send money, delete, remove or transfer are risky, and others are not`() {
        for (label in listOf("Pay now", "pay", "Payment", "Buy", "Buy now", "Purchase", "purchase history", "Send money", "Send  Money", "Delete", "Delete account", "Remove from list", "Transfer $50", "Confirm payment")) {
            assertTrue("$label is risky", ConfirmRules.risky(label))
        }
        for (label in listOf("Send", "Send message", "Display", "Spaying", "Premove", "Cancel", "Search", "Settings", "Reply", "")) {
            assertFalse("$label is not risky", ConfirmRules.risky(label))
        }
    }

    @Test
    fun `never asks about nothing and always asks about everything`() {
        for (action in listOf("tap", "type", "scroll_down", "swipe", "clear")) {
            assertNull(ConfirmRules.reason(Confirm.NEVER, sensitiveApp, act(action, "Delete", password = true)))
            assertNotNull(ConfirmRules.reason(Confirm.ALWAYS, plain, act(action, "Menu")))
        }
    }

    @Test
    fun `sensitive asks before typing into a password field, not into others`() {
        assertEquals("type into \"Password\" (a password field)", ConfirmRules.reason(Confirm.SENSITIVE, plain, act("type", "Password", password = true)))
        assertNotNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("set_text", "Password", password = true)))
        assertNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("type", "Search")))
        assertNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("clear", "Password", password = true)))
    }

    @Test
    fun `sensitive asks before a tap on risky text, not before an ordinary tap or a scroll`() {
        assertEquals("tap \"Pay now\"", ConfirmRules.reason(Confirm.SENSITIVE, plain, act("tap", "Pay now")))
        assertNotNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("long_press", "Delete")))
        assertNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("tap", "Send")))
        assertNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("scroll_down", "Delete")))
    }

    @Test
    fun `sensitive asks before a tap at a point while a password field has the keyboard, since the keys could be typing it`() {
        assertNotNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("tap", "", passwordFocus = true)))
        assertNotNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("swipe", "", passwordFocus = true)))
        assertNull(ConfirmRules.reason(Confirm.SENSITIVE, plain, act("tap", "")))
    }

    @Test
    fun `an app marked sensitive asks before every act in it unless the person said never`() {
        assertEquals("tap \"Menu\" (Bank is marked sensitive)", ConfirmRules.reason(Confirm.SENSITIVE, sensitiveApp, act("tap", "Menu")))
        assertNotNull(ConfirmRules.reason(Confirm.SENSITIVE, sensitiveApp, act("scroll_down")))
        assertNull(ConfirmRules.reason(Confirm.NEVER, sensitiveApp, act("tap", "Menu")))
    }
}

class NavigationTest {
    @Test
    fun `back, home, recents, the shade and quick settings are offered`() {
        assertEquals(Nav.BACK, Navigation.of("back"))
        assertEquals(Nav.HOME, Navigation.of("home"))
        assertEquals(Nav.RECENTS, Navigation.of("recents"))
        assertEquals(Nav.NOTIFICATIONS, Navigation.of("notifications"))
        assertEquals(Nav.QUICK_SETTINGS, Navigation.of("quick_settings"))
        assertNull(Navigation.of("tap"))
    }

    @Test
    fun `locking the screen and the power menu are refused by name, and are not navigation at all`() {
        for (name in listOf("lock", "lock_screen", "LOCK_SCREEN", "power", "power_dialog", "power_menu", "shutdown", "reboot", "sleep")) {
            val said = Navigation.refusal(name)
            assertNotNull("$name is refused", said)
            assertTrue(said!!, said.contains("not offered") && said.contains("unlock"))
            assertNull("$name is not a navigation key", Navigation.of(name))
        }
        assertNull(Navigation.refusal("back"))
        assertEquals(listOf("back", "home", "recents", "notifications", "quick_settings"), Nav.entries.map { it.word })
    }
}

class ServiceSettingTest {
    private val pkg = "dev.intentic.device"
    private val cls = "dev.intentic.device.touch.TouchService"

    @Test
    fun `the service is on when the setting lists it, in the full or the shortened form, among others`() {
        assertTrue(ServiceSetting.enabled("$pkg/$cls", pkg, cls))
        assertTrue(ServiceSetting.enabled("$pkg/.touch.TouchService", pkg, cls))
        assertTrue(ServiceSetting.enabled("com.other/com.other.Svc:$pkg/$cls", pkg, cls))
        assertTrue(ServiceSetting.enabled("COM.OTHER/x: ${pkg.uppercase()}/${cls.uppercase()}", pkg, cls))
    }

    @Test
    fun `it is off when the setting is empty, unset, or lists others`() {
        assertFalse(ServiceSetting.enabled(null, pkg, cls))
        assertFalse(ServiceSetting.enabled("", pkg, cls))
        assertFalse(ServiceSetting.enabled("com.other/com.other.Svc", pkg, cls))
        assertFalse(ServiceSetting.enabled("$pkg/dev.intentic.device.Other", pkg, cls))
    }
}
