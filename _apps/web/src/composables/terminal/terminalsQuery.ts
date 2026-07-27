import { TerminalSessionSchema, TerminalsListSchema } from "@intentic-app/api-contract";
import { computed, type ComputedRef } from "vue";
import type { z } from "zod";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The ONE cached read of the daemon's session list behind every DECLARATIVE reader — the rail's activity badge
 * and the background-process rows (popover + capability cards). One key, so however many surfaces are mounted
 * they share a single in-flight request and a single cache entry. `pollMs` is per-OBSERVER (vue-query refetches
 * on each observer's own interval into the shared entry), so a surface needing tighter feedback after a
 * start/stop tightens its own without making the always-on rail badge poll harder.
 *
 * The terminal panel deliberately keeps its own imperative list (globalTerminalSource): it relists on demand
 * around spawns, kills and restarts and drives xterm mounting off the result — tab machinery, not rendering. */

const QUERY_KEY = sandboxKey(`terminals`);

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export const useTerminalsQuery = (pollMs: number): { sessions: ComputedRef<TerminalSession[]>; refetch: () => Promise<unknown> } => {
    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => TerminalsListSchema.parse(await sandboxJson(`/system/terminals`)).sessions,
        refetchInterval: pollMs,
    });
    return { sessions: computed(() => query.data.value ?? []), refetch: () => query.refetch() };
};
