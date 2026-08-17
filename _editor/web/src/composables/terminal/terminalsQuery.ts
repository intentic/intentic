import { TerminalSessionSchema, TerminalsListSchema } from "@intentic-app/api-contract";
import { computed, type ComputedRef, ref } from "vue";
import type { z } from "zod";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { TERMINALS } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The ONE session list every surface reads — the rail's activity badge, the background-process rows, AND the
 * terminal panel's tab strip. One cache entry, so however many surfaces are mounted they share a single
 * in-flight request; and, because the panel's own relists go through `listTerminals` (which writes that entry),
 * the badge moves WITH the strip instead of trailing it.
 *
 * UNPOLLED. Three surfaces each held their own 10s timer over the tunnel, asking a question the daemon could
 * always answer better: tmux tells nobody when a pane's command exits, so the daemon watches its own tmux and
 * pushes the `terminals` domain when what it sees changes (runtime-watch.ts). One look, in the sandbox, shared
 * by every tab — instead of one round trip per surface per tab per 10s, almost always answering "no change".
 *

 * PENDING sessions are the other half of the truth. A `web-*` shell exists in tmux only once its socket connects
 * and runs `tmux new-session -A`, so from the click until that handshake the daemon does not list it. Held
 * nowhere, that gap costs both symptoms at once: the badge lags every new tab, and a list taken inside the
 * window (a poll, or the panel's own relist) DROPS the brand-new tab — orphaning a live session whose socket
 * keeps streaming into a strip that no longer shows it. A pending entry is this browser's claim on a name it
 * just created; it retires the moment the daemon lists it, or when the session ends. */

// Exported so the background loader can warm the very entry every surface here observes (prefetch/warmQuery
// insists on that being one key and one fetcher, not two spellings of them).
export const terminalsKey = TERMINALS.of();

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export const fetchTerminals = async (): Promise<TerminalSession[]> =>
    TerminalsListSchema.parse(await sandboxJson(`/system/terminals`)).sessions;

// A read at most this old counts as current. The panel relists in reaction to the shared entry's own poll, so
// without a freshness window every arriving poll would echo one redundant request back at the daemon. Mutations
// don't go through it — `refreshTerminals` forces the refetch, because a kill must not read the list that still
// contains what it just killed.
const FRESH_MS = 1000;

const pending = ref<TerminalSession[]>([]);

// Claim a name this browser just created, so it tabs and counts before tmux has it.
export const addPendingTerminal = (session: TerminalSession): void => {
    if (!pending.value.some((entry) => entry.name === session.name)) {
        pending.value = [...pending.value, session];
    }
};
// Give a claim up (the tab was killed, or its session ended, before the daemon ever listed it).
export const dropPendingTerminal = (name: string): void => {
    pending.value = pending.value.filter((entry) => entry.name !== name);
};
// Sandbox switch: every claim was against the OLD daemon.
export const clearPendingTerminals = (): void => {
    pending.value = [];
};

// A listed name is real now, so its claim is spent — filtered out here rather than pruned, so this stays pure
// and a claim can't be lost to a list that raced the socket handshake. `listTerminals` does the actual prune.
const withPending = (listed: TerminalSession[]): TerminalSession[] => {
    const known = new Set(listed.map((session) => session.name));
    return [...listed, ...pending.value.filter((entry) => !known.has(entry.name))];
};

export const useTerminalsQuery = (): { sessions: ComputedRef<TerminalSession[]>; refetch: () => Promise<unknown> } => {
    const { query } = useSandboxQuery({ queryKey: terminalsKey, queryFn: fetchTerminals });
    return { sessions: computed(() => withPending(query.data.value ?? [])), refetch: () => query.refetch() };
};

// The imperative read behind the terminal panel's tab machinery (it relists on demand around spawns, kills,
// restarts and surfaces). Cache-first within FRESH_MS, and the result lands in the SHARED entry — that write is
// what keeps the rail's badge and the process rows in step with the strip.
export const listTerminals = async (): Promise<TerminalSession[]> => {
    const listed = await queryClient.fetchQuery({ queryKey: terminalsKey, queryFn: fetchTerminals, staleTime: FRESH_MS });
    const known = new Set(listed.map((session) => session.name));
    pending.value = pending.value.filter((entry) => !known.has(entry.name));
    return withPending(listed);
};

// Drop a session from the shared list the moment its kill is ISSUED, ahead of the daemon's confirmation — the
// strip removes the tab synchronously, so without this the rail's badge would keep counting it for a tunnel
// round-trip, which is exactly what made closing a terminal feel unacknowledged. A kill that then fails is
// undone by the refetch that follows it.
export const removeTerminal = (name: string): void => {
    dropPendingTerminal(name);
    queryClient.setQueryData<TerminalSession[]>(terminalsKey, (listed) => listed?.filter((session) => session.name !== name));
};

// Force the shared entry to catch up with a write the caller just made, so every observer sees the daemon's
// own account of it rather than waiting out its next poll.
export const refreshTerminals = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: terminalsKey });
};
