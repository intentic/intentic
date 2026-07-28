import { computed, ref, watch } from "vue";
import { useSandbox } from "../sandbox/useSandbox";

/* WHAT IS IN THE COMMIT BOX — the user's own draft, or the suggestion standing in for it while they have none.
 *
 * TWO SOURCES, ONE VALUE, and the value is what everything reads: the input's v-model, the Commit button's
 * readiness, the message the commit is made with, the text the AI autofill stashes for Undo. A panel that
 * consulted a draft here and a fallback there would eventually commit one while displaying the other.
 *
 * The draft always wins, and the fallback returns the moment there is no draft again — the suggestion is not
 * seeded INTO the draft, which is the version of this that goes subtly wrong: seeding writes a message the user
 * never typed into the persisted draft, so it outlives the work it described, keeps its own text after the
 * sessions it named have been committed, and cannot refresh when a new agent lands better material.
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

// What the user has typed (or accepted from the AI autofill) for this sandbox. Empty = nothing of their own,
// which is also what a successful commit leaves behind — so the suggestion is free to take the box back.
const draft = ref(read(activeSandboxId.value));

/* The suggested subject, derived from the session titles of the agents whose work this commit will record — see
 * commitSuggestion.ts for what it says and why. Written by the Changes panel rather than derived here: it comes
 * out of the review set, which is a vue-query read, and a query can only be created from a component's setup —
 * this module is imported long before one exists. The panel keeps it current for as long as the commit box is on
 * screen, which is exactly as long as anything reads it. */
export const commitSuggestion = ref<string | undefined>(undefined);

export const commitMessage = computed<string>({
    get: () => (draft.value === `` ? (commitSuggestion.value ?? ``) : draft.value),
    // Typing over the suggestion (or clearing the box) is a write to the draft, and only the draft: the
    // suggestion describes the tree, not the user's intent, so nothing here may edit it.
    set: (message) => {
        draft.value = message;
    },
});

// Switching sandboxes swaps the draft for that sandbox's own — which is also what re-persists it below, under
// the id it was just loaded from.
watch(activeSandboxId, (sandboxId) => {
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
