import type { ApprovalSummary, PostApprovalSummary } from "@intentic/sandbox-contract";
import { type ComputedRef, computed, type Ref, ref } from "vue";
import { type PostEdit, postEdit } from "./postText";

// State behind the pencil, kept out of the page so it's testable without one. Posts only: an edited action would
// approve something never proposed, so a bad one is rejected instead. Saves as typed, with a baseline so reading never
// writes; every exit path (`close`, `open` another, approve) flushes first.

// Long enough that typing is one write, not thirty; short enough Approve can't outrun the save.
const SAVE_AFTER_MS = 700;

export interface PostEditState {
    readonly isEditing: (item: ApprovalSummary) => boolean;
    /** Open a post for editing, flushing whatever was open before it. */
    readonly open: (post: PostApprovalSummary) => Promise<void>;
    /** Write anything pending and close the editor. */
    readonly close: () => Promise<void>;
    /** Write anything pending, leaving the editor open. Call before acting on a post's text. */
    readonly flush: () => Promise<void>;
    readonly content: Ref<string>;
    readonly title: Ref<string>;
    /** Restart the debounce, bound to the fields' input. */
    readonly touch: () => void;
    /** The post's length as it stands, counting unsaved keystrokes. */
    readonly liveLength: (post: PostApprovalSummary) => number;
    readonly anyOpen: ComputedRef<boolean>;
}

export const usePostEdit = (write: (post: PostApprovalSummary, changes: PostEdit) => Promise<void>): PostEditState => {
    const editingId = ref<string | undefined>(undefined);
    const content = ref(``);
    const title = ref(``);

    // Last state the daemon had; advances on every write so a second flush with nothing new stays silent.
    let baseline: PostApprovalSummary | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = async (): Promise<void> => {
        clearTimeout(timer);
        timer = undefined;
        if (baseline === undefined) {
            return;
        }
        const changes = postEdit(baseline, { content: content.value, title: title.value });
        if (changes === undefined) {
            return;
        }
        const target = baseline;
        // Advanced before awaiting: a keystroke mid-write must compare against what's already on its way to disk.
        baseline = { ...target, ...changes };
        await write(target, changes);
    };

    return {
        isEditing: (item) => editingId.value === item.id,
        open: async (post) => {
            await flush();
            editingId.value = post.id;
            baseline = post;
            content.value = post.content;
            title.value = post.title ?? ``;
        },
        close: async () => {
            await flush();
            editingId.value = undefined;
            baseline = undefined;
        },
        flush,
        content,
        title,
        touch: () => {
            clearTimeout(timer);
            timer = setTimeout(() => void flush(), SAVE_AFTER_MS);
        },
        // Reads the live field, not the row, so the footer's count moves with each keystroke, not the last save.
        liveLength: (post) => (editingId.value === post.id ? content.value.length : post.content.length),
        anyOpen: computed(() => editingId.value !== undefined),
    };
};
