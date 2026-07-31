import { computed, type ComputedRef } from "vue";
import { showWorkTerminals } from "./useWorkTerminals";
import { useTerminalsQuery } from "./terminalsQuery";

/* The terminal's presence on the rail: how many live sessions there are RIGHT NOW, from any view, whether or
 * not the panel is mounted. This is the always-on read that lets the shell say "3 shells running" while the
 * panel is closed — the same idiom as the rail's uncommitted-changes and agent-attention badges, and the reason
 * the terminal no longer needs an icon inside the Workspace view. It observes the SAME cache entry the panel's
 * tab strip lists from (terminalsQuery), including its pending claims, so the badge can't disagree with the
 * strip or trail a spawn/kill the user just made by a poll interval.
 *
 * `process` sessions are excluded: dockerd and the extensions' declared background processes are always up, so
 * counting them would pin a meaningless number to the rail forever. They are not tabs in the panel either —
 * they live in the background-process rows (useBackgroundProcesses), so the count matches what opening the
 * panel would show. The WORK surfaces — agent shells and daemon jobs — are excluded on the same terms while
 * `showWorkTerminals` is off: they don't tab then either, and a badge reading 3 over a strip showing 1 is
 * exactly the disagreement this composable exists to prevent. Both already have their own always-on surfaces —
 * the chat rail's status, the Capabilities page's progress — and stay one click away in the panel's
 * Recent-terminals popover, which shows a live dot of its own while any of them is running.
 *
 * The agent's BROWSER is deliberately absent: it is not a tmux session and does not tab in this panel — it has
 * a rail area of its own (ShellDesktop's browserTile, counted off browsersQuery). */

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

// The kinds the panel hides until someone asks to watch (useTerminal's `isWork`) — counted only when the
// preference puts them on the strip, so the badge and the strip can never disagree.
const WORK_KINDS = new Set([`agent`, `job`]);

export function useTerminalActivity(): TerminalActivity {
    const { sessions } = useTerminalsQuery(POLL_MS);

    const live = computed(() =>
        sessions.value.filter(
            (session) => session.running && session.kind !== `process` && (!WORK_KINDS.has(session.kind) || showWorkTerminals.value),
        ),
    );

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
