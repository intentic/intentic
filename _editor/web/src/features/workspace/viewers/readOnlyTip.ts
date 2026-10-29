import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { accessWords } from "../../../client/sandbox/access/accessWords";

// Why an open file's editor holds no caret, for the Read-only chip's tooltip. Four causes, the first outranking the
// rest: the member may not change this file (their tier or edit fence), it is an archive's member, a document window
// opened another file, or the view is an agent's copy or a branch, which the daemon cannot write into.

export interface ReadOnlyCause {
    readonly memberWrites: boolean;
    readonly inArchive: boolean;
    // A document window's own file, when this is another one.
    readonly otherThan: string | undefined;
    // The agent whose copy this is, in the reader's word for agents and the copy's own title; no word for a branch,
    // which the title names.
    readonly agentWord: string | undefined;
    readonly scopeTitle: string;
}

export const readOnlyTip = (cause: ReadOnlyCause): Tip => {
    if (!cause.memberWrites) {
        return { title: accessWords({ kind: `tier`, floor: `writer` }).short };
    }
    if (cause.inArchive) {
        return { title: t(`workspace.fileViewer.insideArchive`), note: t(`workspace.fileViewer.extractToEdit`) };
    }
    if (cause.otherThan !== undefined) {
        return { title: t(`workspace.fileViewer.soleDocumentOnly`, { name: basename(cause.otherThan) }) };
    }
    if (cause.agentWord === undefined) {
        return { title: t(`workspace.words.branchView`), rows: [{ label: t(`agents.sessionIdentity.branch`), value: cause.scopeTitle }], note: t(`workspace.words.branchReadOnly`) };
    }
    return { title: t(`workspace.words.privateCopy`), rows: [{ label: cause.agentWord, value: cause.scopeTitle }], note: t(`workspace.words.cantEditHere`) };
};

// The file came from the shared tree because the agent's own copy has none.
export const sharedCopyTip = (agentWord: string, scopeTitle: string): Tip => ({
    title: t(`workspace.fileViewer.sharedVersion`),
    rows: [{ label: agentWord, value: scopeTitle }],
    note: t(`workspace.fileViewer.notInItsCopy`),
});
