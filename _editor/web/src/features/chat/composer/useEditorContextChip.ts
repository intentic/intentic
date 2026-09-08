import type { EditorContext } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useEditorSelection } from "../../workspace/files/useEditorSelection";
import { useWorkspaceTabs } from "../../workspace/tabs/useWorkspaceTabs";

// The file the user is looking at, offered to the next message as an opt-in chip: the live Monaco selection,
// else the active file tab. Gated on the Workspace being the visible area, since both sources it reads
// (useWorkspaceTabs, useEditorSelection) are singletons that outlive that view.

// A prompt is not a place to paste a whole file.
const SELECTION_CAP = 20_000;

export const useEditorContextChip = (): {
    /** What the chip would attach, or nothing when there is no file in view. */
    readonly target: ComputedRef<{ readonly file: string } | undefined>;
    /** The opt-in, this send carries it. */
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
    // Attaching is a per-file opt-in; a different file or leaving the Workspace resets it.
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
