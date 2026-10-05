package dev.intentic.device.platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import dev.intentic.device.Graph

/**
 * Opened by the "Your agent asks to see the screen" notification, only ever by the owner's tap. It shows Android's own
 * screen-sharing dialog, where the owner chooses what is shared or says no, and hands an approval to [ProjectionService].
 * It has no content of its own.
 */
class ScreenConsentActivity : ComponentActivity() {
    private val consent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null && !Graph.settings.paused) {
            ContextCompat.startForegroundService(
                this,
                Intent(this, ProjectionService::class.java)
                    .putExtra(ProjectionService.EXTRA_RESULT_CODE, result.resultCode)
                    .putExtra(ProjectionService.EXTRA_DATA, data),
            )
        } else {
            Graph.log.event("The owner did not approve screen sharing")
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Graph.settings.paused) {
            Toast.makeText(this, "The agent is paused. Resume it first.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        if (savedInstanceState == null) {
            val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            consent.launch(manager.createScreenCaptureIntent())
        }
    }
}
