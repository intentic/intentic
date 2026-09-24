import type { PortSummary } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxRpc } from "../client/sandboxRpc";
import { PORTS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// The sandbox's exposed ports, read at the shell so the rail shows public exposure from any view. Pushed on
// forward-table changes rather than polled; keyed PORTS.of(), not by procedure, since ext-preview's own ports view
// shares that entry. Forwards live in daemon memory, so a daemon restart drops them all, the indicator vanishing is that event.

const QUERY_KEY = PORTS.of();

// `offered` adds the servers an agent's turn left running for the person (PortSummary.job) to the forwarded ones: the
// ports Preview has something to say about.
export function usePorts(): { forwarded: ComputedRef<PortSummary[]>; offered: ComputedRef<PortSummary[]> } {
    const { query } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: () => sandboxRpc.ports.list() });
    return {
        forwarded: computed(() => (query.data.value?.ports ?? []).filter((port) => port.forwarded)),
        offered: computed(() => (query.data.value?.ports ?? []).filter((port) => port.forwarded || port.job !== undefined)),
    };
}
