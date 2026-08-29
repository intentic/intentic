// workspace tree + files
import { z } from "zod";
import { ConversationIdSchema } from "./agent.js";
/* WHOSE COPY OF THE WORKSPACE A READ MEANS, the half of a file address that used to be implicit, and wrong.
 *
 * There is not one workspace. There is the shared /work tree, and there is one private checkout per isolated
 * conversation, each holding files that conversation created and versions of files it edited. Every workspace
 * read route named a PATH and nothing else, so it could only ever answer from the shared tree, and an agent
 * that had just written `docs/plan.md` in its own checkout described a file the viewer could not open, while
 * an agent that had EDITED a file got something worse: the shared version, same path, different text, with
 * nothing to say so.
 *
 * So the conversation rides the request. Absent ⇒ the shared tree, which is what every existing caller means
 * and why the field is optional rather than a second set of routes. Present ⇒ that conversation's own
 * checkout, resolved daemon-side in ONE place (workspaceRootFor) so the escape guard, the control-plane
 * denylist and the ignore rules apply to it exactly as they do to /work.
 *
 * A conversation that is not isolated resolves BACK to the shared tree rather than failing: the shared tree
 * genuinely is its tree, and a caller should not have to know which mode a conversation runs in to link to a
 * file in it. */
export const WorkspaceScopeSchema = z.object({
    agent: ConversationIdSchema.optional().describe(
        "Read a conversation's own private copy of the workspace rather than the shared tree. Leave it out for the shared tree. A conversation that is not working privately resolves back to the shared tree rather than failing, so a link need not know which mode it runs in.",
    ),
});
export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;
/* One node of the full /work filesystem tree the agent sees (untracked + generated files included), distinct
 * from the git-tracked listing. `path` is root-relative with forward slashes so it feeds straight back to the
 * file route.
 *
 * Recursive, and the type is declared rather than inferred. Zod's getter form does infer one, but it collapses
 * to `{}` below the first level of nesting, so `entry.children[0].name` type-checked as an index-signature
 * read on both sides of the wire, and the tree walker's own suite was reading a `hidden` field off entries
 * that has never existed there without the compiler minding. The interface is the contract; the schema
 * validates against it, and z.ZodType makes a divergence between the two an error here. */
/* A SYMLINK, as the tree reports one. Present only on entries that are links; `type` beside it is the type of
 * whatever the link POINTS AT, so a link to a directory expands and a link to a file opens, exactly like the
 * real thing (the model VSCode uses, its FileType carries SymbolicLink as a bit alongside File/Directory,
 * precisely so every consumer can keep asking "file or folder?").
 *
 * `to` is the link's own text, verbatim, `../../.agents/skills/discord`, not the resolved path. That is what
 * the row shows on hover, because it is what the person who made the link wrote and what they would edit.
 *
 * `state` is absent for the ordinary case: it resolves, and it resolves to somewhere inside the workspace.
 *   - "broken", nothing at the other end. Listed anyway, because a dangling link is a fact about the
 *     workspace worth seeing rather than an entry to hide.
 *   - "outside", it resolves to bytes outside the workspace. The daemon will not read, list or descend
 *     through it (workspace-files.ts realWithin), so the row is shown and refused, like a locked one. */
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
    // Ignored-by-tooling (node_modules, .git, .gitignore'd paths, browser profiles): the client grays the row.
    readonly ignored?: boolean | undefined;
    // Set when this entry is a symlink, `type` above is then its TARGET's type. See WorkspaceLink.
    readonly link?: WorkspaceLink | undefined;
    // A DIR without `children` was listed but not descended into, because it's ignored, or because the walk's
    // breadth-first budget stopped above it. Either way the client lazy-loads it via /workspace/children on
    // expand, so "not loaded yet" and "empty directory" (`children: []`) stay distinguishable.
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
    // How many of the ROOT's own entries the budget cut (0 = complete); per-dir cuts are counted on each dir entry.
    hidden: z.number().describe("How many entries at the top level were cut for size. Zero means the listing is complete."),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;
// Lazy-load one directory's children, for a dir the tree walk listed but didn't descend into. Child dirs again
// carry no `children`, so they lazy-load on their own expand. `hidden` = how many entries the cap cut (0 = all
// listed).
export const WorkspaceChildrenQuerySchema = WorkspaceScopeSchema.extend({
    path: z.string().min(1).describe("The folder to open, as a workspace path."),
});
export const WorkspaceChildrenSchema = z.object({
    entries: z
        .array(WorkspaceTreeEntrySchema)
        .describe("What is directly inside it. Folders in here carry no contents of their own, so they open the same way."),
    hidden: z.number().describe("How many entries were cut for size. Zero means the listing is complete."),
});
export type WorkspaceChildren = z.infer<typeof WorkspaceChildrenSchema>;
// Write routes (delete) and the read they mirror. No scope: a conversation's own checkout is READ-ONLY through
// the file API, see workspaceRootFor for why the refusal lives daemon-side rather than in each screen.
export const WorkspaceFileQuerySchema = z.object({ path: z.string().min(1).describe("The file or folder, as a workspace path.") });
export const WorkspaceMediaTicketQuerySchema = WorkspaceScopeSchema.extend({
    path: z.string().min(1).describe("The media file the ticket should cover."),
});
/* The credential a <video>/<audio> element carries to GET /workspace/media, which is the one workspace route a
 * browser cannot put a header on. Minted here, over the ordinary bearer-authenticated contract, and scoped to
 * the single FILE it was asked for, the resolved one, so a ticket minted against a conversation's checkout
 * buys that file and not its shared-tree namesake (see auth/media-tickets.ts for why scope rather than
 * single-use is what bounds it). `expiresAt` is epoch ms so a player can tell a dead ticket from a dead file. */
