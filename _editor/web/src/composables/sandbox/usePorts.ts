import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";

/* The sandbox's listening ports, read at the SHELL so the rail can show what is publicly exposed from any
 * view — a forwarded port is reachable by anyone with the hostname until it is stopped, which is a fact about
 * the sandbox the operator must not have to open a tab to learn (the same rationale as the VPN indicator).
 *
 * The daemon still runs no port poller for the ANSWER — attributing each socket to its process walks every
 * /proc fd table, which is why that scan stays on-demand per request. What it samples is only the LISTEN set
 * out of /proc/net/tcp, two file reads, enough to push the `ports` domain when the answer would differ; and it
 * publishes from the forward table itself when a port is exposed or dropped, which is the change this
 * indicator exists for and the one another member's click can cause. So this holds no clock.
 *
 * The key is `sandboxKey("ports")`, which is exactly what ext-preview's own view asks for through
 * api.sandbox.key("ports"), so the open view and this indicator share ONE cache entry, one in-flight request,
 * and one push rather than scanning procfs twice.
 *
 * Forwards live in daemon memory, so a daemon restart drops them all — the indicator disappearing IS that
 * event, which is the other thing nothing in the UI said before. */

const QUERY_KEY = sandboxKey(`ports`);

export function usePorts(): { forwarded: ComputedRef<PortSummary[]> } {
    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => PortsListSchema.parse(await sandboxJson(`/ports`)),
    });
    return { forwarded: computed(() => (query.data.value?.ports ?? []).filter((port) => port.forwarded)) };
}
