import { computed, ref, watch } from "vue";
import { useSandbox } from "../sandbox/useSandbox";

/* WHAT IS IN THE COMMIT BOX — one value, the user's draft, and nothing standing in for it.
 *
 * IT STARTS EMPTY, and stays empty until the user asks for something. The version this replaces auto-filled the
 * box with a subject derived from EVERY session in the "From" legend, on the reasoning that the titles were
 * already on screen and retyping them was waste. What it actually produced was a message nobody chose: a tree
 * carrying four sessions' work got all four titles joined into one line, the line changed under the user
 * whenever another agent landed, and a commit's subject is the last thing that should arrive by default —
 * a message you did not write is one you do not read before pressing Commit.
 *
 * So naming the commit is now a GESTURE: clicking a session in the From legend files that session's work into
 * the box as a subject line, which is the same click that narrows the list to its files. One session, one
 * subject, chosen — and the two halves of "commit this agent's work" are one action instead of two.
 *
 * WHAT THE USER TYPED IS UNTOUCHABLE, which is why a fill records the exact text it wrote. A later fill may
 * replace its own output, and clicking off the legend takes its own output back; neither may touch a keystroke.
 * That is also why there is no Undo here: nothing in this box ever overwrites something the user wrote.
 *
 * THE COMMIT BOX'S DRAFT, OUTLIVING ITS INPUT. The Changes panel is mounted behind a v-if — the sidebar's
 * Files|Changes|History switch and the mobile segment both destroy it — so a message held in the component died
 * every time the user went to look at the very files they were about to describe. Half-written text nobody asked
 * to discard is the one thing in that panel the user typed by hand (runCommit already keeps it on failure for
 * exactly that reason), so it lives here as a module-level singleton instead.
 *
 * Per sandbox, and persisted: a draft belongs to the working tree it describes, mixing two sandboxes' messages
 * into one box would put the wrong subject over the wrong diff, and a reload is no more of a decision to discard
 * than a tab switch is. localStorage rather than the daemon — this is a client-side typing convenience, and it
 * has to work before the tunnel is up. */

const storageKey = (sandboxId: string): string => `intentic.commitMessage.${sandboxId}`;

const read = (sandboxId: string | undefined): string => {
    if (sandboxId === undefined) {
        return ``;
    }
    try {
        return localStorage.getItem(storageKey(sandboxId)) ?? ``;
    } catch {
        // Storage may be unavailable (private mode): the draft degrades to this page's lifetime, which is still
        // the useful half of the feature.
        return ``;
    }
};

const { activeSandboxId } = useSandbox();

// What the user has typed, or filed in from a From chip, for this sandbox. Empty = nothing at all, which is
// also what a successful commit leaves behind.
const draft = ref(read(activeSandboxId.value));

/* The exact text the last legend fill wrote, while the box still holds it verbatim. This is the whole of the
 * fill's claim on the box: it may replace or retract its OWN line and nothing else, so a user who has typed
 * (or edited a filled line by one character) can click through the legend's filters without their message
 * moving. Undefined = the box is the user's, whatever is in it.
 *
 * Deliberately NOT persisted alongside the draft: a filled line that survives a reload comes back as the
 * user's own, untouchable. That is the safe direction — a message restored from storage is one they left there
 * on purpose, and a legend click has no business retracting it a week later. */
const filled = ref<string | undefined>(undefined);

export const commitMessage = computed<string>({
    get: () => draft.value,
    set: (message) => {
        // Any write that isn't the fill's own output ends the fill's claim — a keystroke, the clear a successful
        // commit does. Set before the draft so a watcher on the message sees the final state.
        if (message !== filled.value) {
            filled.value = undefined;
        }
        draft.value = message;
    },
});

// The message for a session's work, filed by the From legend's click. Declines while the box holds anything the
// fill did not put there — an empty box, or the fill's own last line, is all it may write over.
export const fillCommitMessage = (message: string): void => {
    if (draft.value !== `` && draft.value !== filled.value) {
        return;
    }
    filled.value = message;
    draft.value = message;
};

// The legend no longer points at the session whose title is in the box (the chip was toggled off, the filter
// moved, or that agent's work left the tree), so the line it filed in goes with it. A message the user has
// since made their own stays — `filled` no longer matches it.
export const clearFilledMessage = (): void => {
    if (filled.value !== undefined && draft.value === filled.value) {
        draft.value = ``;
    }
    filled.value = undefined;
};

// Switching sandboxes swaps the draft for that sandbox's own — which is also what re-persists it below, under
// the id it was just loaded from. The fill's claim does not travel: it was made against another tree's legend.
watch(activeSandboxId, (sandboxId) => {
    filled.value = undefined;
    draft.value = read(sandboxId);
});

// Every write goes through here, including the clear a successful commit does, so no caller needs a setter.
watch(draft, (message) => {
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        return;
    }
    try {
        if (message === ``) {
            localStorage.removeItem(storageKey(sandboxId));
            return;
        }
        localStorage.setItem(storageKey(sandboxId), message);
    } catch {
        // Storage may be unavailable (private mode); the in-memory draft still holds for this page.
    }
});
