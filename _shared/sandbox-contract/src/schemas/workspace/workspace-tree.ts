// workspace tree + files
import { z } from "zod";
import { ConversationIdSchema } from "../agent.js";
// Which copy of the workspace a read means: the shared /work tree, or (if `agent` is set) that conversation's own
// checkout, resolved in one place so the escape guard, denylist and ignore rules apply the same either way.
export const WorkspaceScopeSchema = z.object({
    agent: ConversationIdSchema.optional().describe(
        "Read a conversation's own private copy of the workspace rather than the shared tree. Leave it out for the shared tree. A conversation that is not working privately resolves back to the shared tree rather than failing, so a link need not know which mode it runs in.",
    ),
});
export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;
// path is root-relative with forward slashes, feeding straight into the file routes. The interface is declared by hand:
// zod's inferred type for this recursive getter collapses to `{}` past the first level.
// `type` alongside a link is its target's type, so a directory link opens like a directory. `to` is the link's literal
// text, verbatim, what hovering shows and what the author would edit.
// broken: nothing at the other end; listed anyway.
// outside: resolves outside the workspace; shown but refused, like a locked entry.
export interface WorkspaceLink {
    readonly to: string;
    readonly state?: "broken" | "outside" | undefined;
}
export const WorkspaceLinkSchema = z.object({
    to: z
        .string()
        .describe("What the link says, verbatim, rather than where it ends up. That is what the person who made it wrote, and what they would edit."),
    state: z
        .enum(["broken", "outside"])
        .optional()
        .describe(
            "Absent for an ordinary link. Broken means there is nothing at the other end, and it is listed anyway because a dangling link is worth seeing. Outside means it leads out of the workspace, so it is shown and refused.",
        ),
});
export interface WorkspaceTreeEntry {
    readonly name: string;
    readonly path: string;
    readonly type: "file" | "dir";
    readonly size?: number | undefined;
    // Ignored by tooling (node_modules, .git, gitignored paths, browser profiles); client greys the row.
    readonly ignored?: boolean | undefined;
    // Set when this entry is a symlink; `type` above is then its target's type.
    readonly link?: WorkspaceLink | undefined;
    // Absent means not descended (ignored or budget-stopped); lazy-load via /workspace/children, distinct from [].
    readonly children?: readonly WorkspaceTreeEntry[] | undefined;
}
export const WorkspaceTreeEntrySchema: z.ZodType<WorkspaceTreeEntry> = z.object({
    name: z.string().describe("Just this entry's own name."),
    path: z.string().describe("Its full path from the workspace root, which feeds straight back into the file routes."),
    type: z.enum(["file", "dir"]).describe("What it is. For a link, what it points at, so a link to a folder opens like a folder."),
    size: z.number().optional().describe("Size in bytes, for a file."),
    ignored: z
        .boolean()
        .optional()
        .describe("Tooling ignores it: installed packages, git internals, anything the ignore rules exclude. Usually drawn greyed out."),
    link: WorkspaceLinkSchema.optional().describe("Present when this entry is a link."),
    get children() {
        return z
            .array(WorkspaceTreeEntrySchema)
            .optional()
            .describe(
                "What is inside a folder. Absent means it was not opened, either because it is ignored or because the walk ran out of budget above it, so ask for it separately. An empty list means it really is empty.",
            );
    },
});
export const WorkspaceTreeSchema = z.object({
    root: z.string().describe("The path everything below is relative to."),
    tree: z.array(WorkspaceTreeEntrySchema).describe("The workspace, one entry per file and folder."),
    // How many of the root's own entries the budget cut (0 = complete); per-dir cuts count on each dir entry.
    hidden: z.number().describe("How many entries at the top level were cut for size. Zero means the listing is complete."),
    // From its own walk (empty-dirs.ts), not derived from `tree`, which stops at budget and would undercount.
    barren: z
        .array(z.string())
        .describe(
            "Folders whose whole contents are empty folders, and nothing else. Complete for the workspace, however much of the tree above was listed, and ordered like the tree, so a parent comes before the branch below it.",
        ),
    generation: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            "Which state of the shared tree this is; the changes that follow count from it. Absent for a conversation's own checkout, which is listed when asked and followed by no changes.",
        ),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;
// What moved in the shared tree between two generations: every folder whose own entries changed, parents first.
export const WorkspaceTreeDeltaSchema = z.object({
    from: z.number().int().nonnegative().describe("The generation this applies on top of. A reader holding any other fetches the tree afresh instead."),
    generation: z.number().int().nonnegative().describe("The generation it leaves the tree at."),
    dirs: z
        .array(
            z.object({
                path: z.string().describe("The folder, as a workspace path; empty for the workspace root."),
                entries: z
                    .array(WorkspaceTreeEntrySchema)
                    .describe("Its entries now, without their contents: a folder whose own entries also changed comes as an item of its own."),
            }),
        )
        .describe("Each folder that changed, parents before the folders inside them."),
    barren: z.array(z.string()).optional().describe("The barren folders now, present only when that list moved."),
});
export type WorkspaceTreeDelta = z.infer<typeof WorkspaceTreeDeltaSchema>;
// Lazy-loads one directory's children past the tree walk's budget; depth reads several levels into one flat `entries`
// list instead of one request per directory.
export const WorkspaceChildrenQuerySchema = WorkspaceScopeSchema.extend({
    path: z.string().min(1).describe("The folder to open, as a workspace path."),
    depth: z.coerce
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("How many levels to include. Omitted means direct children only; at most five levels can be read in one request."),
});
export const WorkspaceChildrenSchema = z.object({
    entries: z
        .array(WorkspaceTreeEntrySchema)
        .describe(
            "What is inside it, as a flat list. With the default depth these are direct children; a deeper request also includes descendants, whose full paths say where they belong. Folders carry no nested contents of their own.",
        ),
    hidden: z.number().describe("How many entries were cut for size. Zero means the listing is complete."),
});
export type WorkspaceChildren = z.infer<typeof WorkspaceChildrenSchema>;
// Write routes (delete) and the read they mirror. No scope: a conversation's own checkout is read-only through the file
// API, refused daemon-side.
export const WorkspaceFileQuerySchema = z.object({ path: z.string().min(1).describe("The file or folder, as a workspace path.") });
export const WorkspaceMediaTicketQuerySchema = WorkspaceScopeSchema.extend({
    path: z.string().min(1).describe("The media file the ticket should cover."),
});
// Credential for <video>/<audio>'s GET /workspace/media, the one route a browser can't header-authenticate. Scoped to
// the resolved file, so a ticket minted against a checkout can't buy its shared-tree namesake.
export const WorkspaceMediaTicketSchema = z.object({
    ticket: z.string().describe("Hand this to the streaming route in the query string. It buys exactly the one file it was minted for."),
    expiresAt: z.number().describe("When it stops working, in milliseconds, so a player can tell a dead ticket from a dead file."),
});
// A read of a window: offset negative reads that many bytes from the end (for following a growing log); limit is
// clamped to the daemon's own cap. Coerced from query strings.
export const WorkspaceFileReadQuerySchema = WorkspaceScopeSchema.extend({
    path: z.string().min(1).describe("The file to read, as a workspace path."),
    offset: z.coerce
        .number()
        .int()
        .optional()
        .describe(
            "Which byte to start at. A negative number reads that many bytes from the end, which is how you follow a growing log without knowing its size first.",
        ),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
            "How many bytes to read. Capped by the sandbox, so leaving it out or asking for too much gives you the cap rather than the whole file.",
        ),
});
// size is the whole file; offset/bytes is the window content decodes from. offset > 0 || offset + bytes < size means
// there is more to read.
export const WorkspaceFilePresentSchema = z.object({
    present: z.literal(true).describe("There is something at that path."),
    path: z.string().describe("The path, as asked for."),
    content: z.string().describe("The bytes of the window you asked for, as text."),
    size: z.number().describe("How large the whole file is. Compare it with the window below to know whether there is more."),
    offset: z.number().describe("Which byte the window starts at."),
    bytes: z.number().describe("How many bytes the window holds."),
    // True when no conversation was named, or one was but its checkout lacks the file, worth flagging.
    shared: z
        .boolean()
        .describe(
            "Which tree answered. True when no conversation was named, and also when one was but its own copy has no such file, which is the case a reader has to be told about rather than left to assume.",
        ),
});
// Nothing there is an answer, not a failure: most reads here are read-it-if-there, and a 404 would spam the browser's
// network log per miss. A refused read (an escape, a denylisted path) is still an error.
export const WorkspaceFileAbsentSchema = z.object({
    present: z
        .literal(false)
        .describe(
            "Nothing there. An answer, not a failure: reading a file that may not exist yet is the ordinary case for half the reads in this product.",
        ),
    path: z.string().describe("The path, as asked for."),
});
export const WorkspaceFileSchema = z.discriminatedUnion("present", [WorkspaceFilePresentSchema, WorkspaceFileAbsentSchema]);
// A file's derived text: the markdown shadow fileq keeps beside every document, picture, recording and archive, which
// is what an agent reads instead of the bytes. About the shared tree only, since a conversation's own checkout is never
// shadowed; no scope field, for that reason.
export const WorkspaceDerivedQuerySchema = z.object({
    path: z
        .string()
        .min(1)
        .describe("The file you want the text of, as a workspace path. The real file, not its shadow: where the text is kept is this route's business."),
});
// Where the background pass stands, workspace-wide. Nothing about a file on disk can say this, and without it an
// unrendered file and a file queued behind forty others look identical to a reader.
export const SidecarStatusSchema = z.object({
    enabled: z.boolean().describe("Whether the background pass is on (the `sidecars` setting). Off means a shadow exists only where someone asked for one."),
    queued: z.number().describe("Files waiting for a shadow, not counting the batch being rendered right now."),
    deriving: z
        .array(z.string())
        .describe("The files being rendered at this moment, as workspace paths. One batch at a time, because derivation shares the box with the agent it serves."),
    sweeping: z.boolean().describe("Whether a whole-tree pass is running, which is what a freshly enabled setting or an unlistably large batch triggers."),
    broken: z.boolean().describe("Whether the `fileq` binary is missing, in which case nothing renders in the background until this sandbox restarts."),
    shadows: z.number().optional().describe("How many shadows the last whole-tree pass counted. Absent until one has run in this daemon's lifetime."),
    sweptAt: z.string().optional().describe("When that pass finished, as an ISO timestamp."),
});
export type SidecarStatus = z.infer<typeof SidecarStatusSchema>;
// Where one file stands with that pass, which is the question a reader looking at a missing or stale shadow is
// actually asking. `idle` means the pass is on and this file is not waiting for anything: what it has is what it gets.
export const DerivedStateSchema = z.enum(["off", "queued", "deriving", "idle", "broken", "undeliverable"]);
export type DerivedState = z.infer<typeof DerivedStateSchema>;
const DerivedStandingShape = {
    state: DerivedStateSchema.describe(
        "Where this file stands with the background pass: switched off, waiting its turn, being read right now, settled, or unreachable because the renderer is missing. `undeliverable` is a format nothing here reads.",
    ),
    queue: SidecarStatusSchema.describe("How the background pass as a whole is doing, so a wait can be reported as a queue rather than as nothing happening."),
};
export const WorkspaceDerivedPresentSchema = z.object({
    ...DerivedStandingShape,
    present: z.literal(true).describe("There is derived text for that file."),
    path: z.string().describe("The file it was derived from, as asked for."),
    content: z.string().describe("The text itself, as markdown."),
    deriver: z.string().describe("Which reader wrote it, and at which version, such as `pdf+ocr v1`. A file re-derives when this changes."),
    derivedAt: z.string().optional().describe("When it was written, as an ISO timestamp. Absent only for a shadow whose front matter was edited by hand."),
    title: z.string().optional().describe("The title the format carried, where it carried one."),
    notes: z
        .array(z.string())
        .describe(
            "Every cap and degradation the derivation hit: a sheet cut to 200 rows, a book cut at 2 MB, a scan recognised rather than read. Show these with the text, since text that was cut reading as complete is the one failure this whole feature cannot afford.",
        ),
    tokens: z.number().describe("Roughly what an agent spends reading it, by the same four-chars-a-token estimate every budget here uses."),
    truncated: z.boolean().describe("Whether this is only the start of the shadow, cut to keep the response sendable. The file on disk holds the rest."),
    stale: z
        .boolean()
        .describe(
            "Whether the file has changed since this text was derived, compared by content rather than by clock. True means you are reading a rendering of an older version of the file, and deriving it again catches it up.",
        ),
});
export const WorkspaceDerivedAbsentSchema = z.object({
    ...DerivedStandingShape,
    present: z.literal(false).describe("There is no derived text for that file. Read `state` before saying so to anyone: absent and queued are different answers."),
    path: z.string().describe("The file, as asked for."),
    derivable: z
        .boolean()
        .describe("Whether this format can be turned into text at all. True means asking for it to be derived is worth offering; false means nothing here reads this format."),
    reason: z
        .string()
        .optional()
        .describe("Why there is none, when deriving was just attempted and produced nothing: the file is too large, corrupt, or of a format no reader claims."),
});
export const WorkspaceDerivedSchema = z.discriminatedUnion("present", [WorkspaceDerivedPresentSchema, WorkspaceDerivedAbsentSchema]);
export type WorkspaceDerived = z.infer<typeof WorkspaceDerivedSchema>;
// Resolves a possibly-partial path reference (a model's mention, a compiler's path) to the real workspace path it
// means, matched as a suffix.
export const WorkspaceResolveQuerySchema = WorkspaceScopeSchema.extend({
    path: z
        .string()
        .min(1)
        .max(512)
        .describe(
            "The reference as somebody wrote it. Often only the tail of the real path, which is why this is matched against the tree rather than read as-is.",
        ),
});
export const WorkspaceResolveSchema = z.object({
    path: z.string().optional().describe("The real path it means. Absent when nothing in the workspace ends that way."),
});
// Direct file management (delete, new folder, rename/move, copy). Byte writes and editor saves go through POST
// /workspace/upload instead, since oRPC can't carry a body.
export const WorkspaceDirSchema = z.object({ path: z.string().min(1).describe("The folder to create. Missing folders above it are created too.") });
export const WorkspaceMoveSchema = z.object({
    from: z.string().min(1).describe("What to move or copy, as a workspace path."),
    to: z.string().min(1).describe("Where it should end up. Changing only the last part is how you rename something."),
});
// Unpacking an archive already in the workspace. Nothing is overwritten, so the answer is where it actually landed,
// which is not always the name the caller would have guessed.
export const WorkspaceExtractSchema = z.object({
    path: z
        .string()
        .describe(
            "Where the contents landed, as a workspace path: a new folder named after the archive, or the decompressed file itself when the archive held just one. Never an existing entry written over, so a name already taken lands beside it under a free one.",
        ),
});
export type WorkspaceExtract = z.infer<typeof WorkspaceExtractSchema>;
// Deterministic, no-LLM classification into coarse buckets, read-only, applied via /workspace/move. reason is the
// winning signal: magic:<mime>, ext:<ext>, repository:<marker>, text-content, or unknown.
export const WorkspaceBucketSchema = z.enum(["repositories", "documents", "media", "archives", "other"]);
export type WorkspaceBucket = z.infer<typeof WorkspaceBucketSchema>;
export const WorkspaceClassificationSchema = z.object({
    classifications: z
        .array(
            z.object({
                path: z.string().describe("What was looked at."),
                bucket: WorkspaceBucketSchema.describe("Which bucket it was sorted into."),
                reason: z.string().describe("The signal that decided it, so the proposal can be argued with rather than trusted."),
            }),
        )
        .describe(
            "One entry per repository folder and loose file at the top of the workspace. A read-only proposal: nothing moves until you apply it.",
        ),
});
export type WorkspaceClassification = z.infer<typeof WorkspaceClassificationSchema>;
