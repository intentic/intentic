import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionServerApi, ToolDefinition } from "@intentic/extension-api";
import { NOTES_PATH } from "./notes";

/* The backend half, which here does one thing: hand the agent tools (`contributes.tools`). The host owns the MCP
   transport, each call's deadline and cancellation; this only says what the tools are and what each does. With no
   `perCard` in the manifest there is one server for the extension, named by its `name` (`mcp__example__…`), in every
   turn while the extension is enabled, on whichever runtime serves it. */

interface Note {
    readonly at: string;
    readonly text: string;
}

// The host lists `inputSchema` to the model; what arrives is still only what the model sent, so it is read defensively.
const limitOf = (args: Parameters<ToolDefinition["call"]>[0]): number => {
    const limit = Math.trunc(Number(args[`limit`] ?? 10));
    return Number.isFinite(limit) && limit > 0 ? limit : 10;
};

export const activateServer = (api: ExtensionServerApi): void => {
    const path = join(api.workspaceRoot, NOTES_PATH);

    // No file yet is "no notes"; one that cannot be parsed throws, since `add_note` would otherwise write over it.
    const read = async (): Promise<Note[]> => {
        // SAFETY: a rejection from node's fs is always a system error carrying `code`.
        const text = await readFile(path, `utf8`).catch((error: NodeJS.ErrnoException) => {
            if (error.code === `ENOENT`) {
                return undefined;
            }
            throw error;
        });
        if (text === undefined) {
            return [];
        }
        // SAFETY: only this extension writes the file (the CLI and add_note), always as `{ notes: Note[] }`.
        const notes = (JSON.parse(text) as { notes?: Note[] }).notes;
        return Array.isArray(notes) ? notes : [];
    };

    const listNotes: ToolDefinition = {
        name: `list_notes`,
        description: `The owner's newest notes in the Example view, newest first.`,
        inputSchema: { type: `object`, properties: { limit: { type: `integer`, minimum: 1, description: `How many; default 10.` } } },
        call: async (args) => (await read()).toReversed().slice(0, limitOf(args)),
    };

    const addNote: ToolDefinition = {
        name: `add_note`,
        description: `Leave the owner a one-sentence note in the Example view. A breadcrumb, not a report, and never a question.`,
        inputSchema: { type: `object`, properties: { text: { type: `string`, minLength: 1 } }, required: [`text`] },
        call: async (args) => {
            const text = String(args[`text`] ?? ``).trim();
            if (text === ``) {
                // A thrown error reaches the model as a refusal it can read.
                throw new Error(`a note needs some text`);
            }
            const notes = [...(await read()), { at: new Date().toISOString(), text }];
            await mkdir(dirname(path), { recursive: true });
            // Temp-then-rename: the view reading mid-write sees the whole old list or the whole new one.
            const staged = `${path}.${process.pid}.tmp`;
            await writeFile(staged, `${JSON.stringify({ notes }, undefined, 4)}\n`);
            await rename(staged, path);
            return `noted`;
        },
    };

    // Called per request with the card a server was mounted for; an extension-level server has none.
    api.tools.serve(() => [listNotes, addNote]);
};
