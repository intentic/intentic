import type { PortSummary } from "@intentic/sandbox-contract/schemas/ports";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The sandbox's exposed ports, read at the shell so the rail shows public exposure from any view. Pushed on
// forward-table changes rather than polled; keyed by procedure, the entry ext-preview's own ports view shares. Forwards
// live in daemon memory, so a daemon restart drops them all, the indicator vanishing is that event.

// `offered` adds the servers an agent's turn left running for the person (PortSummary.job) to the forwarded ones: the
// ports Preview has something to say about.
export function usePorts(): { forwarded: ComputedRef<PortSummary[]>; offered: ComputedRef<PortSummary[]> } {
    const { query } = useSandboxQuery(rpcQuery(`ports.list`));
    return {
        forwarded: computed(() => (query.data.value?.ports ?? []).filter((port) => port.forwarded)),
        offered: computed(() => (query.data.value?.ports ?? []).filter((port) => port.forwarded || port.job !== undefined)),
    };
}
