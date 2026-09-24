import { host } from "./host";

// Also declared in the manifest's `contributes.files`, whose copy makes a write here push instead of poll.
export const NOTES_PATH = `.intentic/example-notes.json`;

export interface Note {
    readonly at: string;
    readonly text: string;
}

const isNote = (value: unknown): value is Note =>
    typeof value === `object` && value !== null && typeof (value as Note).at === `string` && typeof (value as Note).text === `string`;

// Newest first. A missing or unparsable file returns an empty list rather than throwing: the CLI owns this file, and
// refuses to write over one it cannot parse, so this view never has to.
export const readNotes = async (): Promise<readonly Note[]> => {
    let content: string | undefined;
    try {
        const file = await host().sandbox.rpc.workspace.file({ path: NOTES_PATH });
        content = file.present ? file.content : undefined;
    } catch {
        return [];
    }
    if (content === undefined) {
        return [];
    }
    try {
        const notes = (JSON.parse(content) as { notes?: unknown }).notes;
        return Array.isArray(notes) ? notes.filter(isNote).toReversed() : [];
    } catch {
        return [];
    }
};
