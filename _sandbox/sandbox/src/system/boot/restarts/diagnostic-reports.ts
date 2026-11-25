import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/* NODE'S DIAGNOSTIC REPORTS ARE KEPT BOUNDED (2026-11-24). The daemon writes one into the logs directory when it dies on a
   fatal error (--report-on-fatalerror), and one when netd, about to kill it stuck, asks with SIGUSR2
   (--report-on-signal, docker-entrypoint.sh); a crash loop or a run of stuck kills would otherwise leave them piling up
   on the history volume. Each boot reads what the run before it left (boot-marker.ts fatalReports, and the post-mortem
   through netd's kill lines) and then keeps only the newest REPORTS_KEPT. netd bounds its own /proc captures beside them
   (netd's evidence.rs). */

// A report is some hundreds of KB; enough to compare the last few incidents.
const REPORTS_KEPT = 10;

// Node's name for one: report.<date>.<time>.<pid>.<thread>.<sequence>.json, so by name is by when it was written.
const REPORT_NAME = /^report\.\d+\.\d+\.\d+\.\d+\.\d+\.json$/u;

/** Deletes all but the newest `keep` diagnostic reports in `logsDir`; answers how many it deleted. Never throws. */
export const pruneDiagnosticReports = (logsDir: string, keep = REPORTS_KEPT): number => {
    let names: string[];
    try {
        // allow(daemon-sync-io): boot-only, inside the synchronous boot-marker claim, before the daemon serves anything
        names = readdirSync(logsDir).filter((name) => REPORT_NAME.test(name));
    } catch {
        // allow(silent-catch): no logs directory yet is nothing to prune
        return 0;
    }
    let deleted = 0;
    for (const name of names.toSorted().slice(0, Math.max(0, names.length - keep))) {
        try {
            // allow(daemon-sync-io): boot-only, at most a handful of files once per start
            rmSync(join(logsDir, name), { force: true });
            deleted += 1;
        } catch {
            // allow(silent-catch): a report that cannot be deleted is tried again at the next boot
        }
    }
    return deleted;
};
