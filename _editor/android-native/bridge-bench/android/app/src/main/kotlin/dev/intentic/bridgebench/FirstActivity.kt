package dev.intentic.bridgebench

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/** A cold start and nothing else: the library loaded the way the `mode` extra names, and one call. */
class FirstActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val run = Run(intent)
        run.start()
        setContentView(TextView(this).apply { text = "first call: ${run.mode}" })
    }
}
