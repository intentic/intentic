package dev.intentic.device.update

import android.app.job.JobParameters
import android.app.job.JobService

/** The daily look for a newer version, run by Android's job scheduler when the network is up. */
class UpdateJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread({
            try {
                DirectUpdater.checkNow(announce = true)
            } finally {
                jobFinished(params, false)
            }
        }, "intentic-update-job").start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = false
}
