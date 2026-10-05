package dev.intentic.device.link

import dev.intentic.device.protocol.DialPolicy
import dev.intentic.device.protocol.PhoneWire
import dev.intentic.device.store.LinkMode
import dev.intentic.device.store.Pairing
import java.util.concurrent.Executor
import kotlin.math.max

/** Where the link stands, as the owner reads it. "Paused" is separate: it is a switch, and the link can be up while paused. */
enum class LinkState {
    /** No sandbox is paired. */
    UNPAIRED,

    /** Paired and not connected, because nothing is asking: the phone is asleep and the sandbox can wake it. */
    IDLE,

    /** Dialling, or open and waiting for the sandbox to speak. */
    CONNECTING,

    /** The sandbox has spoken on an open socket. */
    CONNECTED,

    /** The last attempt failed and the next waits on the backoff ladder. */
    WAITING,
}

/** One WebSocket, as the controller sees it. OkHttp's in the app, a fake in a test. */
interface LinkSocket {
    fun send(text: String): Boolean

    /** A polite close with a code, as for an idle link. */
    fun close(code: Int, reason: String)

    /** Abandons the socket without waiting for the far end, which may be gone. */
    fun cancel()
}

interface LinkSocketListener {
    fun onOpen()

    fun onMessage(text: String)

    /** The socket ended, closed by the far end with [code] or failed with null. Called once per socket. */
    fun onEnded(code: Int?)
}

fun interface LinkSocketFactory {
    fun open(url: String, listener: LinkSocketListener): LinkSocket
}

interface Timer {
    fun cancel()
}

/** One thread that every change to the controller runs on, and the clock it reads. */
interface Scheduler {
    fun now(): Long

    /** Runs [task] on the controller's thread, after any task already running. */
    fun post(task: () -> Unit)

    fun postDelayed(delayMs: Long, task: () -> Unit): Timer
}

/** What the controller asks of the phone around it. */
interface LinkHost {
    fun pairing(): Pairing?

    fun mode(): LinkMode

    /** The sandbox closed with "revoked" (1008): forget the pairing and everything granted under it. */
    fun forgetPairing()

    /** Whether the foreground service that holds the connection should be running. */
    fun serviceWanted(wanted: Boolean)

    fun stateChanged(state: LinkState)

    /** The socket is gone, by any cause: screen capture ends with it. */
    fun connectionEnded()

    /** A line for the owner's activity log. */
    fun note(text: String)
}

/**
 * Holds the one WebSocket to the sandbox and decides when it should exist.
 *
 * - "Stay connected": always dialled, on the backoff ladder ([DialPolicy]).
 * - "On demand": dialled when asked ([wake]: the app opened, a push arrived) and closed normally after
 *   [PhoneWire.LINGER_MS] without a `tools/call` ([activity]).
 * - Closed 1008 by the sandbox means the pairing is revoked: it is forgotten and dialling stops for good. Every other
 *   close, and silence for three heartbeats, is a retry.
 *
 * Every public method may be called from any thread; each does its work on the [Scheduler]'s thread. Requests from
 * the sandbox are answered on [worker], so a slow tool never holds up the socket's own traffic.
 */
