import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { type Ref, watch } from "vue";
import type { AnalyticsGate } from "../../../app/analytics";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandbox } from "../../../client/sandbox/useSandbox";

// The open sandbox's say in product analytics (settings.productAnalytics, the switch SandboxAnalytics.vue beside this
// edits), for app/analytics.ts. While a sandbox is open
// nothing is sent until its settings have answered: a sandbox that said no is not recorded while its first screen loads.
// Outside any sandbox (signing in, the account's own settings, before one was ever opened) the person's own choice is
// the whole answer. A daemon older than the switch has no field, which means allowed, as it did before.

//
// ASKED ONCE PER CONNECTION, KEPT FOR THE PAGE (2026-10-28). The gate first asks at boot, before the daemon is reachable,
// and it used to ask only once per sandbox for the page's life: a read that failed there (the box still waking, the
// session not yet renewed) was never asked again, and an answer nobody else observed was dropped from the cache after
// vue-query's five-minute gcTime, which closed the gate for good. Either way a person who had agreed sent nothing until
// some screen that reads the settings (Privacy shield, a chat) fetched them. Now it asks only while the daemon is
// reachable, asks again each time it becomes reachable, and keeps its answer for the page (gcTime Infinity).

// Routes that show nothing of a sandbox, whichever one was open last.
const OUTSIDE_SANDBOX = new Set([`settings`, `login`, `login-confirm`, `platform-unavailable`]);

export const sandboxAnalyticsGate = (routeName: Readonly<Ref<string>>): AnalyticsGate => {
    const { reachable } = useSandbox();
    // Sandboxes asked since the daemon last became reachable; cleared on each (re)connect, so a failed read is retried.
    const asked = new Set<string>();
    watch(
        reachable,
        (now) => {
            if (now) {
                asked.clear();
            }
        },
        { flush: `sync` },
    );
    return {
        permitted: (asking) => {
            const sandboxId = activeSandboxId.value;
            if (sandboxId === undefined || OUTSIDE_SANDBOX.has(routeName.value)) {
                return true;
            }
            const settings = queryClient.getQueryData<SandboxSettings>(rpcKey(`settings.get`));
            if (settings === undefined) {
                // Not every screen reads the settings, so ask once per connection, and only for someone who agreed; the
                // answer lands in the cache and reopens the gate through `watch`. In the background: a sign-in is never
                // raised for this. Kept for the page, since no observer may hold it once it lands.
                if (asking && reachable.value && !asked.has(sandboxId)) {
                    asked.add(sandboxId);
                    void queryClient.prefetchQuery({ ...rpcQuery(`settings.get`, undefined, { background: true }), gcTime: Number.POSITIVE_INFINITY });
                }
                return false;
            }
            return settings.productAnalytics !== false;
        },
        // A switch of sandbox or route, the daemon becoming reachable, and every cache event: the settings answering, or
        // an optimistic flip of the switch before its write lands.
        watch: (onChange) => {
            watch([activeSandboxId, routeName, reachable], onChange, { flush: `sync` });
            queryClient.getQueryCache().subscribe(onChange);
        },
    };
};
