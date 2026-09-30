import type { WorkspaceDerived } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import type { OpenFile } from "../viewers/openFile";
import { rememberDerived } from "./derivedCache";

// A file's derived text: the markdown rendering fileq keeps of a document, picture, recording or archive, and the same
// text an agent reads instead of the bytes.
// Two calls, deliberately split: reading never derives, so a file already rendered paints at once, and deriving runs
// only when there is nothing current to show. Both answers are kept (derivedCache.ts), so reopening a file paints before
// the daemon answers.

export type { WorkspaceDerived };

/** The rendering as it stands. `present: false` is the ordinary answer for a file nobody has opened yet. */
export const readDerivedText = async (path: string): Promise<WorkspaceDerived> => rememberDerived(path, await sandboxRpc.workspace.derived({ path }));

/** Renders this one file now and answers with what came out; unchanged content comes back from fileq's cache. */
export const deriveText = async (path: string): Promise<WorkspaceDerived> => rememberDerived(path, await sandboxRpc.workspace.derive({ path }));

// JSON on disk: text by every rule this viewer has, and unreadable by any person. The one text-shaped format whose
// shadow is worth more than its own bytes.
const NOTEBOOK = /\.ipynb$/i;

/** Whether a derived reading of this file is worth offering at all. A folder on this computer is offered it too: the
 * desktop app's sidecar renders the same shadow on request (app/environments/local.ts). */
export const mayHaveDerivedText = (path: string, kind: OpenFile["kind"]): boolean => {
    if (kind === `empty` || kind === `locked`) {
        return false;
    }
    return kind === `code` || kind === `markdown` || kind === `big-text` ? NOTEBOOK.test(path) : true;
};

/** Returns whether derived text is the file's only readable representation. */
export const derivedIsOnlyView = (path: string, kind: OpenFile["kind"]): boolean =>
    (kind === `binary` || kind === `too-large`) && mayHaveDerivedText(path, kind);
