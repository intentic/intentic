package dev.intentic.device.platform

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import dev.intentic.device.tools.FrameMath

/** The screen's size in pixels as it is turned now: the size of a screenshot of the whole display, and what a touch's coordinates are in. */
object ScreenMetrics {
    fun size(context: Context): FrameMath.Size {
        val windows = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= 30) {
            val bounds = windows.maximumWindowMetrics.bounds
            return FrameMath.Size(bounds.width(), bounds.height())
        }
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        windows.defaultDisplay.getRealMetrics(metrics)
        return FrameMath.Size(metrics.widthPixels, metrics.heightPixels)
    }
}
