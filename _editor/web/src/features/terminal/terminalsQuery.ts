import { sandboxRef } from "@intentic/extension-api";
import type { TerminalSessionSchema } from "@intentic/api-contract";
import type { TerminalsList } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import type { z } from "zod";
import { queryClient } from "../../lib/queryPersistence";
import { rpcQuery } from "../sandbox/client/rpcQuery";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { rpcKey } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// Single cache entry shared by the rail badge, background-process rows, and the panel's tab strip. Unpolled: the daemon
// pushes changes instead of each surface polling. A pending entry claims a `web-*` name from creation until the daemon
// lists it or the session ends.

// Exported so the background loader warms the exact entry every surface here observes: the daemon's whole answer.
export const terminalsKey = rpcKey(`system.terminals`);

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export const fetchTerminals = (): Promise<TerminalsList> => sandboxRpc.system.terminals();

// How old a read may be and still count as current; mutations bypass it via refreshTerminals.
const FRESH_MS = 1000;

// Claims against one daemon's list, so a switch drops them all.
const pending = sandboxRef<TerminalSession[]>(() => []);

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

// A listed name's claim is spent, so it's filtered here rather than pruned; keeps this pure and safe against a list
// that raced the handshake.
const withPending = (listed: TerminalSession[]): TerminalSession[] => {
    const known = new Set(listed.map((session) => session.name));
    return [...listed, ...pending.value.filter((entry) => !known.has(entry.name))];
};

export const useTerminalsQuery = (): { sessions: ComputedRef<TerminalSession[]>; refetch: () => Promise<unknown> } => {
    const { query } = useSandboxQuery(rpcQuery(`system.terminals`));
    return { sessions: computed(() => withPending(query.data.value?.sessions ?? [])), refetch: () => query.refetch() };
};

// Imperative read behind the tab strip's spawn/kill/restart relists. Cache-first within FRESH_MS; writes the shared
// entry so the badge and process rows stay in step.
export const listTerminals = async (): Promise<TerminalSession[]> => {
    const { sessions: listed } = await queryClient.fetchQuery({ queryKey: terminalsKey, queryFn: fetchTerminals, staleTime: FRESH_MS });
    const known = new Set(listed.map((session) => session.name));
    pending.value = pending.value.filter((entry) => !known.has(entry.name));
    return withPending(listed);
};

// Drops a session from the shared list the moment its kill is issued, ahead of the daemon's confirmation; a failed kill
// is undone by the refetch that follows.
export const removeTerminal = (name: string): void => {
    dropPendingTerminal(name);
    queryClient.setQueryData<TerminalsList>(terminalsKey, (listed) =>
        listed === undefined ? undefined : { ...listed, sessions: listed.sessions.filter((session) => session.name !== name) },
    );
};

// Forces the shared entry to catch up with a write the caller just made, instead of waiting for its next poll.
export const refreshTerminals = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: terminalsKey });
};
