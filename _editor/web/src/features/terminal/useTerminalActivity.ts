import { computed, type ComputedRef } from "vue";
import { showWorkTerminals } from "./useWorkTerminals";
import { useTerminalsQuery } from "./terminalsQuery";

// Live-session count for the rail, read from the panel's own cache entry (with pending claims) so the two can't
// disagree. Excludes `process` sessions (own rows in useBackgroundProcesses) and, while showWorkTerminals is off, WORK
// sessions; the browser has its own rail area and isn't a tmux session.

// Fed by the shared list's invalidation (the daemon pushes on tmux changes) rather than its own poll or clock.

interface TerminalActivity {
    // Count of live sessions currently shown as tabs (shells, dev servers, agent shells, jobs).
    readonly count: ComputedRef<number>;
    // Tooltip text summarizing counts by kind, e.g. '2 shells, 1 dev server'.
    readonly summary: ComputedRef<string | undefined>;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// Kinds counted only once showWorkTerminals is on, keeping the badge and the strip in agreement.
const WORK_KINDS = new Set([`agent`, `job`]);

export function useTerminalActivity(): TerminalActivity {
    const { sessions } = useTerminalsQuery();

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
