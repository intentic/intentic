import { oc } from "@orpc/contract";
import { streamOf } from "../protocol/routes.js";
import { z } from "zod";
import { AgentEventSchema } from "../events/agent-events.js";
import {
    RunnerAttachSchema,
    RunnerCommandFrameSchema,
    RunnerCommandSchema,
    RunnerDefinitionAppliedSchema,
    RunnerFactsSchema,
    RunnerHeldTurnSchema,
    RunnerFeedFrameSchema,
    RunnerPresentationSchema,
    RunnerRevokeSchema,
    RunnerStoppedSchema,
    RunnerSyncLineSchema,
    RunnerSyncSchema,
    RunnerTurnSchema,
} from "../protocol/doors/runner-protocol.js";
import { EditorContextSchema } from "../schemas/agent.js";
import { AgentReplySchema } from "../schemas/providers/plan-limits.js";
import { OkSchema } from "../schemas/shared.js";
import {
    BrowserPageActionInputSchema,
    MoveBrowserPageInputSchema,
    ReopenBrowserPageInputSchema,
    BrowserNameParamSchema,
    BrowserPageParamSchema, BrowsersListSchema, DesktopStateSchema, OpenBrowserInputSchema, OpenBrowserResultSchema } from "../schemas/terminal.js";
import { PortParamSchema } from "../schemas/ports.js";
import { TurnErrandSchema } from "../schemas/speaker.js";

// Files a message names, as bytes: the runner resolves no path of the parent's. `path` is workspace-relative.
const RunnerFilesSchema = z.array(z.object({ path: z.string().min(1), bytesBase64: z.string() }));

