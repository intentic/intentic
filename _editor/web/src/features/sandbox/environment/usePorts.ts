import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { PORTS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// The sandbox's exposed ports, read at the shell so the rail shows public exposure from any view. Pushed on
// forward-table changes rather than polled; shares its cache key (PORTS.of()) with ext-preview's own ports view.
// Forwards live in daemon memory, so a daemon restart drops them all, the indicator vanishing is that event.

const QUERY_KEY = PORTS.of();

export function usePorts(): { forwarded: ComputedRef<PortSummary[]> } {
    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => PortsListSchema.parse(await sandboxJson(`/ports`)),
    });
    return { forwarded: computed(() => (query.data.value?.ports ?? []).filter((port) => port.forwarded)) };
}
