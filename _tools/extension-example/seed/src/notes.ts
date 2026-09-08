import { host } from "./host";

// Also declared in the manifest's `contributes.files`, whose copy makes a write here push instead of poll.
export const NOTES_PATH = `.intentic/example-notes.json`;

export interface Note {
    readonly at: string;
    readonly text: string;
}

const isNote = (value: unknown): value is Note =>
    typeof value === `object` && value !== null && typeof (value as Note).at === `string` && typeof (value as Note).text === `string`;

const contentOf = (body: unknown): string | undefined => {
    const content = (body as { content?: unknown } | null)?.content;
    return typeof content === `string` ? content : undefined;
};

// Newest first. A missing or unparsable file returns an empty list rather than throwing: the CLI owns this file, so an
// absent or half-written one is an ordinary, transient state.
export const readNotes = async (): Promise<readonly Note[]> => {
    let content: string | undefined;
    try {
        content = contentOf(await host().sandbox.json(`/workspace/file?path=${encodeURIComponent(NOTES_PATH)}`));
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
