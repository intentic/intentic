package dev.intentic.device.touch

import dev.intentic.device.FakePhone
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppMode
import dev.intentic.device.tools.FrameMath
import dev.intentic.device.tools.Shot
import org.json.JSONObject

/** A node of a screen made up in a test. */
class FakeNode : UiNode {
    override var packageName: String? = "com.app"
    override var className: String? = "android.widget.TextView"
    override var text: CharSequence? = null
    override var contentDescription: CharSequence? = null
    override var hintText: CharSequence? = null
    override var bounds: Bounds = Bounds(0, 0, 200, 80)
    override var isVisibleToUser: Boolean = true
    override var isClickable: Boolean = false
    override var isLongClickable: Boolean = false
    override var isEditable: Boolean = false
    override var isFocusable: Boolean = false
    override var isFocused: Boolean = false
    override var isCheckable: Boolean = false
    override var isChecked: Boolean = false
    override var isEnabled: Boolean = true
    override var isScrollable: Boolean = false
    override var isPassword: Boolean = false
    override var isShowingHint: Boolean = false
    override var parent: UiNode? = null
    private val kids = ArrayList<FakeNode>()
    override val children: List<UiNode> get() = kids

    /** What was done to this node, in order. */
    val performed = ArrayList<String>()
    var gone = false
    var clickWorks = true
    var longClickWorks = true
    var setTextWorks = true
    var focusWorks = true
    var scrollWorks = true

    fun add(vararg nodes: FakeNode): FakeNode {
        for (node in nodes) {
            node.parent = this
            kids += node
        }
        return this
    }

    override fun refresh(): Boolean = !gone

    override fun click(): Boolean {
        performed += "click"
        return clickWorks
    }

    override fun longClick(): Boolean {
        performed += "longClick"
        return longClickWorks
    }

    override fun setText(text: String): Boolean {
        performed += "setText:$text"
        if (setTextWorks) {
            this.text = text
            isShowingHint = false
        }
        return setTextWorks
    }

    override fun requestFocus(): Boolean {
        performed += "focus"
        if (focusWorks) isFocused = true
        return focusWorks
    }

    override fun scroll(direction: ScrollDirection): Boolean {
        performed += "scroll:$direction"
        return scrollWorks
    }
}

fun node(init: FakeNode.() -> Unit = {}): FakeNode = FakeNode().apply(init)

fun label(text: String, at: Bounds = Bounds(0, 0, 200, 80)): FakeNode = node { this.text = text; bounds = at }

fun button(text: String, at: Bounds = Bounds(0, 0, 200, 80)): FakeNode = node {
    className = "android.widget.Button"
    this.text = text
    isClickable = true
    bounds = at
}

fun field(hint: String?, value: String?, at: Bounds = Bounds(0, 0, 400, 80), password: Boolean = false): FakeNode = node {
    className = "android.widget.EditText"
    hintText = hint
    text = value
    isEditable = true
    isFocusable = true
    isPassword = password
    bounds = at
}

fun screenOf(vararg nodes: FakeNode): FakeNode = node { bounds = Bounds(0, 0, 1080, 2400) }.add(*nodes)

/** The accessibility service, as a test plays it. */
class FakeTouchPort : TouchPort {
    var isBound = true
    var foreground: Foreground? = Foreground("com.app", "App")
    var tree: UiNode? = null
    var size = FrameMath.Size(1080, 2400)
    var focused: UiNode? = null
    var gesturesWork = true
    var navigationWorks = true
    val touches = ArrayList<Triple<Int, Int, Long>>()
    val swipes = ArrayList<List<Int>>()
    val navigations = ArrayList<Nav>()
    /** Runs when the person is asked, so a test can move the screen on while they think. */
    var onWaiting: () -> Unit = {}

    override fun bound(): Boolean = isBound
    override fun foreground(): Foreground? = foreground
    override fun root(): UiNode? = tree
    override fun screenSize(): FrameMath.Size = size
    override fun focusedInput(): UiNode? = focused

    override fun touch(x: Int, y: Int, holdMs: Long): Boolean {
        touches += Triple(x, y, holdMs)
        return gesturesWork
    }

    override fun swipe(fromX: Int, fromY: Int, toX: Int, toY: Int, durationMs: Long): Boolean {
        swipes += listOf(fromX, fromY, toX, toY, durationMs.toInt())
        return gesturesWork
    }

    override fun navigate(nav: Nav): Boolean {
        navigations += nav
        return navigationWorks
    }
}

/** A phone with the three touch tools on it, a fake service, and a person who answers the questions the way a test says. */
class TouchRig {
    val port = FakeTouchPort()

    /** What the person did with the last question: true allows, false denies, null leaves it unanswered. */
    var answer: Boolean? = true
    val asked = ArrayList<Pair<String, String>>()
    val slept = ArrayList<Long>()
    var paused = false
    private lateinit var confirmations: Confirmations
    lateinit var env: TouchEnv
    val phone: FakePhone

    init {
        phone = FakePhone { deps ->
            confirmations = Confirmations(
                sink = object : PromptSink {
                    override fun show(id: Int, title: String, text: String) {
                        asked += title to text
                        port.onWaiting()
                        answer?.let { confirmations.answer(id, it) }
                    }

                    override fun dismiss(id: Int) = Unit
                },
                paused = { paused },
                timeoutMs = 150,
                pollMs = 10,
            )
            val policy = AppPolicy(
                ownPackage = "dev.intentic.device",
                launchers = { setOf("com.launcher") },
                allowed = deps.allowList::find,
                destructiveOn = { deps.scopes()?.allows(dev.intentic.device.policy.Switch.DESTRUCTIVE) == true },
            )
            env = TouchEnv(port, deps.scopes, policy, confirmations, deps.frames, deps.screen, sleep = { slept += it })
            listOf(UiElementsTool(env), UiActTool(env), DeviceTool(env))
        }
        phone.grant("screen", "control")
        allow("com.app", "App", AppMode.ACT)
        withScreenshot()
    }

    fun allow(pkg: String, label: String, mode: AppMode, sensitive: Boolean = false) = phone.allowList.put(AllowedApp(pkg, label, mode, sensitive))

    /** A screenshot the phone can take (it can by default): 705x1568 of a 1080x2400 screen. */
    fun withScreenshot() {
        phone.screen.shot = Shot(byteArrayOf(1, 2, 3), 705, 1568, 1080, 2400)
    }

    fun call(tool: String, vararg args: Pair<String, Any>): JSONObject = phone.toolCall(tool, JSONObject().also { json -> args.forEach { json.put(it.first, it.second) } })

    fun text(result: JSONObject): String = result.getJSONArray("content").getJSONObject(0).getString("text")

    fun isError(result: JSONObject): Boolean = result.getBoolean("isError")
}
