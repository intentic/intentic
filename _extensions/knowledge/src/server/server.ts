import { relative, sep } from "node:path";
import type { ExtensionServerApi, ExtensionServerContext } from "@intentic/extension-api";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import type { KnowledgeIndex } from "../notes/index-notes.js";
import type { ParsedNote } from "../notes/note.js";
import { neighbourhood, search } from "../notes/query.js";
import { configuredFolder, deleteNote, indexNotes, knowledgeRoot, writeNote } from "../notes/read-notes.js";
import { starterNotes } from "../notes/starter.js";
// The engine's answers, in the shapes the contract declares, shared with the demo fixture, which serves this
// same namespace with no sandbox behind it. See notes/wire.ts for why that sharing is the point.
import { graphOf, hitsOf, noteOf, overviewFor, summaryOf } from "../notes/wire.js";
import { knowledgeContract } from "./contract.js";

/* ext-knowledge's backend half, the knowledge base, read and resolved on the daemon's side of the wire.
 *
 * THE INDEX IS BUILT PER REQUEST, and that is a decision rather than an omission. Everything the panel shows is
 * derived from the notes: the graph, the backlinks, the counts, the drift. Caching any of it means a second
 * source of truth that can disagree with the folder, and the folder is edited out of band constantly, by the
 * agent's own file tools, by the `kb` CLI, by an editor, by whatever syncs the owner's knowledge base in. A few hundred
 * short markdown files parse in a few milliseconds; a stale panel costs the feature its credibility. If a knowledge base
 * ever grows past what a scan can carry, the thing to add is a watcher, not a cache with a guess for a lifetime.
 *
 * WHICH FOLDER is re-read per request too, for the same reason: the owner can change it in Settings, and the
 * next call should simply be about the other knowledge base. */

// A note by path, or by anything else that names it, a panel deep-link is a path, but a hand-built URL and a
// link followed out of prose may be a title. Absent means 404, not an empty note.
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
            // Nothing is ever overwritten. A knowledge base that already has a vocabulary, or a note where the starter
            // one would go, has already been started, and the honest answer is that this wrote nothing.
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