export const WorkspaceMediaTicketSchema = z.object({
    ticket: z.string().describe("Hand this to the streaming route in the query string. It buys exactly the one file it was minted for."),
    expiresAt: z.number().describe("When it stops working, in milliseconds, so a player can tell a dead ticket from a dead file."),
});
/* A text read is a read of a WINDOW: `offset` is the byte to start at (negative reads that many bytes from the
 * END, which is what following a growing log means, the tail's offset isn't knowable until the size is), and
 * `limit` how many bytes to serve. The daemon clamps `limit` to its own cap, so an omitted or oversized one is
 * the cap rather than the file. Coerced: these arrive as query strings. */
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
// `size` is the whole file; `offset`/`bytes` the byte range `content` decodes from, so the reader can tell a
// window from a whole file (offset > 0 || offset + bytes < size ⇒ there is more) and ask for the next one.
export const WorkspaceFilePresentSchema = z.object({
    present: z.literal(true).describe("There is something at that path."),
    path: z.string().describe("The path, as asked for."),
    content: z.string().describe("The bytes of the window you asked for, as text."),
    size: z.number().describe("How large the whole file is. Compare it with the window below to know whether there is more."),
    offset: z.number().describe("Which byte the window starts at."),
    bytes: z.number().describe("How many bytes the window holds."),
    // Which tree answered. Always true when no `agent` was asked for; true DESPITE one when that conversation's
    // checkout doesn't carry the path (see scopedTarget, its checkout is not a superset of /work), which is
    // the one case the reader has to be told about rather than left to assume.
    shared: z
        .boolean()
        .describe(
            "Which tree answered. True when no conversation was named, and also when one was but its own copy has no such file, which is the case a reader has to be told about rather than left to assume.",
        ),
});
/* NOTHING TO READ AT THAT PATH, an ANSWER, not a failure, which is the whole reason this branch exists.
 *
 * Most reads in this product are "read it if it is there": the file each extension keeps of what its badge has
 * already shown, a repo's documentation index, a run's result, a directory's own UI document. Absent is their
 * ordinary FIRST state, and every one of them already treats it as a value. Answering those with a 404 made the
 * browser log a failed request per read, around a dozen red lines on every page load, none of which meant
 * anything was wrong, and none of which a `catch` can suppress: the log happens in the network stack before any
 * JavaScript sees the response.
 *
 * A read that is REFUSED (an escape, the control plane, a denylisted path) is still an error, because that is a
 * real answer about the caller rather than about the file. */
export const WorkspaceFileAbsentSchema = z.object({
    present: z
        .literal(false)
        .describe(
            "Nothing there. An answer, not a failure: reading a file that may not exist yet is the ordinary case for half the reads in this product.",
        ),
    path: z.string().describe("The path, as asked for."),
});
export const WorkspaceFileSchema = z.discriminatedUnion("present", [WorkspaceFilePresentSchema, WorkspaceFileAbsentSchema]);
// Resolve a file reference an agent (or a compiler, or a terminal) NAMED to the workspace path it means. Prose
// paths are routinely partial, a model that has been discussing `_editor/web/src` writes
// `pages/workspace/Foo.vue`, so a clickable mention has to be matched as a path SUFFIX against the real tree,
// not read as root-relative. `path` is absent when nothing in the workspace ends in that reference.
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
// Direct file management over the /work tree (delete / new folder / rename+move / copy). Byte writes + the
// editor's text save go through the plain POST /workspace/upload route (a body doesn't fit oRPC), not here.
export const WorkspaceDirSchema = z.object({ path: z.string().min(1).describe("The folder to create. Missing folders above it are created too.") });
export const WorkspaceMoveSchema = z.object({
    from: z.string().min(1).describe("What to move or copy, as a workspace path."),
    to: z.string().min(1).describe("Where it should end up. Changing only the last part is how you rename something."),
});
// Deterministic (no-LLM) classification of the dropped workspace: each repo dir and loose file sorted into one
// coarse bucket. Read-only, the browser turns it into a proposed layout and applies the accepted moves via the
// existing /workspace/move route. `reason` records the winning signal (magic:<mime>, ext:<ext>,
// repository:<marker>, text-content, unknown) so the proposal is explainable.
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
