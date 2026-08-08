import { z } from "zod";

/* THE MEMORY EXTENSION'S OWN WIRE CONTRACT — shared by its two halves and by nobody else.
 *
 * This used to live in @intentic/sandbox-contract as core routes; it moved here when the backend did. The
 * keystone property survives at the right grain: the UI half and the server half import THIS file and are
 * compiled together, so their wire cannot drift — while the core contract no longer carries a feature the
 * core no longer implements. Paths are the extension's own (the daemon proxies /x/intentic.memory/<path> and
 * the backend host strips the prefix), so both halves speak them relative. */

// The daemon-proxied prefix the UI half calls — its own namespace, so no permissions.sandbox entry is needed.
// A literal rather than derived from the id so the permissions conformance scanner (a regex over source) can
// resolve calls that interpolate it.
export const MEMORY_BASE = "/x/intentic.memory";

export const MemoryFileEntrySchema = z.object({
    // The project slug the memory belongs to (one dir per agent cwd, e.g. "-history-gits-root").
    project: z.string(),
    // Path relative to that project's memory dir, e.g. "MEMORY.md" or "team-conventions.md".
    name: z.string(),
    sizeBytes: z.number(),
    // Epoch ms mtime.
    modifiedAt: z.number(),
});
export type MemoryFileEntry = z.infer<typeof MemoryFileEntrySchema>;
export const MemoryListSchema = z.object({ files: z.array(MemoryFileEntrySchema) });

// `project` + `name` ride the query (names may contain slashes, which don't fit a path segment).
export const MemoryFileQuerySchema = z.object({
    project: z.string().min(1),
    name: z.string().min(1),
});
export const MemoryFileSchema = z.object({
    project: z.string(),
    name: z.string(),
    content: z.string(),
    sizeBytes: z.number(),
    modifiedAt: z.number(),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;
// Memory notes are small by construction (one fact per file); the cap guards the route, not real usage.
export const MemoryWriteSchema = z.object({
    project: z.string().min(1),
    name: z.string().min(1),
    content: z.string().max(1_048_576),
});
export const OkSchema = z.object({ ok: z.literal(true) });
