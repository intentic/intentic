import { computed } from "vue";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { SYNC_HEALTH } from "../../../lib/queryKeys";

// Desktop sync's sandbox-level state (GET /system/sync), read here and nowhere else: whether sync is possible at all,
// whether any machine holds this sandbox's files, and each machine's own report. The sync badges (`useSyncHealth`) and the
// Add device card (`useDesktopSync`) are views of this one cache entry, so a daemon that cannot answer reads the same
// way in both. Cheap by design: it never fans out to a device.
//
// The daemon pushes it with the `hosts` domain whenever an enrollment is made or revoked. The poll is for what that
// push does not carry: a sync agent files its own report (POST /system/sync/report) without announcing anything, and
// "the watcher has stopped on this machine" is read from those reports.
const REPORT_POLL_MS = 60_000;

export function useSyncStatus() {
    const { query, error } = useSandboxQuery({
        queryKey: SYNC_HEALTH.of(),
        queryFn: () => sandboxRaw(`GET /system/sync`),
        refetchInterval: REPORT_POLL_MS,
    });
    return {
        status: computed(() => query.data.value),
        // The failure to read it, said in words, or undefined; never swallowed into an empty status.
        error,
        // The raw failure, for a caller that tells a daemon's refusal from silence.
        failure: computed(() => query.error.value ?? undefined),
    };
}
