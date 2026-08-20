import { host } from "./host";

/* The one file this extension reads, and the shape the `intentic-example` CLI writes into it. The path is
 * declared twice on purpose, here, and in the manifest's `contributes.files`, because those two declarations
 * do different jobs: this one is what gets fetched, that one is what the daemon's file watcher pushes on.
 *
 * The daemon's `{ path, content }` body is narrowed by hand below rather than with the wire schema from
 * `@intentic/sandbox-contract`, for one contingent reason: that package's published tarball declares a
 * dependency on `@intentic/registry@0.0.0`, which is not on npm, so `npm i @intentic/sandbox-contract` fails
 * today (fixed by adding _sandbox/registry to the release set, this comment goes away with the next release).
 * Keeping the example installable from npm alone was worth two lines of type guard. */
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

/* Newest first. A missing file is the ordinary FIRST state, nobody has written a note yet, so it answers an
 * empty list rather than throwing, and the view renders its empty state instead of an error the user can do
 * nothing about. Unparseable content is treated the same way: the CLI owns this file, and a half-written one is
 * a transient the next read fixes. */
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
