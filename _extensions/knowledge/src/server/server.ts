import { relative, sep } from "node:path";
import type { ExtensionServerApi, ExtensionServerContext } from "@intentic/extension-api";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import type { KnowledgeIndex } from "../notes/index-notes.js";
import type { ParsedNote } from "../notes/note.js";
import { neighbourhood, search } from "../notes/query.js";
import { configuredFolder, deleteNote, indexNotes, knowledgeRoot, writeNote } from "../notes/read-notes.js";
import { starterNotes } from "../notes/starter.js";
import { graphOf, hitsOf, noteOf, overviewFor, summaryOf } from "../notes/wire.js";
import { knowledgeContract } from "./contract.js";

// Backend half of ext-knowledge: notes read and resolved on the daemon's side. The index and the configured folder are
// rebuilt per request, not cached, since notes are edited out of band and a scan of a few hundred files is cheap; add a
// watcher, not a cache, if that stops being true.

// Resolves a note by path or any other name (a deep-link is a path, prose links may be a title); absent throws 404, not
// an empty note.
const noteAt = (index: KnowledgeIndex, path: string): ParsedNote => {
    const note = index.byPath.get(path) ?? index.resolve(path);
    if (note === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "no such note" });
    }
    return note;
};

export const activateServer = (api: ExtensionServerApi, _context: ExtensionServerContext): void => {
    const rootOf = async (): Promise<string> => knowledgeRoot(api.workspaceRoot, await configuredFolder(api.workspaceRoot));
    const openKnowledge = async (): Promise<{ root: string; index: KnowledgeIndex }> => {
        const root = await rootOf();
        return { root, index: await indexNotes(root) };
    };

    const i = implement(knowledgeContract);
    const router = i.router({
        overview: i.overview.handler(async () => {
            const { root, index } = await openKnowledge();
            return overviewFor(index, relative(api.workspaceRoot, root).split(sep).join("/"));
        }),
        notes: i.notes.handler(async () => {
            const { index } = await openKnowledge();
            return { notes: index.notes.map((note) => summaryOf(note, index)) };
        }),
        search: i.search.handler(async ({ input }) => {
            const { index } = await openKnowledge();
            const hits = search(index, { query: input.q, type: input.type, tag: input.tag, linkedTo: input.linkedTo, limit: input.limit });
            return { hits: hitsOf(hits) };
        }),
        note: i.note.handler(async ({ input }) => {
            const { index } = await openKnowledge();
            return noteOf(noteAt(index, input.path), index);
        }),
        graph: i.graph.handler(async ({ input }) => {
            const { index } = await openKnowledge();
            return graphOf(neighbourhood(index, input.focus, input.depth ?? 2));
        }),
        write: i.write.handler(async ({ input }) => {
            if (!(await writeNote(await rootOf(), input.path, input.content))) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid note path (must be a .md file inside the knowledge base)" });
            }
            return { ok: true } as const;
        }),
        delete: i.delete.handler(async ({ input }) => {
            if (!(await deleteNote(await rootOf(), input.path))) {
                throw new ORPCError("NOT_FOUND", { message: "no such note" });
            }
            return { ok: true } as const;
        }),
        seed: i.seed.handler(async () => {
            const { root, index } = await openKnowledge();
            // Never overwrites; a vocabulary or a note already at a starter's path counts as already started.
            const written: string[] = [];
            for (const note of starterNotes()) {
                if (index.vocabulary.path !== undefined || index.byPath.has(note.path)) {
                    continue;
                }
                if (await writeNote(root, note.path, note.content)) {
                    written.push(note.path);
                }
            }
            return { written };
        }),
    });
    const handler = new OpenAPIHandler(router);
    api.routes.mount(async (request) => {
        const { matched, response } = await handler.handle(request, { prefix: "/" });
        return matched ? response : undefined;
    });
};