class LinkController(
    private val host: LinkHost,
    private val sockets: LinkSocketFactory,
    private val scheduler: Scheduler,
    private val version: String,
    private val answer: (String) -> String?,
    private val worker: Executor,
) {
    @Volatile
    var state: LinkState = if (host.pairing() == null) LinkState.UNPAIRED else LinkState.IDLE
        private set

    private var policy = DialPolicy()
    private var socket: LinkSocket? = null
    private var generation = 0
    private var openedAt: Long? = null
    private var lingerUntil = 0L
    private var dialTimer: Timer? = null
    private var watchdog: Timer? = null
    private var lingerTimer: Timer? = null

    /** Something wants the phone awake now: connect, and stay for the linger. */
    fun wake() = scheduler.post {
        lingerUntil = max(lingerUntil, scheduler.now() + PhoneWire.LINGER_MS)
        if (socket == null) {
            // A fresh reason to connect is not an automatic retry: the ladder's wait is for the latter.
            dialTimer?.cancel()
            dialTimer = null
        }
        ensureDialing()
        scheduleLinger()
    }

    /** A `tools/call` arrived: the agent is still here. */
    fun activity() = scheduler.post {
        lingerUntil = scheduler.now() + PhoneWire.LINGER_MS
        scheduleLinger()
    }

    /** The owner changed the mode. */
    fun settingsChanged() = scheduler.post {
        if (host.mode() == LinkMode.ON_DEMAND) {
            lingerUntil = max(lingerUntil, scheduler.now() + PhoneWire.LINGER_MS)
        }
        ensureDialing()
        scheduleLinger()
    }

    /** The pairing was saved, replaced or cleared. */
    fun pairingChanged() = scheduler.post {
        closeNormally("pairing changed")
        dialTimer?.cancel()
        dialTimer = null
        policy = DialPolicy()
        if (host.pairing() == null) {
            setState(LinkState.UNPAIRED)
            host.serviceWanted(false)
        } else {
            lingerUntil = scheduler.now() + PhoneWire.LINGER_MS
            setState(LinkState.IDLE)
            ensureDialing()
            scheduleLinger()
        }
    }

    /** Closes the link and stops dialling; the owner unpaired or the app is going. */
    fun stop() = scheduler.post {
        closeNormally("stopping")
        dialTimer?.cancel()
        dialTimer = null
        setState(if (host.pairing() == null) LinkState.UNPAIRED else LinkState.IDLE)
        host.serviceWanted(false)
    }

    private fun wanted(): Boolean = host.pairing() != null && (host.mode() == LinkMode.STAY || scheduler.now() < lingerUntil)

    private fun ensureDialing() {
        if (socket != null || dialTimer != null) {
            return
        }
        if (host.pairing() == null) {
            setState(LinkState.UNPAIRED)
            return
        }
        if (wanted()) {
            dial()
        }
    }

    private fun dial() {
        val pairing = host.pairing() ?: return
        host.serviceWanted(true)
        val mine = ++generation
        setState(LinkState.CONNECTING)
        socket = sockets.open(
            PhoneWire.connectUrl(pairing.sandboxUrl),
            object : LinkSocketListener {
                override fun onOpen() = scheduler.post { opened(mine) }

                override fun onMessage(text: String) = scheduler.post { inbound(mine, text) }

                override fun onEnded(code: Int?) = scheduler.post { ended(mine, code) }
            },
        )
        armWatchdog(mine)
    }

    private fun opened(mine: Int) {
        if (mine != generation) {
            return
        }
        val pairing = host.pairing() ?: return
        openedAt = scheduler.now()
        policy.opened()
        socket?.send(PhoneWire.hello(pairing.token, version))
        if (host.mode() == LinkMode.ON_DEMAND) {
            lingerUntil = max(lingerUntil, scheduler.now() + PhoneWire.LINGER_MS)
            scheduleLinger()
        }
    }

    private fun inbound(mine: Int, text: String) {
        if (mine != generation) {
            return
        }
        armWatchdog(mine)
        if (state != LinkState.CONNECTED) {
            setState(LinkState.CONNECTED)
        }
        worker.execute {
            val reply = answer(text) ?: return@execute
            scheduler.post {
                if (mine == generation) {
                    socket?.send(reply)
                }
            }
        }
    }

    private fun ended(mine: Int, code: Int?) {
        if (mine != generation) {
            return
        }
        dropped(code)
    }

    private fun dropped(code: Int?) {
        generation += 1
        watchdog?.cancel()
        lingerTimer?.cancel()
        socket = null
        val held = openedAt?.let { scheduler.now() - it } ?: 0L
        openedAt = null
        host.connectionEnded()
        if (code == PhoneWire.Close.UNAUTHORIZED) {
            host.note("The sandbox no longer recognizes this phone, so the pairing was removed.")
            host.forgetPairing()
            policy = DialPolicy()
            setState(LinkState.UNPAIRED)
            host.serviceWanted(false)
            return
        }
        val delay = policy.dropped(held)
        if (!wanted()) {
            setState(LinkState.IDLE)
            host.serviceWanted(false)
            return
        }
        setState(LinkState.WAITING)
        dialTimer = scheduler.postDelayed(delay) {
            dialTimer = null
            if (wanted()) {
                ensureDialing()
            } else {
                // Nobody asked for the link in the meantime (the linger ran out while it was retrying): back to sleep.
                setState(LinkState.IDLE)
                host.serviceWanted(false)
            }
        }
    }

    /** Three heartbeats with nothing heard: the link is dead, and a close frame sent to an end that is gone would wait on a reply. */
    private fun armWatchdog(mine: Int) {
        watchdog?.cancel()
        watchdog = scheduler.postDelayed(PhoneWire.SILENCE_MS) {
            if (mine == generation) {
                val dead = socket
                dropped(null)
                dead?.cancel()
            }
        }
    }

    private fun scheduleLinger() {
        lingerTimer?.cancel()
        lingerTimer = null
        if (host.mode() != LinkMode.ON_DEMAND || socket == null) {
            return
        }
        lingerTimer = scheduler.postDelayed(max(0L, lingerUntil - scheduler.now())) { lingerElapsed() }
    }

    private fun lingerElapsed() {
        lingerTimer = null
        if (host.mode() != LinkMode.ON_DEMAND || socket == null) {
            return
        }
        if (scheduler.now() < lingerUntil) {
            scheduleLinger()
            return
        }
        closeNormally("no request for a while")
        setState(LinkState.IDLE)
        host.serviceWanted(false)
    }

    /** Closes the socket with a normal close and forgets it, so what it still says is ignored. */
    private fun closeNormally(reason: String) {
        val held = socket
        generation += 1
        watchdog?.cancel()
        lingerTimer?.cancel()
        lingerTimer = null
        socket = null
        openedAt = null
        if (held != null) {
            held.close(PhoneWire.Close.NORMAL, reason)
            host.connectionEnded()
        }
    }

    private fun setState(next: LinkState) {
        if (state != next) {
            state = next
            host.stateChanged(next)
        }
    }
}
