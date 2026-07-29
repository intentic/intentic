import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";

/* The sandbox's listening ports, read at the SHELL so the rail can show what is publicly exposed from any
 * view — a forwarded port is reachable by anyone with the hostname until it is stopped, which is a fact about
 * the sandbox the operator must not have to open a tab to learn (the same rationale as the VPN indicator).
 *
 * The daemon deliberately runs no background port poller — the scan is on-demand per request — so this adds
 * the one poll the shell needs and keeps it slow: forwarding is a user/agent gesture, not a drifting state.
 * The key is `sandboxKey("ports")`, which is exactly what ext-preview's own view asks for through
 * api.sandbox.key("ports"), so the open view and this indicator share ONE cache entry and one in-flight
 * request rather than scanning procfs twice.
 *
 * Forwards live in daemon memory, so a daemon restart drops them all — the indicator disappearing IS that
 * event, which is the other thing nothing in the UI said before. */

const QUERY_KEY = sandboxKey(`ports`);
const POLL_MS = 15_000;

export function usePorts(): { forwarded: ComputedRef<PortSummary[]> } {
    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => PortsListSchema.parse(await sandboxJson(`/ports`)),
        refetchInterval: POLL_MS,
    });
    return { forwarded: computed(() => (query.data.value?.ports ?? []).filter((port) => port.forwarded)) };
}
