import type { WorkspaceDerived } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import type { OpenFile } from "../viewers/openFile";

// A file's derived text: the markdown shadow the sandbox keeps of a document, picture, recording or archive, and the
// same rendering an agent reads instead of the bytes.
// Two calls, deliberately split: reading never derives, so opening a file costs nothing, and deriving is something a
// reader asks for.

export type { WorkspaceDerived };

/** The shadow as it stands. `present: false` is the ordinary answer while background derivation is switched off. */
export const readDerivedText = (path: string): Promise<WorkspaceDerived> => sandboxRpc.workspace.derived({ path });

/** Renders this one file now, however the `sidecars` setting stands, and answers with what came out. */
export const deriveText = (path: string): Promise<WorkspaceDerived> => sandboxRpc.workspace.derive({ path });

// JSON on disk: text by every rule this viewer has, and unreadable by any person. The one text-shaped format whose
// shadow is worth more than its own bytes.
const NOTEBOOK = /\.ipynb$/i;

/** Whether a derived reading of this file is worth offering at all. */
export const mayHaveDerivedText = (path: string, kind: OpenFile["kind"]): boolean => {
    if (kind === `empty` || kind === `locked`) {
        return false;
    }
    return kind === `code` || kind === `markdown` || kind === `big-text` ? NOTEBOOK.test(path) : true;
};

/** Returns whether derived text is the file's only readable representation. */
export const derivedIsOnlyView = (path: string, kind: OpenFile["kind"]): boolean =>
    (kind === `binary` || kind === `too-large`) && mayHaveDerivedText(path, kind);
