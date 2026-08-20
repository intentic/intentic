import type { EditorContext } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useEditorSelection } from "../workspace/useEditorSelection";
import { useWorkspaceTabs } from "../workspace/useWorkspaceTabs";

/* THE FILE YOU ARE LOOKING AT, offered to the next message as a chip over the composer: the live Monaco
 * selection, else the active file tab. OFF by default — the user clicks the chip to attach it (the inverse of
 * VSCode Claude Code's always-on injection).
 *
 * Gated on the Workspace being the area on screen. The chip's whole claim is "the file you are LOOKING AT", and
 * it reads two singletons (useWorkspaceTabs, useEditorSelection) that outlive the Workspace view — while the
 * chat pane is docked in the persistent shell beside whatever area is open. Off /workspace there is nothing the
 * user is looking at, so "this file" has no referent and the chip is a stale nag for a file they left behind
 * (worse in /agents, where the turn runs in the agent's worktree, not the /work tree the tab came from).
 * Route-gated rather than dismissible: it is self-correcting — walk back into the Workspace and the chip
 * returns, with nothing to undo. */

// A prompt is not a place to paste a whole file.
const SELECTION_CAP = 20_000;

export const useEditorContextChip = (): {
    /** What the chip would attach, or nothing when there is no file in view. */
    readonly target: ComputedRef<{ readonly file: string } | undefined>;
    /** The opt-in — this send carries it. */
    readonly include: Ref<boolean>;
    /** The chip's own words: the file's name, with the selected lines when there are some. */
    readonly label: ComputedRef<string>;
    /** The context this send carries, or nothing. One reader, so an edit and an ordinary message cannot disagree. */
    readonly forSend: () => EditorContext | undefined;
} => {
    const route = useRoute();
    const workspaceTabs = useWorkspaceTabs();
    const editorSelection = useEditorSelection();

    const target = computed<{ file: string; startLine?: number; endLine?: number; selection?: string } | undefined>(() => {
        if (route.name !== `workspace`) {
            return undefined;
        }
        const selection = editorSelection.selection.value;
        if (selection !== undefined) {
            return { file: selection.path, startLine: selection.startLine, endLine: selection.endLine, selection: selection.text };
        }
        const tab = workspaceTabs.activeTab.value;
        return tab?.kind === `file` ? { file: tab.path } : undefined;
    });

    const include = ref(false);
    // Attaching is an explicit per-file choice — a different file in the editor resets the opt-in, as does
    // leaving the Workspace (the target goes undefined with the chip, so an opt-in can't outlive the chip that
    // explained it and ride along invisibly into a later message).
    watch(
        () => target.value?.file,
        () => {
            include.value = false;
        },
    );

    return {
        target,
        include,
        label: computed(() => {
            const inView = target.value;
            if (inView === undefined) {
                return ``;
            }
            const name = inView.file.split(`/`).pop() ?? inView.file;
            return inView.startLine === undefined ? name : `${name}:${inView.startLine}-${inView.endLine}`;
        }),
        forSend: (): EditorContext | undefined => {
            const carried = target.value;
            if (!include.value || carried === undefined) {
                return undefined;
            }
            return {
                file: carried.file,
                ...(carried.selection !== undefined
                    ? { startLine: carried.startLine, endLine: carried.endLine, selection: carried.selection.slice(0, SELECTION_CAP) }
                    : {}),
            };
        },
    };
};
