import { ref, watch } from "vue";
import { useSandbox } from "../sandbox/useSandbox";

/* THE COMMIT BOX'S DRAFT, OUTLIVING ITS INPUT. The Changes panel is mounted behind a v-if — the sidebar's
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

export const commitMessage = ref(read(activeSandboxId.value));

// Switching sandboxes swaps the draft for that sandbox's own — which is also what re-persists it below, under
// the id it was just loaded from.
watch(activeSandboxId, (sandboxId) => {
    commitMessage.value = read(sandboxId);
});

// Every write goes through here, including the clear a successful commit does, so no caller needs a setter.
watch(commitMessage, (message) => {
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
