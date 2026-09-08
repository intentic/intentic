import { z } from "zod";

// The knowledge extension's own wire contract, shared only by its two halves, compiled together so their wire can't
// drift. Paths are relative: the daemon proxies /x/intentic.knowledge/<path> and strips the prefix before both halves
// see it.

// Own namespace the daemon proxies; a literal so the permissions scanner can resolve interpolated calls.
export const KNOWLEDGE_BASE = "/x/intentic.knowledge";

// A note as the list needs it: everything a row draws from, not the whole of a knowledge base's note.
export const NoteSummarySchema = z.object({
    // Relative to the knowledge folder, forward-slash, with extension; a note's identity.
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

// One resolved end of a connection; what the panel renders as a link target.
export const NoteLinkSchema = z.object({
    // The header field that named this connection; absent for a link written in prose.
    relation: z.string().optional(),
    // The other note; absent when the link points at something unwritten.
    path: z.string().optional(),
    title: z.string(),
});
export type NoteLink = z.infer<typeof NoteLinkSchema>;

export const NoteSchema = z.object({
    summary: NoteSummarySchema,
    // Raw file exactly as on disk; a save round-trips it, never reflowing the note.
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
    // Why this note matched: title, alias, tag, type, field, or body, so a surprising hit explains itself.
    matched: z.string(),
    snippet: z.string().optional(),
});
export const SearchResultSchema = z.object({ hits: z.array(SearchHitSchema) });
export type SearchHit = z.infer<typeof SearchHitSchema>;

const CountSchema = z.object({ name: z.string(), count: z.number() });
const DriftSchema = z.object({ word: z.string(), uses: z.number(), notes: z.array(z.string()) });

// What the knowledge base amounts to, and what's unfinished about it: the overview strip, in one call.
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

// What seeding wrote, so the panel can open the note rather than announce success. Empty means a vocabulary already
// existed, not an error; a concurrent press is an ordinary race.
export const SeedResultSchema = z.object({ written: z.array(z.string()) });
