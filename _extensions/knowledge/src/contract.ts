import { z } from "zod";

/* THE KNOWLEDGE EXTENSION'S OWN WIRE CONTRACT, shared by its two halves and by nobody else.
 *
 * Both halves import THIS file and are compiled together, so their wire cannot drift, while the core contract
 * carries nothing about a feature the core does not implement (the memory extension's rule, and the shape the
 * rest of the daemon's features are migrating to). Paths are the extension's own, the daemon proxies
 * /x/intentic.knowledge/<path> and the backend host strips the prefix, so both halves speak them relative. */

// The daemon-proxied prefix the UI half calls: its own namespace, so no permissions.sandbox entry is needed. A
// literal rather than something derived from the id, so the permissions conformance scanner (a regex over
// source) can resolve calls that interpolate it.
export const KNOWLEDGE_BASE = "/x/intentic.knowledge";

// A note as the LIST needs it, everything the panel draws a row from, and nothing that would make listing a
// a knowledge base mean shipping every note in it.
export const NoteSummarySchema = z.object({
    // Relative to the knowledge folder, forward-slash, with the extension: "person/ada-lovelace.md". A note's identity.
    path: z.string(),
    title: z.string(),
    type: z.string().optional(),
    tags: z.array(z.string()),
    aliases: z.array(z.string()),
    linkCount: z.number(),
    backlinkCount: z.number(),
    sizeBytes: z.number(),
    // Epoch ms mtime.
    modifiedAt: z.number(),
});
export type NoteSummary = z.infer<typeof NoteSummarySchema>;

// One end of a connection, already resolved, the panel renders a link, so it needs somewhere to send it.
export const NoteLinkSchema = z.object({
    // The header field that named this connection; absent for a link written in the prose.
    relation: z.string().optional(),
    // The other note, or absent when the link points at something nobody has written yet.
    path: z.string().optional(),
    title: z.string(),
});
export type NoteLink = z.infer<typeof NoteLinkSchema>;

export const NoteSchema = z.object({
    summary: NoteSummarySchema,
    // The raw file, exactly as on disk, what an edit round-trips, so a save can never reflow somebody's note.
    content: z.string(),
    // The note without its header, for rendering.
    body: z.string(),
    // Header fields that are plain facts rather than connections, in file order.
    facts: z.array(z.object({ key: z.string(), values: z.array(z.string()) })),
    linksTo: z.array(NoteLinkSchema),
    linkedFrom: z.array(NoteLinkSchema),
});
export type Note = z.infer<typeof NoteSchema>;

export const NoteQuerySchema = z.object({ path: z.string().min(1) });

export const SearchQuerySchema = z.object({
    q: z.string().optional(),
    type: z.string().optional(),
    tag: z.string().optional(),
    linkedTo: z.string().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
});

export const SearchHitSchema = z.object({
    path: z.string(),
    title: z.string(),
    type: z.string().optional(),
    tags: z.array(z.string()),
    modifiedAt: z.number(),
    // Why this note is in the answer, title, alias, tag, type, field, body, so a surprising hit explains itself.
    matched: z.string(),
    snippet: z.string().optional(),
});
export const SearchResultSchema = z.object({ hits: z.array(SearchHitSchema) });
export type SearchHit = z.infer<typeof SearchHitSchema>;

const CountSchema = z.object({ name: z.string(), count: z.number() });
const DriftSchema = z.object({ word: z.string(), uses: z.number(), notes: z.array(z.string()) });

// What the knowledge base amounts to and what is unfinished about it, the overview strip, in one call.
export const OverviewSchema = z.object({
    // Workspace-relative, so the panel can say where the notes actually are.
    folder: z.string(),
    noteCount: z.number(),
    linkCount: z.number(),
    types: z.array(CountSchema),
    tags: z.array(CountSchema),
    vocabulary: z.object({ types: z.array(z.string()), relations: z.array(z.string()), path: z.string().optional() }),
    broken: z.array(z.object({ from: z.string(), target: z.string(), relation: z.string().optional() })),
    orphans: z.array(z.string()),
    untyped: z.array(z.string()),
    typeDrift: z.array(DriftSchema),
    relationDrift: z.array(DriftSchema),
    unreadable: z.array(z.object({ path: z.string(), keys: z.array(z.string()) })),
    ambiguous: z.array(z.object({ name: z.string(), notes: z.array(z.string()) })),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const GraphQuerySchema = z.object({
    focus: z.string().min(1),
    depth: z.coerce.number().int().min(1).max(4).optional(),
});
export const GraphSchema = z.object({
    focus: z.string().optional(),
    nodes: z.array(z.object({ path: z.string(), title: z.string(), type: z.string().optional(), depth: z.number() })),
    edges: z.array(z.object({ from: z.string(), to: z.string(), relation: z.string().optional() })),
    // Neighbours that did not fit the cap, said out loud rather than silently dropped.
    omitted: z.number(),
});
export type Graph = z.infer<typeof GraphSchema>;

// Notes are prose, and prose is small; the cap guards the route rather than real usage.
export const NoteWriteSchema = z.object({ path: z.string().min(1), content: z.string().max(1_048_576) });
export const OkSchema = z.object({ ok: z.literal(true) });

// What starting a knowledge base off wrote, so the panel can open the note rather than announce a success. Empty means
// the knowledge base already had a vocabulary and nothing was touched, never an error, since two browsers pressing the
// same button is an ordinary race and the second one has nothing to apologise for.
export const SeedResultSchema = z.object({ written: z.array(z.string()) });
