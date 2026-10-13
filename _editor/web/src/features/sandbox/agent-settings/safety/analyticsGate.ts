import type { SandboxSettings } from "@intentic/sandbox-contract";
import { type Ref, watch } from "vue";
import type { AnalyticsGate } from "../../../../app/analytics";
import { activeSandboxId } from "../../../../lib/activeSandbox";
import { rpcKey } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";

// The open sandbox's say in product analytics (settings.productAnalytics, the switch SandboxAnalytics.vue beside this
// edits), for app/analytics.ts. While a sandbox is open
// nothing is sent until its settings have answered: a sandbox that said no is not recorded while its first screen loads.
// Outside any sandbox (signing in, the account's own settings, before one was ever opened) the person's own choice is
// the whole answer. A daemon older than the switch has no field, which means allowed, as it did before.

// Routes that show nothing of a sandbox, whichever one was open last.
const OUTSIDE_SANDBOX = new Set([`settings`, `login`, `login-confirm`, `platform-unavailable`]);

export const sandboxAnalyticsGate = (routeName: Readonly<Ref<string>>): AnalyticsGate => {
    const asked = new Set<string>();
    return {
        permitted: (asking) => {
            const sandboxId = activeSandboxId.value;
            if (sandboxId === undefined || OUTSIDE_SANDBOX.has(routeName.value)) {
                return true;
            }
            const settings = queryClient.getQueryData<SandboxSettings>(rpcKey(`settings.get`));
            if (settings === undefined) {
                // Not every screen reads the settings, so ask once per sandbox, and only for someone who agreed; the
                // answer lands in the cache and reopens the gate through `watch`. In the background: a sign-in is never
                // raised for this.
                if (asking && !asked.has(sandboxId)) {
                    asked.add(sandboxId);
                    void queryClient.prefetchQuery(rpcQuery(`settings.get`, undefined, { background: true }));
                }
                return false;
            }
            return settings.productAnalytics !== false;
        },
        // A switch of sandbox or route, and every cache event: the settings answering, or an optimistic flip of the
        // switch before its write lands.
        watch: (onChange) => {
            watch([activeSandboxId, routeName], onChange, { flush: `sync` });
            queryClient.getQueryCache().subscribe(onChange);
        },
    };
};
