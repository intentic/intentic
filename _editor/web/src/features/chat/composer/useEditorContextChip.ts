import type { EditorContext } from "@intentic/sandbox-contract/schemas/agent";
import { mentionPaths } from "@intentic/sandbox-contract/text/mentions";
import { useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { isPage } from "../../../lib/routes/links";
import { useEditorSelection } from "../../../models/workspace/files/useEditorSelection";
import { useWorkspaceTabs } from "../../../models/workspace/tabs/useWorkspaceTabs";

// The file the user is looking at, offered to the next message as an opt-in chip: the live Monaco selection,
// else the active file tab. Gated on the Workspace being the visible area, since both sources it reads
// (useWorkspaceTabs, useEditorSelection) are singletons that outlive that view.
//
// It says "I am looking at this", not "read this": the agent gets a note naming the file (and the selected text), not
// the file as an attachment. A whole file the draft already @-mentions is therefore said once, by the mention: the
// chip steps aside rather than send the same file twice. A selection is more than the mention says, so it stays.

// A prompt is not a place to paste a whole file.
const SELECTION_CAP = 20_000;

// Whether the draft's own words already name the file in view as an `@` mention.
const mentionedInDraft = (draft: string, file: string): boolean => mentionPaths(draft).includes(file);

export const useEditorContextChip = (
    // The draft as typed, read for the `@` mentions that already carry the file in view.
    draft: () => string = () => ``,
): {
    /** What the chip would attach, or nothing when there is no file in view or the draft already mentions it. */
    readonly target: ComputedRef<{ readonly file: string } | undefined>;
    /** The opt-in, this send carries it. */
    readonly include: Ref<boolean>;
    /** The chip's hover: what pressing it does, and that it names the file rather than attaching it. */
    readonly hint: ComputedRef<{ readonly title: string; readonly note: string }>;
    /** The chip's own words: the file's name, with the selected lines when there are some. */
    readonly label: ComputedRef<string>;
    /** The context this send carries, or nothing. One reader, so an edit and an ordinary message cannot disagree. */
    readonly forSend: () => EditorContext | undefined;
} => {
    const t = useT();
    const route = useRoute();
    const workspaceTabs = useWorkspaceTabs();
    const editorSelection = useEditorSelection();

    const inView = computed<{ file: string; startLine?: number; endLine?: number; selection?: string } | undefined>(() => {
        if (!isPage(route, `workspace`)) {
            return undefined;
        }
        const selection = editorSelection.selection.value;
        if (selection !== undefined) {
            return { file: selection.path, startLine: selection.startLine, endLine: selection.endLine, selection: selection.text };
        }
        const tab = workspaceTabs.activeTab.value;
        return tab?.kind === `file` ? { file: tab.path } : undefined;
    });
    const target = computed(() => {
        const seen = inView.value;
        return seen === undefined || (seen.selection === undefined && mentionedInDraft(draft(), seen.file)) ? undefined : seen;
    });

    const include = ref(false);
    // Attaching is a per-file opt-in; a different file or leaving the Workspace resets it.
    watch(
        () => inView.value?.file,
        () => {
            include.value = false;
        },
    );

    return {
        target,
        include,
        hint: computed(() => ({
            title: include.value ? t(`chat.chatPane.viewingOn`) : t(`chat.chatPane.viewingOff`),
            note: t(`chat.chatPane.viewingNote`, { file: target.value?.file ?? `` }),
        })),
        label: computed(() => {
            const seen = target.value;
            if (seen === undefined) {
                return ``;
            }
            const name = seen.file.split(`/`).pop() ?? seen.file;
            return seen.startLine === undefined ? name : `${name}:${seen.startLine}-${seen.endLine}`;
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
