import type { TerminalSessionSchema } from "@intentic/api-contract";
import { TerminalsListSchema } from "@intentic/api-contract";
import { computed, type ComputedRef, ref } from "vue";
import type { z } from "zod";
import { queryClient } from "../../lib/queryPersistence";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { TERMINALS } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// Single cache entry shared by the rail badge, background-process rows, and the panel's tab strip. Unpolled: the daemon
// pushes changes instead of each surface polling. A pending entry claims a `web-*` name from creation until the daemon
// lists it or the session ends.

// Exported so the background loader warms the exact entry every surface here observes.
export const terminalsKey = TERMINALS.of();

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export const fetchTerminals = async (): Promise<TerminalSession[]> => TerminalsListSchema.parse(await sandboxJson(`/system/terminals`)).sessions;

// How old a read may be and still count as current; mutations bypass it via refreshTerminals.
const FRESH_MS = 1000;

const pending = ref<TerminalSession[]>([]);

// Claims a name this browser just created, so it appears in the strip and count before tmux has it.
export const addPendingTerminal = (session: TerminalSession): void => {
    if (!pending.value.some((entry) => entry.name === session.name)) {
        pending.value = [...pending.value, session];
    }
};
// Gives up a claim: the tab was killed or its session ended before the daemon ever listed it.
export const dropPendingTerminal = (name: string): void => {
    pending.value = pending.value.filter((entry) => entry.name !== name);
};
// Clears every claim on a sandbox switch; they were all against the old daemon.
export const clearPendingTerminals = (): void => {
    pending.value = [];
};

// A listed name's claim is spent, so it's filtered here rather than pruned; keeps this pure and safe against a list
// that raced the handshake.
const withPending = (listed: TerminalSession[]): TerminalSession[] => {
    const known = new Set(listed.map((session) => session.name));
    return [...listed, ...pending.value.filter((entry) => !known.has(entry.name))];
};

export const useTerminalsQuery = (): { sessions: ComputedRef<TerminalSession[]>; refetch: () => Promise<unknown> } => {
    const { query } = useSandboxQuery({ queryKey: terminalsKey, queryFn: fetchTerminals });
    return { sessions: computed(() => withPending(query.data.value ?? [])), refetch: () => query.refetch() };
};

// Imperative read behind the tab strip's spawn/kill/restart relists. Cache-first within FRESH_MS; writes the shared
// entry so the badge and process rows stay in step.
export const listTerminals = async (): Promise<TerminalSession[]> => {
    const listed = await queryClient.fetchQuery({ queryKey: terminalsKey, queryFn: fetchTerminals, staleTime: FRESH_MS });
    const known = new Set(listed.map((session) => session.name));
    pending.value = pending.value.filter((entry) => !known.has(entry.name));
    return withPending(listed);
};

// Drops a session from the shared list the moment its kill is issued, ahead of the daemon's confirmation; a failed kill
// is undone by the refetch that follows.
export const removeTerminal = (name: string): void => {
    dropPendingTerminal(name);
    queryClient.setQueryData<TerminalSession[]>(terminalsKey, (listed) => listed?.filter((session) => session.name !== name));
};

// Forces the shared entry to catch up with a write the caller just made, instead of waiting for its next poll.
export const refreshTerminals = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: terminalsKey });
};
