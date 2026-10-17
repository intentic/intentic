package dev.intentic.device.wear

import android.content.Context
import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import dev.intentic.device.Graph
import dev.intentic.device.ui.MainActivity

/**
 * The watch's pause switch, as a tile beside the watch face: a watch has no Quick Settings tile of its own to offer.
 * Pausing is one tap here. Resuming opens the app instead, as resuming from the phone's notification takes an unlocked
 * phone: handing the agent the device back is never one stray tap.
 */
class PauseWearTile : TileService() {
    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        if (requestParams.currentState.lastClickableId == ID_PAUSE && Graph.pairings.get() != null && !Graph.settings.paused) {
            Graph.settings.paused = true
        }
        return now(tile())
    }

    override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        now(ResourceBuilders.Resources.Builder().setVersion(RESOURCES).build())

    private fun tile(): TileBuilders.Tile {
        val paired = Graph.pairings.get() != null
        val paused = Graph.settings.paused
        val state = when {
            !paired -> "Not paired"
            paused -> "Paused"
            else -> "Allowed"
        }
        val pausing = paired && !paused
        val click = ModifiersBuilders.Clickable.Builder()
            .setId(if (pausing) ID_PAUSE else ID_OPEN)
            .setOnClick(if (pausing) ActionBuilders.LoadAction.Builder().build() else openApp())
            .build()
        val button = LayoutElementBuilders.Box.Builder()
            .setWidth(dp(112f))
            .setHeight(dp(48f))
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setClickable(click)
                    .setBackground(
                        ModifiersBuilders.Background.Builder()
                            .setColor(argb(if (pausing) ACCENT else SURFACE))
                            .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(24f)).build())
                            .build(),
                    )
                    .setSemantics(ModifiersBuilders.Semantics.Builder().setContentDescription(if (pausing) "Pause the agent" else "Open Intentic").build())
                    .build(),
            )
            .addContent(text(if (pausing) "Pause" else if (paired) "Resume" else "Open", 15f, WHITE))
            .build()
        val column = LayoutElementBuilders.Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text("Intentic agent", 13f, MUTED))
            .addContent(text(state, 18f, WHITE))
            .addContent(LayoutElementBuilders.Spacer.Builder().setHeight(dp(10f)).build())
            .addContent(button)
            .build()
        val root = LayoutElementBuilders.Box.Builder()
            .setWidth(expand())
            .setHeight(expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .addContent(column)
            .build()
        return TileBuilders.Tile.Builder()
            .setResourcesVersion(RESOURCES)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
            .build()
    }

    // The watch's system UI starts it, so it has to be an exported activity: the launcher's, which hands over to the
    // watch's own screen.
    private fun openApp(): ActionBuilders.LaunchAction =
        ActionBuilders.LaunchAction.Builder()
            .setAndroidActivity(
                ActionBuilders.AndroidActivity.Builder()
                    .setPackageName(packageName)
                    .setClassName(MainActivity::class.java.name)
                    .build(),
            )
            .build()

    private fun text(value: String, size: Float, color: Int): LayoutElementBuilders.Text =
        LayoutElementBuilders.Text.Builder()
            .setText(value)
            .setFontStyle(LayoutElementBuilders.FontStyle.Builder().setSize(sp(size)).setColor(argb(color)).build())
            .build()

    private fun <T : Any> now(value: T): ListenableFuture<T> = CallbackToFutureAdapter.getFuture { completer ->
        completer.set(value)
        "intentic-tile"
    }

    companion object {
        private const val RESOURCES = "1"
        private const val ID_PAUSE = "pause"
        private const val ID_OPEN = "open"
        private const val WHITE = 0xFFFFFFFF.toInt()
        private const val MUTED = 0xFFB0B7C3.toInt()
        private const val ACCENT = 0xFF2563EB.toInt()
        private const val SURFACE = 0xFF303846.toInt()

        /** Asks the watch to draw the tile again, after the pause switch or the pairing changed. */
        fun refresh(context: Context) {
            getUpdater(context).requestUpdate(PauseWearTile::class.java)
        }
    }
}
