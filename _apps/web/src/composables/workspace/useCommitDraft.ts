import type { CommitMessageDraft } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";

/* THE COMMIT BOX'S AI AUTOFILL — one click, one drafted subject line, on the sandbox's quick model.
 *
 * Two things here are UI decisions rather than plumbing:
 *
 * UNDO IS EXPLICIT. Writing the draft through v-model replaces the input's value programmatically, and the
 * browser's own undo stack does not record that — so Ctrl+Z in a box the user had typed into gives them back
 * nothing. Stashing the previous text and offering "Undo" is what makes overwriting safe, and it is why the
 * button needs no confirm dialog in front of it: the destructive case is one click away from being reversed,
 * which is a better trade than a modal on every draft.
 *
 * A SECOND CLICK CANCELS. The draft is a model call on the cheap rung, so it is fast but not instant; the
 * honest reading of clicking a busy button is "stop", not "queue another one". Aborting also releases the
 * daemon's turn, which matters because the alternative is paying for an answer nobody will read. */

export interface CommitDraft {
    readonly message: string;
    // Which model wrote it, for the "Drafted with …" readout. Named rather than "AI" so a user can tell that
    // their commit messages come from Haiku while their chat runs on Opus.
    readonly model: string;
}

export function useCommitDraft() {
    const busy = ref(false);
    const error = ref<string | undefined>(undefined);
    // The message as it stood before the last draft replaced it. Undefined = nothing to undo (no draft yet, or
    // it has already been undone).
    const previous = ref<string | undefined>(undefined);
    const drafted = ref<CommitDraft | undefined>(undefined);
    let inFlight: AbortController | undefined;

    // Everything the readout says about the last draft, dropped the moment the user edits the message: an
    // "Undo" offering to restore text that is no longer what the draft replaced would restore the wrong thing.
    const forget = (): void => {
        previous.value = undefined;
        drafted.value = undefined;
        error.value = undefined;
    };

    const cancel = (): void => {
        inFlight?.abort();
        inFlight = undefined;
    };

    // Draft a message for `repos`, mirroring the panel's own commit target — `all` when the button says "Commit
    // all" (the worktree), absent for a staged commit (the index). Returns the drafted message, or undefined if
    // it failed or was cancelled; the caller writes it into the input.
    const draft = async (repos: readonly string[], all: boolean, current: string): Promise<string | undefined> => {
        if (busy.value) {
            cancel();
            return undefined;
        }
        const controller = new AbortController();
        inFlight = controller;
        busy.value = true;
        error.value = undefined;
        try {
            const result = await sandboxJson<CommitMessageDraft>(`/git/commit-message`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ repos, ...(all ? { all: true } : {}) }),
                signal: controller.signal,
            });
            previous.value = current;
            drafted.value = { message: result.message, model: result.model };
            return result.message;
        } catch (caught) {
            // A cancel is the user's own doing, so it says nothing — the button simply goes idle again.
            if (!controller.signal.aborted) {
                error.value = errorMessage(caught, `Couldn't draft a commit message.`);
            }
            return undefined;
        } finally {
            busy.value = false;
            if (inFlight === controller) {
                inFlight = undefined;
            }
        }
    };

    // The stashed text, consumed — undo is offered once, because after it runs there is nothing left to restore.
    const undo = (): string | undefined => {
        const restored = previous.value;
        forget();
        return restored;
    };

    return { draft, undo, forget, cancel, busy, error, drafted, previous };
}
