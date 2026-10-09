import { computed, type ComputedRef } from "vue";
import { isWork, KINDS } from "./terminalMeta";
import { useTerminalsQuery } from "./terminalsQuery";

// Live non-work session count, read from the panel's own cache entry (with pending claims).
// Excludes process sessions (own rows in useBackgroundProcesses) and work sessions, even when explicitly revealed.

// Fed by the shared list's invalidation (the daemon pushes on tmux changes) rather than its own poll or clock.

interface TerminalActivity {
    // Count of live non-work sessions (shells and dev servers).
    readonly count: ComputedRef<number>;
    // Tooltip text summarizing counts by kind, e.g. '2 shells, 1 dev server'.
    readonly summary: ComputedRef<string | undefined>;
}

export function useTerminalActivity(): TerminalActivity {
    const { sessions } = useTerminalsQuery();

    const live = computed(() =>
        sessions.value.filter((session) => session.running && !KINDS[session.kind].logs && !isWork(session)),
    );

    const summary = computed<string | undefined>(() => {
        const said = (Object.keys(KINDS) as (keyof typeof KINDS)[]).flatMap((kind) => {
            const counted = KINDS[kind].counted;
            const count = live.value.filter((session) => session.kind === kind).length;
            return counted === undefined || count === 0 ? [] : [counted(count)];
        });
        return said.length === 0 ? undefined : said.join(`, `);
    });

    return { count: computed(() => live.value.length), summary };
}
