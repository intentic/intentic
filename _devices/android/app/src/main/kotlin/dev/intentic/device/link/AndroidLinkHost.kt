package dev.intentic.device.link

import android.app.Application
import dev.intentic.device.Graph
import dev.intentic.device.store.LinkMode
import dev.intentic.device.store.Pairing

/** The phone around the link controller: where the pairing is kept, the foreground service that holds the link, the log. */
class AndroidLinkHost(private val app: Application) : LinkHost {
    override fun pairing(): Pairing? = Graph.pairings.get()

    override fun mode(): LinkMode = Graph.settings.mode

    override fun forgetPairing() {
        // The controller has already noted why; everything allowed under the pairing goes with it.
        Graph.unpair(null)
    }

    override fun serviceWanted(wanted: Boolean) {
        if (wanted) {
            if (!ConnectionService.running) {
                ConnectionService.start(app)
            }
        } else {
            ConnectionService.stop(app)
        }
    }

    override fun stateChanged(state: LinkState) {
        Graph.changes.fire()
    }

    override fun connectionEnded() {
        Graph.screen.stop()
    }

    override fun note(text: String) {
        Graph.log.event(text)
    }
}
