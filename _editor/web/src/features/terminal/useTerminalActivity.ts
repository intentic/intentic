import { computed, type ComputedRef } from "vue";
import { plural } from "@intentic/base/format";
import { isWork, KINDS } from "./terminalMeta";
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

export function useTerminalActivity(): TerminalActivity {
    const { sessions } = useTerminalsQuery();

    const live = computed(() =>
        sessions.value.filter((session) => session.running && !KINDS[session.kind].logs && (!isWork(session) || showWorkTerminals.value)),
    );

    const summary = computed<string | undefined>(() => {
        const said = (Object.keys(KINDS) as (keyof typeof KINDS)[]).flatMap((kind) => {
            const noun = KINDS[kind].noun;
            const count = live.value.filter((session) => session.kind === kind).length;
            return noun === undefined || count === 0 ? [] : [plural(count, noun[0], noun[1])];
        });
        return said.length === 0 ? undefined : said.join(`, `);
    });

    return { count: computed(() => live.value.length), summary };
}
