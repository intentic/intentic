package dev.intentic.app

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.accessibility.AccessibilityChecks
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.matcher.ViewMatchers.isRoot
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.intentic.app.ui.MainActivity
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Accessibility Scanner's checks (a label on everything that can be focused, 48dp targets, text contrast) over the whole
 * screen, each time a test acts on it: the sign-in screen, the board and a conversation, the last two filled from the
 * preview fixtures (src/preview), so no account is needed.
 */
@RunWith(AndroidJUnit4::class)
class AccessibilityTest {
    companion object {
        @BeforeClass
        @JvmStatic
        fun checks() {
            AccessibilityChecks.enable().setRunChecksFromRootView(true)
        }
    }

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun signIn() {
        ActivityScenario.launch(MainActivity::class.java).use {
            settle()
            onView(isRoot()).perform(closeSoftKeyboard())
        }
    }

    @Test
    fun board() {
        ActivityScenario.launch(MainActivity::class.java).use {
            settle()
            ActivityScenario.launch<android.app.Activity>(preview("PreviewBoard"))
            settle()
            onView(isRoot()).perform(closeSoftKeyboard())
            onView(withText("Review the store migration plan")).check { view, _ -> requireNotNull(view) }
        }
    }

    @Test
    fun conversation() {
        ActivityScenario.launch<android.app.Activity>(preview("PreviewConversation").putExtra("rows", 40)).use {
            settle(3_000)
            onView(isRoot()).perform(closeSoftKeyboard())
        }
    }

    // The preview screens live in the preview source set (debug and bench builds only), named here rather than imported.
    private fun preview(name: String): Intent = Intent().setClassName(context, "dev.intentic.app.$name")

    // The core answers in milliseconds, but a first start also loads its library and opens its store.
    private fun settle(ms: Long = 1_500) = Thread.sleep(ms)
}
