import { t } from "@intentic/ui/i18n";
import { computed, onScopeDispose, ref, watch } from "vue";
import type { TerminalTabs } from "../useTerminal";
import { clearTerminalRequest, type TerminalRequest } from "../useTerminalPanel";

// What an empty panel is waiting for and says about it. `pending` is the wait itself, a standing one the session list
// resolves whenever the session appears; after a few seconds the panel stops holding itself empty and says what it is
// still waiting for, rather than spinning with nothing behind it.

// Long enough for a slow start, short enough not to look stuck (ms).
const WAIT_MS = 6_000;

export interface PanelWaitHost {
    readonly tabs: Pick<TerminalTabs, `pending` | `answer` | `focus`>;
    // The request the panel opened for, if any.
    readonly initial: TerminalRequest | undefined;
}

export const usePanelWait = ({ tabs, initial }: PanelWaitHost) => {
    const { pending, answer } = tabs;
    const about = ref<TerminalRequest | undefined>(initial);
    const waited = ref(false);
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    watch(
        pending,
        (name) => {
            clearTimeout(waitTimer);
            waited.value = false;
            if (name !== undefined) {
                waitTimer = setTimeout(() => (waited.value = true), WAIT_MS);
            }
        },
        { immediate: true },
    );
    onScopeDispose(() => clearTimeout(waitTimer));

    // What the panel calls itself while empty: the session it waits for, else the one it was asked about, by name.
    const named = computed(() => pending.value ?? about.value?.name ?? ``);
    const emptyHint = computed(() => {
        if (pending.value !== undefined) {
            // The wait still stands: it only stopped holding the panel empty.
            return t(`terminal.panelWait.notYet`);
        }
        if (answer.value === `refused`) {
            // The one case where it is the asking that failed, not the sandbox that is empty.
            return t(`terminal.panelWait.refused`);
        }
        return about.value === undefined ? t(`terminal.panelWait.openOne`) : t(`terminal.panelWait.noSuchSession`);
    });

    // Takes the request and spends it: standing in module state lets it open a panel not yet mounted, but left standing it
    // would replay on the next mount, hours later. A dropped list is not a failed open, since focus records the wait first.
    const openRequested = async (request: TerminalRequest): Promise<void> => {
        about.value = request;
        clearTerminalRequest();
        await tabs.focus(request.name).catch(() => undefined);
    };

    return { about, waited, named, emptyHint, openRequested };
};
