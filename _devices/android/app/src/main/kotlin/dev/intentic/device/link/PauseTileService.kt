package dev.intentic.device.link

import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import dev.intentic.device.Graph

/**
 * The Quick Settings tile that pauses and resumes the agent. Pausing is one tap; resuming on a locked phone asks for the
 * unlock first, so the agent cannot be handed the phone back by whoever is holding it.
 */
class PauseTileService : TileService() {
    private val observer: () -> Unit = { refresh() }

    override fun onStartListening() {
        Graph.changes.add(observer)
        refresh()
    }

    override fun onStopListening() {
        Graph.changes.remove(observer)
    }

    override fun onClick() {
        if (Graph.pairings.get() == null) {
            refresh()
            return
        }
        if (!Graph.settings.paused) {
            Graph.settings.paused = true
            refresh()
        } else if (isLocked) {
            unlockAndRun {
                Graph.settings.paused = false
                refresh()
            }
        } else {
            Graph.settings.paused = false
            refresh()
        }
    }

    private fun refresh() {
        val tile = qsTile ?: return
        val paired = Graph.pairings.get() != null
        tile.label = "Intentic agent"
        tile.state = when {
            !paired -> Tile.STATE_UNAVAILABLE
            Graph.settings.paused -> Tile.STATE_INACTIVE
            else -> Tile.STATE_ACTIVE
        }
        if (Build.VERSION.SDK_INT >= 29) {
            tile.subtitle = when {
                !paired -> "Not paired"
                Graph.settings.paused -> "Paused"
                else -> "Allowed"
            }
        }
        tile.updateTile()
    }
}