// What a runner can be asked, over the socket it opened; same inversion as deviceContract, the runner is the oRPC server,
// the parent the client. No `.route()`: the procedure path is the address. Typed throughout, unlike deviceContract's
// `mcp` hole, since a runner is the same daemon image as the parent, released together.
export const runnerContract = {
    // Hardware facts, refreshed on demand; parity facts (image, overlay hash) ride the hello, not this call.
    describe: oc.output(RunnerFactsSchema),
    // `pull` updates the checkout, `push` returns a turn's result; streamed since a first sync clones repos.
    syncWorkspace: oc.input(RunnerSyncSchema).output(streamOf(RunnerSyncLineSchema)),
    // One turn in, the frames a local turn would produce out; the parent republishes them into the local pipeline.
    runTurn: oc.input(RunnerTurnSchema).output(streamOf(AgentEventSchema)),
    // The same turn's frames again, from `after` on, then live until it ends: how a parent whose socket dropped mid-turn
    // picks it back up. NOT_FOUND when the runner holds no turn for the conversation (it restarted, or is older than
    // this procedure); the parent then says the turn was lost and collects whatever its branch holds.
    attachTurn: oc.input(RunnerAttachSchema).output(streamOf(AgentEventSchema)),
    // What the runner holds for a conversation: asked before a new turn, so one that carried on after the parent lost it
    // is collected before its checkout is touched.
    heldTurn: oc.input(RunnerTurnSchema.pick({ conversationId: true })).output(RunnerHeldTurnSchema),
    // How many of the held turn's frames the parent has, said every few seconds while it relays them: the count a parent
    // that restarted mid-turn reads on from (`heldTurn().acked`), since its own count died with it.
    ackTurn: oc.input(RunnerAttachSchema).output(OkSchema),
    // A page a turn here showed (`show_page`), by the workspace path its `page` frame names: the page is filed in the
    // runner's own workspace, and the parent files a copy at the same path before relaying the frame, so the chat, which
    // reads pages from the parent, can draw it. NOT_FOUND for a path that is not a stored page; an older runner lacks the
    // procedure, and its pages stay on the runner.
    readPage: oc.input(z.object({ path: z.string().min(1) })).output(z.object({ html: z.string() })),
    // A picture a turn here showed (a screenshot, a generated image), by the workspace path its tool card names, read from
    // the runner's artifacts folder: the parent files a copy before relaying the card, as it does a page, since the chat
    // reads every picture from the parent and neither the relay nor the branch's push carries that folder. `have` is the
    // sha256 of a file the parent already holds at that path; the answer then carries no bytes when the runner's file is
    // the same. NOT_FOUND for a path outside the artifacts folder or no file there, PAYLOAD_TOO_LARGE past the cap; an
    // older runner lacks the procedure, and its pictures stay on the runner.
    // `conversationId` asks for a file in that conversation's checkout instead (a picture a turn Read from its own tree,
    // `path` relative to the checkout), which the parent files under the artifacts folder's `runner/<id>/`; an older runner
    // ignores it and answers NOT_FOUND, the path being outside its artifacts folder. `offset` and `length` ask for one
    // piece of a file past a socket frame (up to 512 MiB in all), answered with the whole file's `size`; an older runner
    // ignores them and answers the whole file, or PAYLOAD_TOO_LARGE. `have` is compared with the whole file either way.
    // The first piece (offset 0) carries the whole file's `sha256`, which the parent checks the assembled copy against.
    readArtifact: oc
        .input(
            z.object({
                path: z.string().min(1),
                have: z.string().optional(),
                conversationId: z.string().min(1).optional(),
                offset: z.number().int().nonnegative().optional(),
                length: z.number().int().positive().optional(),
            }),
        )
        .output(z.object({ bytesBase64: z.string().optional(), size: z.number().optional(), sha256: z.string().optional() })),
    // The files in the runner's artifacts folder modified within the last `withinMs` (a duration, so neither machine's
    // clock is read against the other's), the person's uploads and pages left out: what a turn here left there (a PDF, a
    // video, a trace), swept home by the parent before it relays the turn's `done` and fetched with `readArtifact`. An
    // older runner lacks the procedure (NOT_FOUND), and those files stay on the runner.
    listArtifacts: oc
        .input(z.object({ withinMs: z.number().int().positive() }))
        .output(z.object({ files: z.array(z.object({ path: z.string().min(1), size: z.number(), mtimeMs: z.number() })) })),
    // One piece of the `index`th video or audio file a stored page here streams (`show_page` media, agent/pages/page-media.ts),
    // served only while the page's manifest verifies under this runner's own key and the file is still the one shown. The
    // parent copies each into its artifacts folder and re-signs the manifest for its copies before filing the page.
    // NOT_FOUND for anything else; an older runner lacks the procedure, and its pages' media plays nowhere, as before.
    readPageMedia: oc
        .input(
            z.object({
                page: z.string().min(1),
                index: z.number().int().nonnegative(),
                offset: z.number().int().nonnegative(),
                length: z.number().int().positive(),
            }),
        )
        // The first piece (offset 0) carries the file's `sha256`, as `readArtifact` does.
        .output(z.object({ bytesBase64: z.string(), size: z.number(), sha256: z.string().optional() })),
    // Returns `applied` rather than throwing: a missing id is an ordinary race, same as local NOT_FOUND. `files` carries
    // the bytes of the files an answer attaches (a question's own-words answer), written at their workspace paths before
    // the answer applies, since the runner resolves no path of the parent's; an older runner ignores it.
    reply: oc.input(AgentReplySchema.and(z.object({ files: RunnerFilesSchema.optional() }))).output(z.object({ applied: z.boolean() })),
    // Attachments/editor context travel uncomposed: the note must build against the runner's own workspace root. `files`
    // carries the bytes of what attachments and mentions name, written before the steer applies. `voice` (default
    // "person"), `outside` and `errand` say whose words they are when not the person's: an agent's message to a working
    // child, a wake, a page's error report. An older runner ignores all four, and takes every steer as the person's.
    steer: oc
        .input(
            z.object({
                conversationId: z.string().min(1),
                text: z.string(),
                attachments: z.array(z.string()).optional(),
                mentions: z.array(z.string()).optional(),
                editorContext: EditorContextSchema.optional(),
                voice: z.enum(["person", "sandbox", "agent"]).optional(),
                outside: z.string().optional(),
                errand: TurnErrandSchema.optional(),
                files: RunnerFilesSchema.optional(),
            }),
        )
        .output(z.object({ applied: z.boolean(), invalid: z.string().optional() })),
    // REPLACE semantics: a key the definition omits returns to its default, unlike the owner apply's merge-beside.
    applyDefinition: oc.input(z.object({ toml: z.string() })).output(RunnerDefinitionAppliedSchema),
    // What the runner calls itself on its machine and whose it is, said on every connect and after a rename; the runner
    // keeps it where its machine's `ic sandbox list` reads a sandbox's name. An older runner lacks it (NOT_FOUND), and
    // stays listed by its slug.
    present: oc.input(RunnerPresentationSchema).output(OkSchema),
    // Stop the running turn; the parent's stop button reaching through.
    interrupt: oc.input(RunnerTurnSchema.pick({ conversationId: true })).output(OkSchema),
    // One shell line the parent offloaded (settings `offload`), run against a snapshot of the parent's tree; its output
    // streams back as it comes, then its exit with what it changed. An older runner lacks this procedure, which the
    // parent reads as "can't take it" and runs the line itself.
    runCommand: oc.input(RunnerCommandSchema).output(streamOf(RunnerCommandFrameSchema)),
    // Stops an offloaded line and everything it started; the parent's stop reaching through.
    cancelCommand: oc.input(RunnerCommandSchema.pick({ runId: true })).output(OkSchema),
    // Liveness driven by the parent: keepalive and gone-detection in one.
    ping: oc.output(OkSchema),
    // LIVE VIEWS (2026-11-23): what the parent's editor shows of a conversation running here, beside the views netd carries
    // down the uplink (a terminal, a browser's or the desktop's picture). Each degrades on an older runner, which lacks the
    // procedure (NOT_FOUND): the parent then shows what it has, as before.
    // The stream the parent opens each time this runner connects: every conversation's jobs and watches, then each change,
    // and a word when the browsers or the desktop changed (runner-protocol.ts RunnerFeedFrameSchema).
    feed: oc.output(streamOf(RunnerFeedFrameSchema)),
    // This runner's browser windows, as its own `system.browsers` lists them; the parent namespaces their names.
    browsers: oc.output(BrowsersListSchema),
    // The window acts the parent's browser routes forward for one of this runner's windows, by the runner's own name.
    openBrowser: oc.input(OpenBrowserInputSchema).output(OpenBrowserResultSchema),
    closeBrowser: oc.input(BrowserNameParamSchema).output(OkSchema),
    closeBrowserPage: oc.input(BrowserPageParamSchema).output(OkSchema),
    // This runner's desktop, as its own `system.desktop` says; starts nothing.
    desktop: oc.output(DesktopStateSchema),
    // A person's stops on a runner conversation's card, applied here where the job or watch lives; `stopped` false when
    // nothing was left to stop. Naming no watch disarms them all.
    stopJob: oc.input(z.object({ conversationId: z.string().min(1), jobId: z.string().min(1) })).output(RunnerStoppedSchema),
    stopWatching: oc.input(z.object({ conversationId: z.string().min(1), watchId: z.string().optional() })).output(RunnerStoppedSchema),
    // Whether a port here may be previewed through the parent: something listens on it, reachable on loopback, and it is
    // not a browser's DevTools port. A refusal is answered, with the reason the parent's own forward would give, never
    // thrown: a NOT_FOUND is only ever an older runner without the door.
    vetPort: oc.input(PortParamSchema).output(z.object({ refused: z.string().optional() })),
    // The parent revoked a member's access (or everyone's): the picture sockets and tokens this runner's castd holds are
    // ended, as the parent's own are; the parent's netd already closed every view it carried for them.
    revoke: oc.input(RunnerRevokeSchema).output(OkSchema),
    // A tab's own menu and the strip's drag on one of this runner's windows, by its own name (`system.reopenBrowserPage`,
    // `moveBrowserPage`, `browserPageAction` there): answers the tab acted on or opened, nothing for a move.
    browserTab: oc
        .input(
            z.union([
                ReopenBrowserPageInputSchema.extend({ op: z.literal("reopen") }),
                MoveBrowserPageInputSchema.extend({ op: z.literal("move") }),
                BrowserPageActionInputSchema.extend({ op: z.literal("action") }),
            ]),
        )
        .output(OpenBrowserResultSchema.partial()),
};
