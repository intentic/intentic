import { TerminalsListSchema } from "@intentic-app/api-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The terminal's presence on the rail: how many live sessions there are RIGHT NOW, from any view, whether or
 * not the panel is mounted. The panel keeps its own imperative list (globalTerminalSource) because it relists
 * on demand around spawns, kills and restarts; this is the always-on read that lets the shell say "3 shells
 * running" while the panel is closed — the same idiom as the rail's uncommitted-changes and agent-attention
 * badges, and the reason the terminal no longer needs an icon inside the Workspace view.
 *
 * `process` sessions are excluded: dockerd and the extensions' declared background processes are always up, so
 * counting them would pin a meaningless number to the rail forever. They are not tabs in the panel either —
 * they live in its background-processes popover — so the count matches what opening the panel would show. */

const QUERY_KEY = sandboxKey(`terminal-activity`);
// Sessions come and go through paths the browser never sees (the agent's Bash, an extension's Start, a tmux
// exit), so the badge polls rather than waiting for an invalidation that no client action would fire.
const POLL_MS = 10_000;

interface TerminalActivity {
    // Live, user-facing sessions: shells, dev-server panels, agent shells, daemon jobs.
    readonly count: ComputedRef<number>;
    // Human summary for the rail tooltip — "2 shells, 1 dev server".
    readonly summary: ComputedRef<string | undefined>;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function useTerminalActivity(): TerminalActivity {
    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => TerminalsListSchema.parse(await sandboxJson(`/system/terminals`)),
        refetchInterval: POLL_MS,
    });

    const live = computed(() => (query.data.value?.sessions ?? []).filter((session) => session.running && session.kind !== `process`));

    const summary = computed<string | undefined>(() => {
        const parts = [
            [live.value.filter((session) => session.kind === `shell`).length, `shell`, `shells`],
            [live.value.filter((session) => session.kind === `panel`).length, `dev server`, `dev servers`],
            [live.value.filter((session) => session.kind === `agent`).length, `agent shell`, `agent shells`],
            [live.value.filter((session) => session.kind === `job`).length, `job`, `jobs`],
        ] as const;
        const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));
        return said.length === 0 ? undefined : said.join(`, `);
    });

    return { count: computed(() => live.value.length), summary };
}
