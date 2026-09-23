import { computed, nextTick, ref, type Ref, watch } from "vue";
import type { TerminalSession } from "../terminalSession";

// Find over the active session's whole buffer, like a local terminal: matches paint in place and on the scrollbar, and
// Enter walks them. The highlights follow the active tab, leaving the one that lost focus, and clear when the bar closes
// or the panel goes (`unbindFind`, before the panes are parked); the result count is the addon's, -1 past 1000 matches.

// Yellow, the palette's 'look here' colour; the active match saturates so it stands out among the rest.
const FIND_DECORATIONS = {
    matchBackground: `#facc1540`,
    matchBorder: `#facc1580`,
    matchOverviewRuler: `#facc15`,
    activeMatchBackground: `#facc15a0`,
    activeMatchBorder: `#facc15`,
    activeMatchColorOverviewRuler: `#fde047`,
};

export interface TerminalFindHost {
    readonly activeName: Readonly<Ref<string | undefined>>;
    readonly sessionOf: (name: string) => Pick<TerminalSession, `search` | `term`> | undefined;
}

export const useTerminalFind = ({ activeName, sessionOf }: TerminalFindHost) => {
    const finding = ref(false);
    const findQuery = ref(``);
    const findInput = ref<HTMLInputElement>();
    // Undefined until a query has run.
    const findResults = ref<{ index: number; count: number } | undefined>(undefined);
    // The session whose highlights are up and whose results are bound, so a tab switch clears one before painting the next.
    let bound: { search: TerminalSession[`search`]; results: { dispose: () => void } } | undefined;

    const activeSession = () => (activeName.value === undefined ? undefined : sessionOf(activeName.value));

    const unbindFind = (): void => {
        bound?.results.dispose();
        bound?.search.clearDecorations();
        bound = undefined;
        findResults.value = undefined;
    };

    const bind = (session: Pick<TerminalSession, `search`>): void => {
        unbindFind();
        bound = {
            search: session.search,
            results: session.search.onDidChangeResults(({ resultIndex, resultCount }) => {
                findResults.value = { index: resultIndex, count: resultCount };
            }),
        };
    };

    const runFind = (incremental: boolean): void => {
        const session = activeSession();
        if (session === undefined) {
            return;
        }
        if (bound?.search !== session.search) {
            bind(session);
        }
        if (findQuery.value === ``) {
            session.search.clearDecorations();
            findResults.value = undefined;
            return;
        }
        session.search.findNext(findQuery.value, { incremental, decorations: FIND_DECORATIONS });
    };
    const findNext = (): void => runFind(false);
    const findPrevious = (): void => {
        const session = activeSession();
        if (session !== undefined && findQuery.value !== ``) {
            session.search.findPrevious(findQuery.value, { decorations: FIND_DECORATIONS });
        }
    };

    const openFind = (): void => {
        if (activeName.value === undefined) {
            return;
        }
        finding.value = true;
        void nextTick(() => {
            findInput.value?.focus();
            findInput.value?.select();
        });
        if (findQuery.value !== ``) {
            runFind(true);
        }
    };

    // Esc, or the ×: hands the keyboard back to the terminal and clears the highlights.
    const closeFind = (): void => {
        finding.value = false;
        unbindFind();
        activeSession()?.term.focus();
    };

    const findLabel = computed((): string => {
        const results = findResults.value;
        if (results === undefined) {
            return ``;
        }
        if (results.count === 0) {
            return `No results`;
        }
        return `${String(results.index + 1)} of ${results.count < 0 ? `many` : String(results.count)}`;
    });

    watch(activeName, () => {
        if (finding.value) {
            runFind(true);
        }
    });

    return { finding, findQuery, findInput, findLabel, runFind, findNext, findPrevious, openFind, closeFind, unbindFind };
};
