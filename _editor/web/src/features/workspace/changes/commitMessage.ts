import { computed, ref, watch, type Ref } from "vue";
import { useSandbox } from "../../sandbox/client/useSandbox";

// The commit box's draft: one value, empty until a From-chip click fills it as a subject line; typing is
// always untouchable, a fill may only replace its own output. Lives as a per-sandbox, localStorage-backed
// module singleton so it outlives the Changes panel being unmounted.

const storageKey = (sandboxId: string): string => `intentic.commitMessage.${sandboxId}`;

// The box's text and, when it still matches what a From-chip fill wrote, that same text as the fill's claim.
// Stored together in one record so they can't disagree across a reload.
interface StoredDraft {
    readonly message: string;
    readonly filled?: string;
}

const read = (sandboxId: string | undefined): StoredDraft => {
    if (sandboxId === undefined) {
        return { message: `` };
    }
    try {
        const held = localStorage.getItem(storageKey(sandboxId));
        return held === null ? { message: `` } : (JSON.parse(held) as StoredDraft);
    } catch {
        // Storage unavailable or unreadable; degrade to an in-memory draft for this page's lifetime.
        return { message: `` };
    }
};

const { activeSandboxId } = useSandbox();

const stored = read(activeSandboxId.value);

// Current draft text; empty is also what a successful commit leaves behind.
const draft = ref(stored.message);

// Exact text of the last fill, while still verbatim in the box; undefined means the box is the user's.
const filled = ref<string | undefined>(stored.filled);

export const commitMessage = computed<string>({
    get: () => draft.value,
    set: (message) => {
        // Any write other than the fill's own output ends the claim; set before draft so watchers see final state.
        if (message !== filled.value) {
            filled.value = undefined;
        }
        draft.value = message;
    },
});

// True when the box holds only whitespace, which reads as empty (the Commit button already calls it so).
// Checked via trim, not by normalizing the draft itself, so a space just typed before the first word is not eaten.
const isBlank = (message: string): boolean => message.trim() === ``;

// True when the box holds non-blank text that isn't the fill's own line — the one check that decides whether
// a From chip may write into it. Defined once so the panel's notice and the guard below can't disagree.
export const boxIsYours = computed(() => !isBlank(draft.value) && draft.value !== filled.value);

// Fills the box from a From-chip click; declines when the box holds anything but a blank or the fill's own last line.
export const fillCommitMessage = (message: string): void => {
    if (boxIsYours.value) {
        return;
    }
    filled.value = message;
    draft.value = message;
};

// Withdraws a fill's line when the box still holds exactly it (or only whitespace); a message the user has since
// edited stays untouched.
export const clearFilledMessage = (): void => {
    if (isBlank(draft.value) || (filled.value !== undefined && draft.value === filled.value)) {
        draft.value = ``;
    }
    filled.value = undefined;
};

// Keeps the box in step with a lit chip's message as it is drafted, so a sentence that arrives after the click
// still lands. Routes through fillCommitMessage/clearFilledMessage, so typed text is still never overwritten.
export const followFilledMessage = (source: Ref<string | undefined>): void => {
    watch(source, (message) => (message === undefined ? clearFilledMessage() : fillCommitMessage(message)));
};

// Session the commit is named after, kept at module scope so the ask outlives the Changes panel being unmounted.
export const namedAfter = ref<string | undefined>(undefined);

// Sets who the commit is named after; withdrawing (undefined) also clears whatever chip last filed.
export const nameCommitAfter = (id: string | undefined): void => {
    namedAfter.value = id;
    if (id === undefined) {
        clearFilledMessage();
    }
};

// Switching sandboxes reloads that sandbox's own draft and claim together, so neither leaks across sandboxes.
watch(activeSandboxId, (sandboxId) => {
    const held = read(sandboxId);
    filled.value = held.filled;
    draft.value = held.message;
});

// Watches both draft and filled — a claim can end without the text changing, and that alone must repersist.
watch([draft, filled], ([message, claim]) => {
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        return;
    }
    try {
        // A blank box persists as no record at all, so nothing carries across a reload.
        if (isBlank(message)) {
            localStorage.removeItem(storageKey(sandboxId));
            return;
        }
        const record: StoredDraft = { message, ...(claim === undefined ? {} : { filled: claim }) };
        localStorage.setItem(storageKey(sandboxId), JSON.stringify(record));
    } catch {
        // Storage unavailable (private mode); the in-memory draft still holds for this page.
    }
});
