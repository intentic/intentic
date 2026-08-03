import { ExtensionManifestSchema } from "@intentic/extension-api";
import { RegistryEntrySchema } from "@intentic/registry";
import { z } from "zod";
import { OutputFieldsSchema } from "./output-fields.js";

// All request/response wire schemas for the sandbox daemon. Inputs that carry a `{param}` in their route path
// (repo / id / name) merge the path param into the same flat object — oRPC fills the path placeholder from the
// matching key and routes the rest to the body (POST/PUT) or query (GET).

// ---- shared ----

// Success ack for routes that only report completion (push / disconnect / self-host register). A turn paused on
// a plan/question that no longer exists, or a missing repo/path, is an ORPCError thrown by the handler instead.
export const OkSchema = z.object({ ok: z.literal(true) });

// Which repo a git route targets: "root" (the /work workspace repo) or a repo id — the repo's root-relative
// dir, which may be nested ("clients/foo"; URL-encoded in the path param). Kept as a bare string on the wire
// (not an enum) so an unknown repo is a handler-thrown NOT_FOUND — matching the daemon's prior 404 — rather
// than an input-validation rejection.
export const RepoParamSchema = z.object({ repo: z.string() });

// ---- agent ----

export const SessionTranscriptMessageSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
export type SessionTranscriptMessage = z.infer<typeof SessionTranscriptMessageSchema>;

// The agent runtimes the daemon can serve — the vocabulary every surface that picks an agent shares (chat
// turns, automations). The NATIVE providers have dedicated adapters (and their ids are reserved); an
// `endpoint/<id>` value names an installed `endpoint`-kind capability (a model API the user pointed us at,
// see EndpointConfigSchema); any other value is the id of an installed `agent`-kind capability served over
// ACP (Agent Client Protocol).
// Kept as a bare string on the wire (not an enum) so an unknown id is a clean error frame from the agent
// route — the same bet RepoParamSchema makes — and adding an ACP agent needs no contract change.
export const NATIVE_PROVIDERS = ["claude", "codex", "grok", "kimi", "gemini"] as const;
export type NativeProvider = (typeof NATIVE_PROVIDERS)[number];
export const AgentProviderSchema = z.string().min(1);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

// The harness (agentic loop) a turn runs on, orthogonal to the provider. See AgentTurnSchema.harness.
export const AgentHarnessSchema = z.enum(["native", "claude-code"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;

// What the user is looking at in the editor, attached to a turn only when they explicitly opt in (the
// composer chip — off by default). The daemon folds it into the prompt as a context note, so deictic
// prompts ("fix this") resolve without an @-mention. Selection is bounded — it's context, not an upload.
export const EditorContextSchema = z.object({
    // Workspace-relative path of the file open in the editor.
    file: z.string().min(1),
    // 1-based line range of the selection; absent when the whole file is the context.
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    // The selected text itself, truncated client-side to the cap.
    selection: z.string().max(20_000).optional(),
});
export type EditorContext = z.infer<typeof EditorContextSchema>;

// The client-minted stable conversation identity. Constrained because isolated conversations also use it in
// branch names (agent/<id>) and filesystem paths — the regex is the injection guard. Shared by turn + attach.
const ConversationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

// Where a conversation came from when nobody typed it into the browser: an automation wake carrying a message
// from OUTSIDE the sandbox (a Discord mention, a web-chat visitor, a webhook). Such a wake runs as an ordinary
// isolated conversation — registry entry, worktree, chat tab, land flow — and this is the only thing that
// distinguishes it on the surface: the card's provenance line and the reason its first prompt is not the
// user's. Set daemon-side by the dispatcher that received the message; the browser never sends one.
export const AgentOriginSchema = z.object({
    // The automation whose configured prompt opened the conversation.
    automationId: z.string(),
    // The listener provider that received the message ("discord", "webchat", …) or "webhook" for an event
    // trigger. An open string for the same reason Trigger.provider is: sources are extension-declared.
    provider: z.string(),
    // The external thread it arrived on — a Discord channel id, a widget conversation id. Absent for webhooks.
    channelId: z.string().optional(),
    // Who sent it, as the source names them.
    author: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;

// How tool calls are gated — the Claude Agent SDK's PermissionMode, narrowed to the four the composer offers
// (the SDK also has 'dontAsk'/'auto', which have no UI here). The user picks one per turn AND the agent can
// move itself between them mid-turn, so this is both a turn input and the payload of the `mode` frame.
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const AgentTurnSchema = z
    .object({
        prompt: z.string(),
        // The client's display title for the conversation — seeds a FRESH registry entry (so a renamed draft's
        // first turn keeps its user-chosen title); an existing entry's title always wins.
        title: z.string().max(80).optional(),
        // Workspace-relative paths of files the user attached, already uploaded via /workspace/upload
        // (the browser puts them under .intentic/attachments/<uuid>/<name>). The daemon hands them to the
        // provider: Claude reads them from disk via its Read tool; Codex gets images as native inputs.
        attachments: z.array(z.string().min(1)).max(20).optional(),
        // Which provider (model + account) serves the turn; absent = claude. A sessionId only resumes on the
        // provider that minted it (Claude Code sessions vs Codex threads vs Grok/OpenCode sessions are separate
        // stores) — a mid-conversation provider/account/harness switch sends `history` instead of resuming.
        agent: AgentProviderSchema.optional(),
        // Which harness (agentic loop) runs the turn, orthogonal to the provider above. Absent = "native": each
        // provider on its own runtime (Claude Code SDK / Codex CLI / opencode) with its subscription OAuth.
        // "claude-code" forces the Claude Code Agent SDK loop for ANY provider — codex/grok then drive their model
        // through the sandbox's bundled Anthropic↔OpenAI translator, which needs that provider's API key (its
        // subscription OAuth can't reach a gateway). For the claude provider the two are identical.
        harness: AgentHarnessSchema.optional(),
        // Which connected account of that provider serves the turn; absent = the provider's first account.
        account: z.string().optional(),
        sessionId: z.string().optional(),
        // The client-minted stable conversation identity (survives provider/account/harness switches, which
        // retire sessions). Keys the fleet registry entry and turn run, plus the worktree when isolated.
        conversationId: ConversationIdSchema.optional(),
        // When true, the turn runs in the conversation's isolated git worktree (created lazily on first use)
        // instead of the shared /work tree — the parallel-agents mode. Requires conversationId.
        isolated: z.boolean().optional(),
        // Set ONLY by the daemon's own automation dispatchers: this turn opens a conversation on behalf of an
        // outside message rather than a user. Recorded on the registry entry so the fleet can say where the
        // agent came from. Requires conversationId — there is nothing to record it on otherwise.
        origin: AgentOriginSchema.optional(),
        // The client-held transcript of a conversation that just switched provider/account: seeds the FIRST
        // turn of the replacement session. The daemon folds it into the prompt as one role-attributed context
        // preamble for every runtime. Mutually exclusive with sessionId — a resumed session has its context.
        history: z.array(SessionTranscriptMessageSchema).max(200).optional(),
        // The browser sends the chosen model per turn; the provider token is the sandbox's own stored credential.
        model: z.string().optional(),
        /* NOBODY PICKED A MODEL FOR THIS TURN — a surface started it (Fix with agent, a Maintenance chore, a
         * Documentation or Acceptance run, the fix a failed pre-push check proposes) rather than a person at a
         * composer. That is the whole distinction the flag carries, and it is why it cannot be inferred: a chat
         * turn ALSO arrives with no `model` whenever the live catalog hasn't loaded yet, and the two want
         * opposite defaults — the chat wants the provider's own catalog default, an unattended run wants the
         * tier its owner chose for work that spends money while they are not watching.
         *
         * The daemon fills `agent`/`model`/`effort` from agentRunModel/agentRunEffort for any turn that says
         * this and names none of them (startConversationTurn). Naming one still wins: Acceptance picks per run
         * because it fans a session out per story, and that pick is the user's, made a second ago. */
        unattended: z.boolean().optional(),
        // How tool calls are gated for this turn (the SDK's permissionMode, verbatim). 'plan' runs the
        // propose → approve → execute flow; 'default' prompts per tool on the permission side channel;
        // 'acceptEdits' auto-accepts file edits; 'bypassPermissions' runs everything. The agent can move
        // itself between modes mid-turn (EnterPlanMode/ExitPlanMode), which rides back as a `mode` frame.
        permissionMode: PermissionModeSchema.optional(),
        /* Narrows the turn to these tool names (the SDK option of the same name — not to be confused with the
         * daemon's MCP `tools`, which are servers). Absent ⇒ every tool the runtime has, which is what an
         * owner-driven chat wants. Set by the automation dispatchers from Automation.allowedTools: a wake driven
         * by an OUTSIDE message runs bypassPermissions like any other automation turn, so for a public Doorbell
         * this list is the actual boundary — prompt wording is advice, an empty toolbox is not. */
        allowedTools: z.array(z.string().min(1)).optional(),
        effort: z.string().optional(),
        thinking: z.boolean().optional(),
        /* Ask the harness to serve this turn at fast speed — the same tokens at a higher rate, for a higher
         * per-token price. A REQUEST, never a promise: the harness answers it against the plan, the model and
         * the endpoint, and reports what it actually did on the `fast_mode` frame. Absent/false ⇒ standard
         * speed, which is also what a runtime that doesn't declare the capability gets (turn-plan drops it).
         *
         * Not a sandbox setting, for the same reason effort isn't: it changes what a turn COSTS, so it belongs
         * to the turn that spends it rather than to the workspace it ran in. */
        fast: z.boolean().optional(),
        // The opt-in editor context chip: what the user is looking at, folded into the prompt daemon-side.
        editorContext: EditorContextSchema.optional(),
    })
    // An attachment-only send (no text) is legal; an entirely empty turn is not.
    .refine((turn) => turn.prompt.trim().length > 0 || (turn.attachments?.length ?? 0) > 0, {
        message: "prompt or attachments required",
    })
    .refine((turn) => turn.sessionId === undefined || turn.history === undefined, {
        message: "history and sessionId are mutually exclusive",
    })
    .refine((turn) => turn.isolated !== true || turn.conversationId !== undefined, {
        message: "isolated requires conversationId",
    })
    .refine((turn) => turn.origin === undefined || turn.conversationId !== undefined, {
        message: "origin requires conversationId",
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

// POST /agent's ack: the daemon-minted id of the detached turn run it started. The turn executes daemon-side
// regardless of any client connection; every window — the initiator included — renders it via /agent/attach.
export const StartedTurnSchema = z.object({ run: z.string() });
export type StartedTurn = z.infer<typeof StartedTurnSchema>;

// Attach to a conversation's turn run (live, or finished within the retention window). `run`+`after` is the
// resume cursor of a client whose stream dropped: frames after `after` replay when `run` still names the
// current run; a mismatch (a newer turn started meanwhile) replays that run from its first frame instead.
export const AttachTurnSchema = z.object({
    conversationId: ConversationIdSchema,
    run: z.string().optional(),
    after: z.number().int().min(0).optional(),
});
export type AttachTurn = z.infer<typeof AttachTurnSchema>;

// ---- loops: run a conversation again, and again, until a goal is met ----
/* THE RALPH LOOP. An automation answers "run this at 3am"; a loop answers "run this until it is actually done".
 * The two are the opposite question and neither substitutes for the other: a schedule repeats on CADENCE and
 * never converges, a loop repeats on CONVERGENCE and stops the moment its goal is met.
 *
 * A loop is an ATTRIBUTE OF A CONVERSATION, not a new kind of object. It drives ordinary turns on an ordinary
 * fleet agent, which is what makes the worktree, the cost ledger, the transcript, the /agents card and the Stop
 * button work on it without a line of new code — the same bet the acceptance extension makes when it derives
 * conversation ids instead of owning session machinery.
 */

// How the next iteration meets its context, and the single most consequential field here.
//
// `fresh` is the canonical Ralph and the default: each iteration is a NEW provider session against the SAME
// worktree, so the filesystem — not the transcript — is the memory. Immune to context rot, so iteration 20 reads
// the tree as clearly as iteration 1, and it costs a re-read each time. The loop keeps a progress file for it
// (see LOOP_DIR) precisely because nothing else carries forward.
//
// `continue` resumes the provider session, so an iteration is a follow-up prompt. Cheaper (the prefix caches)
// and it keeps the reasoning, which is what a short refine-this loop wants. It degrades on long runs, and it
// degrades in the direction that matters: a session that has spent eleven turns arguing for its own approach is
// the worst available judge of whether that approach is finished.
export const LoopContextSchema = z.enum(["fresh", "continue"]);
export type LoopContext = z.infer<typeof LoopContextSchema>;

/* WHAT THE LOOP PRODUCES — asked separately from what ends it, because they are separate questions and
 * conflating them is what makes a chain of sessions impossible to build.
 *
 * `none` — the loop produces nothing but its work. The classic "make the suite green": what it leaves behind
 *   is a green suite, and asking it to also file a report is asking it to spend a turn on paperwork.
 * `claim` — the iteration writes `{done, reason, evidence?}`. Prose, but STRUCTURED prose: `done` is a boolean
 *   the daemon reads rather than a sentence it has to interpret. Self-assessment, so advisory by construction —
 *   it exists because plenty of goals have no command that can check them ("the README explains the auth
 *   flow"), not because a model's word for it is worth much.
 * `json` — the iteration writes `{done, reason, data}` where `data` matches a declared field list. This is the
 *   one that makes a step's output usable as the next step's input: a paragraph mentioning three files cannot
 *   be fed to anything, `{files: [...]}` can.
 *
 * All three land in ONE file per iteration, with one shape, differing only in strictness. See LoopDocumentSchema.
 */
export const LoopOutputSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("claim") }),
    z.object({ kind: z.literal("json"), fields: OutputFieldsSchema }),
]);
export type LoopOutput = z.infer<typeof LoopOutputSchema>;

/* WHAT ELSE HAS TO BE TRUE — checks that are not the worker's own word, ANDed with the output above.
 *
 * `command` is a shell one-liner run in the conversation's tree; exit 0 ⇒ satisfied. Deterministic, free, and
 * the only signal here whose answer does not come from a model. It is the automation `guard` with the sign
 * flipped, and it runs through the same runner. `pnpm test` passing beats any amount of self-report.
 *
 * `judge` puts a SEPARATE, tool-less call on the question: it reads the iteration's own report and rules
 * against a rubric, having done none of the work and nothing invested in it being finished.
 *
 * The rule both encode, and the reason they are kept apart from the output: the check must be a DIFFERENT CALL
 * from the work, or it is not a check. An output is what the worker says; a check is what someone else says.
 */
export const LoopCheckSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("command"), command: z.string().min(1) }),
    // The rubric is what the judge is asked; absent `model` runs it on the quick rung the other helpers use.
    z.object({ kind: z.literal("judge"), rubric: z.string().min(1), model: z.string().optional() }),
]);
export type LoopCheck = z.infer<typeof LoopCheckSchema>;

/* THE VERDICT FILE an iteration writes — one shape for all three output kinds, because the loop reads it the
 * same way whatever was declared and only the validation of `data` differs.
 *
 * It is a FILE rather than a sentence in the reply for the reason every structured output in this codebase is
 * a file: a reply has to be parsed out of prose the model is simultaneously using to talk to a person, and the
 * two demands pull against each other until neither is served. A file has one job.
 */
export const LoopDocumentSchema = z.object({
    // Whether the goal is met NOW. The loop's own reading of this is the whole point of the file.
    done: z.boolean(),
    // One line: why it is or is not met. The single most-read string in the feature — it is what the next
    // iteration reads first and what the history row shows.
    reason: z.string(),
    // What the iteration checked to know that. Optional because a model with nothing to point at should say so
    // by omitting it rather than by inventing a sentence.
    evidence: z.string().optional(),
    // The declared fields, present only for a `json` output and validated against them there.
    data: z.record(z.string(), z.unknown()).optional(),
});
export type LoopDocument = z.infer<typeof LoopDocumentSchema>;

// Enough iterations for a real convergence, few enough that a misconfigured loop is a bounded mistake. A loop
// that has not converged in 50 turns is not one iteration short of it.
const LOOP_ITERATIONS_MAX = 50;

export const LoopSchema = z.object({
    // The conversation the loop drives — its fleet card, its worktree, its transcript.
    conversationId: ConversationIdSchema,
    // What "done" means, in the user's words. Rides into every iteration's prompt (and into the judge's
    // question) so the model is told the goal it is being measured against rather than left to infer it.
    goal: z.string().min(1),
    // What each iteration is asked to DO. Separate from `goal` because they are different sentences: "make the
    // suite green" is the goal, "run the tests, pick the top failure, fix it" is the instruction.
    prompt: z.string().min(1),
    context: LoopContextSchema,
    output: LoopOutputSchema,
    /* Everything besides the worker's own word that has to hold before the loop may end. Ordinarily one or
     * none; a list because "the suite is green AND the report is written" is a real completion bar and
     * expressing it as two loops would run the work twice. */
    checks: z.array(LoopCheckSchema),
    maxIterations: z.number().int().min(1).max(LOOP_ITERATIONS_MAX),
    // The spend ceiling in USD across the whole loop, summed from the turns' own usage frames. Optional because
    // a 3-iteration loop does not need one; strongly wanted on anything unattended, since this is the first
    // feature in the sandbox that can spend without a person pressing anything between turns.
    maxSpendUsd: z.number().positive().optional(),
    /* Stop after this many CONSECUTIVE iterations that changed nothing in the tree.
     *
     * The guard that matters most in practice, and the one whose absence is expensive. The failure mode of a
     * loop is not runaway success, it is an agent that re-reads the same three files, restates the same plan,
     * declares more work remains, and does that eleven times. Nothing about that is an error — every turn
     * succeeds — so only "the tree did not move" catches it. */
    stallLimit: z.number().int().min(1),
    // Whether the iterations run in the conversation's own worktree or on the shared tree. Recorded on the loop
    // rather than read off the conversation because a loop can OPEN one, and because it decides where the stop
    // command runs: a check against /work would be testing code an isolated loop has not landed yet.
    isolated: z.boolean(),
    // Which provider / harness / model the iterations run on; absent ⇒ the conversation's own last choice, then
    // the provider default. The same three passthroughs an automation carries, for the same reason: a headless
    // driver has no composer to read them from.
    agent: AgentProviderSchema.optional(),
    harness: AgentHarnessSchema.optional(),
    model: z.string().optional(),
});
export type Loop = z.infer<typeof LoopSchema>;

// Can this loop ever end on its own terms? A loop with nothing to produce and nothing to check runs to its
// iteration ceiling and reports `exhausted`, having been unable to succeed from the moment it was configured.
// A predicate rather than a schema refinement because both callers want it as one: the route refuses, and the
// dialog greys out its button while you are still deciding.
export const loopCanConverge = (loop: Pick<Loop, "output" | "checks">): boolean => loop.output.kind !== "none" || loop.checks.length > 0;

/* Where a loop keeps what it must not lose between iterations: <workspace>/.intentic/loops/<conversationId>/.
 *
 * Under `.intentic` for the reason the acceptance runs are — it is outside every repo and bound back SHARED
 * into an isolated turn's worktree, so the agent writes and the browser reads the same tree, with nothing to
 * land and no git noise. `progress.md` is the loop's memory in `fresh` mode and its audit trail in `continue`
 * mode; `iteration-<n>.json` is the verdict a `claim` stop reads. */
export const LOOP_DIR = ".intentic/loops";

// Why an iteration ended, which is not the same question as how the LOOP ended. `continue` is the ordinary
// "not done yet"; `error` is a turn that surfaced an error frame, which does NOT end the loop by itself — a
// failing turn is often exactly what the next iteration is supposed to fix.
export const LoopIterationSchema = z.object({
    n: z.number().int().min(1),
    at: z.number(),
    outcome: z.enum(["continue", "done", "error"]),
    // The stop check's own words — the guard's output tail, the claim's reason, the judge's verdict. What the
    // run history is actually read for: "why did it keep going" and "why did it stop".
    detail: z.string().optional(),
    costUsd: z.number().optional(),
    // Whether the tree moved this iteration. Feeds the stall detector, and is worth showing per row: three
    // unchanged iterations in a history is the shape of a loop that is not working.
    changed: z.boolean(),
    // The provider session this iteration ran on — the door from a history row to a readable transcript.
    sessionId: z.string().optional(),
});
export type LoopIteration = z.infer<typeof LoopIterationSchema>;

/* How a loop ended, and every one of these is a distinct thing to tell the user.
 *
 * `done` — the stop condition was met. The only success.
 * `exhausted` — maxIterations ran out with the goal unmet.
 * `stalled` — stallLimit consecutive iterations changed nothing. Reported apart from `exhausted` because the
 *   remedy is different: exhausted says "give it more room", stalled says "it is not making progress and more
 *   room will not help".
 * `overspent` — maxSpendUsd was reached.
 * `stopped` — the user pressed Stop.
 * `error` — the loop itself failed (not a turn inside it; see LoopIteration.outcome).
 */
export const LoopStateSchema = z.enum(["running", "done", "exhausted", "stalled", "overspent", "stopped", "error"]);
export type LoopState = z.infer<typeof LoopStateSchema>;

export const LoopRecordSchema = LoopSchema.extend({
    state: LoopStateSchema,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    /* How many times a daemon BOOT has picked this loop back up. The record is its own journal: a loop still
     * marked `running` at boot is exactly one the daemon died under, which is the same trick turn-journal.ts
     * plays with its files and needs no second store to play it.
     *
     * Counted, not just flagged, for the reason the turn journal counts its attempts — a loop whose iteration
     * reliably kills the daemon (an OOM in a test it keeps running) would otherwise be resurrected on every
     * boot forever, and the container is recreated on every sandbox update. */
    resumed: z.number().int().min(0),
    // Why the loop ended, for the states whose reason isn't in their name (`error`, and a `done` whose stop
    // check said something worth keeping).
    detail: z.string().optional(),
    iterations: z.array(LoopIterationSchema),
});
export type LoopRecord = z.infer<typeof LoopRecordSchema>;

export const LoopsListSchema = z.object({ loops: z.array(LoopRecordSchema) });
export const LoopIdParamSchema = z.object({ conversationId: ConversationIdSchema });

// ---- agents: the conversation fleet ----
// A "fleet agent" is any conversation with a registry entry, keyed by its conversationId. Isolated ones own a
// git worktree (branch agent/<id> in every workspace repo); workspace conversations have no branch. The fleet
// surface shows both through the same status/activity/cost lifecycle.

// idle/running/awaiting are the turn lifecycle (awaiting = paused on a plan approval or question); ready /
// landed / conflict are outcomes of the land flow — `ready` is a clean completion whose delta stayed on the
// agent's branch because auto-land is off (the user lands it deliberately, from the review panel or the card);
// error is a terminal turn failure surfaced on the card.
//
// `interrupted` is the turn that never got to report ANY of those: the daemon died under it (a container
// rebuild, a crash, an OOM kill), taking the provider process and the whole runtime half of the fleet — status,
// attention flags, the park a question raised — with it. It exists because the alternative is worse than
// unlabelled: without it such a turn rehydrates as `idle`, which is the resting status of a turn that finished
// CLEANLY, so the board files a killed agent under Finished and the question it was holding disappears with the
// process that asked it. See agents-store.ts — this is the status a live turn leaves on disk.
//
/* `stopping` and `stopped` are the two halves of a user's Stop, and they exist because a hard-cancel is NOT
 * instant: /agent/stop aborts the provider and then waits for the turn's generator to unwind (worktree and
 * registry cleanup), which is seconds of real time. For that whole window the runtime half still said
 * `running`, so every surface kept its spinner turning on a turn the user had already killed — and then the
 * card jumped to a settled state out of nowhere. `stopping` is what the daemon knows the instant the abort
 * lands, published immediately so the press has a visible result; `stopped` is where the turn comes to rest.
 *
 * `stopped` is deliberately its own value rather than `interrupted` or `error`. Not `error`, which is what a
 * stopped turn used to report (every provider adapter surfaces the abort's unwind as an error frame) — a card
 * accusing the user's own deliberate press of being a failure. Not `interrupted` either: that one means the
 * daemon died under the turn, and a boot pass may re-run it, which is precisely what must never happen to a
 * turn a person chose to end. */
export const AgentStatusSchema = z.enum([
    "idle",
    "running",
    "awaiting",
    "stopping",
    "stopped",
    "ready",
    "landed",
    "conflict",
    "error",
    "interrupted",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
// The card's live activity snippet: the last tool the agent used (with its target) and the in-progress todo.
export const AgentActivitySchema = z.object({
    tool: z.string().optional(),
    target: z.string().optional(),
    todo: z.string().optional(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
// Which "needs you" flags are raised — the fleet badge aggregates these across all agents.
export const AgentAttentionSchema = z.object({
    plan: z.boolean(),
    question: z.boolean(),
    permission: z.boolean(),
    conflict: z.boolean(),
});
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;
export const AgentSummarySchema = z.object({
    // The conversationId.
    id: z.string(),
    sessionId: z.string().optional(),
    // First prompt, sanitized to one bounded line.
    title: z.string().optional(),
    status: AgentStatusSchema,
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    // What the agent's last turn ran with — the model, its reasoning effort, whether extended thinking was on,
    // and whether fast speed was asked for. Recorded per agent because they are facts about THIS conversation: a
    // client opening it seeds its composer from them, rather than from whatever that browser last picked in some
    // other tab. Absent for an agent whose turns predate the record (model has always been kept; the rest are
    // newer). `fast` is what was REQUESTED, not what was served — the served answer belongs to a turn and rides
    // its `fast_mode` frame, while this is the composer's memory of the user's own choice.
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    account: z.string().optional(),
    // The worktree branch (agent/<id>); absent for a non-isolated (main-tree) conversation.
    branch: z.string().optional(),
    // This agent's own answer to "land automatically at turn completion?" — an explicit per-agent override of
    // the sandbox-wide `autoLand` setting. ABSENT ⇒ inherit, which is the common case and the one that keeps
    // the global toggle meaningful: an agent that never expressed an opinion follows the sandbox wherever it
    // is pointed next. Written by `agents.autoLand`; the UI shows the EFFECTIVE value (this ?? the setting).
    autoLand: z.boolean().optional(),
    // Present when the conversation was opened by an outside message rather than by the user (see
    // AgentOriginSchema) — the card's provenance line. Absent ⇒ the user started it.
    origin: AgentOriginSchema.optional(),
    // The ROOT repo's short base sha — the checkout moment's display identity. Per-repo bases stay
    // daemon-internal (agents.diff already reports against them).
    base: z.string().optional(),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    activity: AgentActivitySchema.optional(),
    // Present while a turn runs: its start, ms since epoch.
    startedAt: z.number().optional(),
    updatedAt: z.number(),
    // When the agent was last OPENED, ms since epoch — the unread badge's reference point (`updatedAt >
    // seenAt` ⇒ the agent has done something you haven't looked at). Absent ⇒ never opened. Daemon-side on
    // purpose: read state is a fact about the WORK, not about one browser profile, so clearing site data or
    // picking up the phone must not resurrect every badge.
    seenAt: z.number().optional(),
    attention: AgentAttentionSchema,
    // Completed turns and lifetime tool calls — the card's msgs/tools counters.
    turns: z.number().optional(),
    toolUses: z.number().optional(),
    /* The agents THIS agent started (SubagentSessionSchema), live and lifetime. Absent ⇒ it has never delegated,
     * which is most agents — so the card's chip appears on content rather than reading "0" down the board.
     *
     * It earns a place on a card because a fleet card is the answer to "what is this agent up to", and an agent
     * running five children looked exactly like an agent running none: the work was real, the spend was real, and
     * the board said nothing. The tokens are NOT folded into the parent's cost — a child's spend is its own, and
     * the Subagents area is where it is attributed. */
    subagents: z.object({ running: z.number(), total: z.number() }).optional(),
    // The agent's cumulative output (base → branch tip across every repo), refreshed on each land —
    // the card's "12 files · +412 −96" readout. Independent of what has landed.
    diff: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }).optional(),
    /* The loop driving this conversation, when one is (or was) — "iteration 3/12, until the suite is green".
     *
     * PROJECTED onto the card rather than fetched beside it, and that is the whole reason a loop needed no
     * surface of its own: a looping agent is an agent, so the board's status, spend, unread badge and Stop
     * button already describe it, and one extra line is the difference between a card that says `running` for
     * forty minutes and one that says what it is running towards. A second query joined client-side would have
     * paid for the same line with a poll that can disagree with the roster.
     *
     * Absent ⇒ an ordinary conversation, which is nearly all of them. */
    loop: z
        .object({ state: LoopStateSchema, iteration: z.number().int().min(0), maxIterations: z.number().int().min(1), goal: z.string() })
        .optional(),
    /* The workflow run this conversation is a step of — "Ship the feature · step 3 of 4 · Review the change".
     *
     * Projected for the same reason the loop above is, and it answers a question only the board can be asked. A
     * run of four `fresh` steps IS four conversations, so it arrives on the board as four unrelated cards that
     * started a few minutes apart — the work reads as four people who happen to be busy rather than as one job
     * with a shape. Naming the run on each card is what makes them one block, and `runId` is what lets the board
     * order them together and link every one of them at the run's own graph.
     *
     * POSITION IS A FACT ABOUT THE STEP, not a running total: `index`/`total` are its place in the workflow's own
     * step order, so a card is published once when its step starts and never has to be rewritten because a
     * sibling advanced. How the run as a whole is going is the run page's job, and how THIS step is going is
     * already the card's status and the loop line above.
     *
     * `step` moves within one conversation when steps are chained with `continue` — they share it, which is the
     * point of chaining — so this says which one is on it NOW.
     *
     * Absent ⇒ an ordinary conversation. */
    workflow: z
        .object({
            runId: z.string(),
            name: z.string(),
            step: z.string(),
            index: z.number().int().min(1),
            total: z.number().int().min(1),
        })
        .optional(),
    // When the agent was ARCHIVED (ms epoch) — off the board, but nothing lost: its checkout was retired
    // (worktree removed) while the agent/<id> branch, the transcript, and every counter stayed. Absent ⇒ live
    // on the board. Archived agents are excluded from the roster the fleet renders; `agents.archived` lists
    // them, `agents.unarchive` brings one back, and the next turn re-attaches its worktree from the branch.
    archivedAt: z.number().optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
// `rev` is the registry revision this roster was read at — a counter the daemon bumps on every registry change.
// It is what makes the browser's optimistic writes safe: the fleet is published as full snapshots (last frame
// wins), so without an ordering stamp a roster READ before a mutation but delivered after it silently puts the
// mutated agents back. The browser drops any roster older than the newest it has applied, and holds its own
// pending change until a roster at or past the revision that applied it arrives. See useAgents.ts.
export const AgentsListSchema = z.object({ agents: z.array(AgentSummarySchema), rev: z.number() });
export type AgentsList = z.infer<typeof AgentsListSchema>;
export const AgentIdSchema = z.object({ id: z.string().min(1) });
// archive's input: the agents to take off the board. Absent `ids` ⇒ every finished agent that is archivable
// right now (the lane header's "Clear"); unarchive always names its ids (a restore, or a bulk archive's undo).
export const AgentArchiveSchema = z.object({ ids: z.array(z.string().min(1)).max(500).optional() });
export const AgentIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
// What actually MOVED, and deliberately NOT the roster afterwards. Two archives in flight at once each finish
// holding a full-roster snapshot from a different instant, so a client that swapped one in wholesale would let
// the slower response resurrect what the faster one just filed away — a delta composes where a snapshot races.
// Whole summaries rather than ids because the receiving side has to SHOW them (the archive list, and the agent
// detail page addressed by id); the ids "Undo" needs come off them for free.
// The agents an archive/unarchive actually moved, plus the registry revision that applied the move — the
// browser holds its optimistic add/remove of exactly these ids until it sees a roster at or past `rev`.
export const AgentsMovedSchema = z.object({ moved: z.array(AgentSummarySchema), rev: z.number() });
export type AgentsMoved = z.infer<typeof AgentsMovedSchema>;
// What a purge actually deleted. Ids, not summaries: these agents no longer exist anywhere — there is nothing
// left to show and nothing to put back, so the only thing the caller can do with the answer is drop those rows
// and count them. No revision either: archived agents are already off the broadcast roster (see `list`), so a
// purge changes nothing the board's pending-move machinery has to hold a card against.
export const AgentsRemovedSchema = z.object({ removed: z.array(z.string()) });
export type AgentsRemoved = z.infer<typeof AgentsRemovedSchema>;
/* Search the fleet by what the USER wrote — the board's filter (and the popped-out rail's).
 *
 * Deliberately the user's own prompts and nothing else. An agent's replies and its tool output mention
 * nearly every identifier in the workspace, so a transcript-wide match on a fleet this size returns most of
 * the board and the filter stops filtering; the words the user typed are both what they remember and what
 * tells two agents apart. The card TITLE is the first of those prompts (sanitized), so a title match and a
 * prompt match are one rule, not two.
 *
 * Two chars minimum: below that every agent matches and the scan is pure cost.
 */
export const AgentSearchQuerySchema = z.object({ query: z.string().trim().min(2) });
// One matching agent, and the evidence for it. `snippet` is the matched prompt windowed around the hit —
// absent when the match is the title, which the card already shows. A card that matches for a reason the user
// cannot see is worse than no filter at all.
export const AgentMatchSchema = z.object({ id: z.string(), snippet: z.string().optional() });
export type AgentMatch = z.infer<typeof AgentMatchSchema>;
// `scanned` is how many agents the daemon actually read prompts for, so the board can say when a query saw
// less than the whole fleet rather than implying it saw all of it.
export const AgentSearchResultSchema = z.object({ matches: z.array(AgentMatchSchema), scanned: z.number() });
export type AgentSearchResult = z.infer<typeof AgentSearchResultSchema>;
// rename's input: the user-chosen display title (bounded like sanitizeTitle's cap).
export const AgentRenameSchema = z.object({ id: z.string().min(1), title: z.string().trim().min(1).max(80) });
// autoLand's input: this agent's own land-at-completion posture. `null` CLEARS the override back to "inherit
// the sandbox setting" — the browser sends it whenever the user toggles back to what the global already says,
// so agents don't accumulate frozen overrides that quietly stop following the global toggle.
export const AgentAutoLandSchema = z.object({ id: z.string().min(1), autoLand: z.boolean().nullable() });
export const AgentFileDiffQuerySchema = z.object({ id: z.string().min(1), repo: z.string().min(1), path: z.string().min(1) });
/* WHY a path would not land. The distinction is the whole difference between an actionable report and a dead
 * end, because the three have nothing in common but their symptom:
 *   `workspace` — you have uncommitted edits on that path. Yours is the copy at risk; commit or stash it.
 *   `diverged`  — the main tree's COMMITTED content moved under the agent since it branched. Nothing of
 *                 yours is at risk; the agent's delta is simply written against an older file.
 *   `binary`    — git cannot three-way merge the file at all, so no automatic resolution exists.
 * The old report named only the first, which is the rarest of the three. */
export const LandConflictReasonSchema = z.enum(["workspace", "diverged", "binary"]);
export type LandConflictReason = z.infer<typeof LandConflictReasonSchema>;
export const LandConflictPathSchema = z.object({ path: z.string(), reason: LandConflictReasonSchema });

/* land's outcome, per repo of the composition. `paths` is the set that genuinely failed to apply — NOT the
 * whole delta, which is what the first version reported whenever it could not pin the cause down, turning
 * four real conflicts into a wall of fourteen. `clean` counts what would land regardless, so the UI can say
 * how much is being held back by how little, and offer to take it. An empty `paths` with `clean: 0` is the
 * repo-unavailable case: the main checkout is gone, and no path-level account exists. */
export const LandConflictSchema = z.object({
    repo: z.string(),
    paths: z.array(LandConflictPathSchema),
    clean: z.number(),
    // The branch the user's checkout is on — the thing the agent has to rebase onto. Carried because only the
    // daemon can see it: an isolated turn's worktree is mounted over the agent's whole view, so the resolution
    // errand could otherwise only tell it to go and read the name off `git worktree list`. Absent on a detached
    // HEAD or a vanished checkout, where there is no name to give.
    mainBranch: z.string().optional(),
});
export type LandConflict = z.infer<typeof LandConflictSchema>;

// land's outcome; landed only when every repo with changes applied cleanly. Conflicted repos keep their
// worktree state — nothing is lost, and "Land now" stays available. `resolving` is populated only by a
// `merge` land: the paths written into the workspace carrying conflict markers, which the user finishes by
// hand in their own editor exactly as they would any merge.
export const LandResultSchema = z.object({
    landed: z.boolean(),
    conflicts: z.array(LandConflictSchema).optional(),
    resolving: z.array(z.object({ repo: z.string(), paths: z.array(z.string()) })).optional(),
    // A `measure` outcome with an outstanding delta: nothing was applied and nothing failed — the work is
    // waiting on the branch for a deliberate Land. `landed: false` alone can't say that (it means refusal).
    held: z.boolean().optional(),
});
export type LandResult = z.infer<typeof LandResultSchema>;

/* land's input. `check` is the safe default and the historical behaviour: the delta is applied only if ALL of
 * it applies, so a refusal leaves the workspace byte-identical. `merge` is the escape hatch the conflict
 * report offers — a three-way apply that lands every clean path and leaves the rest with conflict markers to
 * resolve in place. It is opt-in because it WRITES on failure, which is the one thing `check` promises not
 * to do. `measure` is the auto-land-off mode: everything a land does EXCEPT touching the main tree — the
 * provenance commit onto agent/<id>, the cumulative diffstat, and the bookkeeping for work that reached the
 * main line by another road — so a held agent's card stays as current as a landed one's while its delta waits
 * on the branch for a deliberate Land. */
export const LandModeSchema = z.enum(["check", "merge", "measure"]);
export type LandMode = z.infer<typeof LandModeSchema>;
export const AgentLandSchema = z.object({ id: z.string().min(1), mode: LandModeSchema.optional() });

// ---- routed-provider subscriptions ----

// The providers whose model can run UNDER the Claude Code harness through the bundled translator (CLIProxyAPI),
// which holds their SUBSCRIPTION OAuth and re-serves it behind an Anthropic endpoint. The `claude` provider is
// absent — native Anthropic OAuth serves it directly, without the translator. Codex and Grok also have a native
// runtime and so carry the harness axis; Kimi and Gemini are routed-only, so their turns always use Claude Code.
export const KeyedProviderSchema = z.enum(["codex", "grok", "kimi", "gemini"]);
export type KeyedProvider = z.infer<typeof KeyedProviderSchema>;

// ---- plan-limit usage ----
// Declared ABOVE both account shapes because both carry it: headroom is one idea in this product, not a Claude
// idea that other providers imitate. A native account (OauthAccount) and a routed subscription
// (TranslatorAccount) differ in who holds the credential and how the reading is taken — never in what a
// reading IS — so every surface that draws a percentage reads this one type and no other.

// One plan-limit pool. `kind` is the provider's own key ('five_hour' | 'seven_day' | 'seven_day_opus' |
// 'seven_day_sonnet' | 'model:Fable' | …) rather than an enum we'd have to keep in step with the provider: an
// unrecognised pool is shown under its raw key, which is far better than being silently folded into a
// neighbour. `label` is the provider's OWN display name where it supplies one (the per-model buckets do) — it
// wins over anything we'd infer, because the model names in a plan's limits are the provider's to rename.
// `resetsAt` is epoch SECONDS (matching the SDK's frame).
export const UsageWindowSchema = z.object({
    kind: z.string(),
    label: z.string().optional(),
    utilization: z.number(), // 0-100
    resetsAt: z.number().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

// An account's headroom: EVERY window the provider reports, read together, plus when the reading was taken.
// All of them, not the binding one, because "which pool is binding" changes between turns and a reader
// comparing accounts needs the same pools on every row. How the reading is TAKEN is per provider and stops at
// the daemon's readers: Claude's rides the turn's own stream, ChatGPT's, Google's and Kimi's are pulled through
// CLIProxyAPI's credential-scoped management call. All of them are control requests, so none costs tokens.
//
// Within one window utilization only climbs, so an un-reset window stays a valid FLOOR however old it is; past
// its `resetsAt` it describes a pool that no longer exists and the store drops it. `measuredAt` is epoch MS
// (matching connectedAt) — deliberately a different unit from the windows' seconds.
export const AccountUsageSchema = z.object({
    windows: z.array(UsageWindowSchema),
    measuredAt: z.number(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/* THE LAST TIME A PROVIDER ACTUALLY REFUSED A TURN — the other half of "can I run on this", and the half no
 * meter can supply.
 *
 * A snapshot above is POLLED and therefore always a floor: read at turn end (Claude) or on a five-minute sweep
 * (the routed subscriptions), and account-wide, so every other client on the plan spends the same pools without
 * this sandbox hearing about it. A refusal is the opposite kind of fact — observed, exact, and timestamped by
 * the only event that proves the plan said no. Between them they answer a question neither can alone: a green
 * meter beside "refused a turn 4 minutes ago" means the reading is stale, not that the account has room.
 *
 * Keyed by PROVIDER rather than by account, because that is the resolution the daemon honestly has. A native
 * Claude turn knows which account served it and names it; a routed turn does not — CLIProxyAPI picks the auth
 * file itself and only refuses once every credential it holds is cooling down, which makes the refusal a fact
 * about the provider in the first place.
 *
 * `kind` is read off what the provider SAID, not off the frame code the harness filed it under, because those
 * two disagree: Kimi answers a spent plan with `403 You've reached your usage limit for this billing cycle`,
 * which the CLI prints under "Failed to authenticate" and the stream codes as a refused credential. Sending
 * someone to reconnect a perfectly good account is the cost of believing the code over the sentence. */
export const ProviderRefusalSchema = z.object({
    // Epoch MS, matching AccountUsage.measuredAt — the two are read side by side.
    at: z.number(),
    kind: z.enum(["limit", "auth"]),
    // The provider's own sentence, verbatim. It is the only part that says WHICH pool or WHICH credential.
    message: z.string(),
    // The account that was serving, when the daemon knows it (native turns only — see above).
    account: z.string().optional(),
});
export type ProviderRefusal = z.infer<typeof ProviderRefusalSchema>;

export const ProviderRefusalsSchema = z.object({ refusals: z.record(z.string(), ProviderRefusalSchema) });
export type ProviderRefusals = z.infer<typeof ProviderRefusalsSchema>;

// One connected subscription in the translator. `name` is CLIProxyAPI's auth-file name — the stable store key a
// disconnect addresses — and `label` the sign-in identity it reported (the account email, else the file name).
export const TranslatorAccountSchema = z.object({
    name: z.string(),
    label: z.string(),
    // The same headroom an OauthAccount carries, on the same field, for the same reason: the account rows are
    // one list to the reader. Optional because a provider whose quota this sandbox cannot read (Grok) —
    // or one that did not answer — must still render as the connected account it is, with a dot instead of a
    // ring.
    usage: AccountUsageSchema.optional(),
});
export type TranslatorAccount = z.infer<typeof TranslatorAccountSchema>;
// Which routed-provider subscriptions are connected in the translator, per provider — a LIST per provider, not
// a flag: CLIProxyAPI holds any number of auth files per provider side by side and balances requests across
// them, so connecting a second ChatGPT or Google account is more headroom, and each is disconnectable on its
// own. Drives the account rows in Sandbox ▸ Agent.
export const TranslatorAccountsSchema = z.object({
    codex: z.array(TranslatorAccountSchema),
    grok: z.array(TranslatorAccountSchema),
    kimi: z.array(TranslatorAccountSchema),
    gemini: z.array(TranslatorAccountSchema),
});
export type TranslatorAccounts = z.infer<typeof TranslatorAccountsSchema>;

// The side-channel body that un-parks a turn waiting on the user. Every interactive card — plan approval,
// clarifying questions, a per-tool permission prompt — parks on the SAME registry keyed by `requestId`, so
// one route resolves all three; the `kind` says which card answered and carries its payload.
export const AgentReplySchema = z.discriminatedUnion("kind", [
    // ExitPlanMode approval. `mode` is the posture to execute the approved plan in — auto-accept edits
    // (acceptEdits), approve each one (default), or run everything (bypassPermissions); it rides back to the SDK
    // as a session setMode. Absent, the turn returns to the posture it STARTED in, so an agent that put itself
    // into plan mode does not cost the user the permissions they granted. Rejection feedback loops back into the
    // model as the denial reason.
    z.object({
        kind: z.literal("plan"),
        requestId: z.string().min(1),
        approve: z.boolean(),
        mode: PermissionModeSchema.optional(),
        feedback: z.string().optional(),
    }),
    // AskUserQuestion picks: question text → chosen option label(s) (+ any free-text "Other"). `cancelled`
    // is the dismissal, which tells the model to proceed on sensible defaults rather than leaving it parked.
    z.object({
        kind: z.literal("question"),
        requestId: z.string().min(1),
        answers: z.record(z.string(), z.array(z.string())).optional(),
        cancelled: z.boolean().optional(),
    }),
    // A per-tool permission prompt. 'once' allows this call only; 'always' allows the whole TOOL for the rest
    // of the session (plus the SDK's own narrower suggestions), which is what the card's label promises;
    // 'deny' blocks it and feeds `feedback` back as the reason.
    z.object({
        kind: z.literal("permission"),
        requestId: z.string().min(1),
        decision: z.enum(["once", "always", "deny"]),
        feedback: z.string().optional(),
    }),
]);
export type AgentReply = z.infer<typeof AgentReplySchema>;
// Steering: a user message delivered INTO the running turn (injected between tool calls, Claude Code style),
// keyed by the conversation whose turn is in flight. NOT_FOUND when no steerable turn is running — the client
// then holds the message in its queue and sends it as the next turn instead. Carries everything a turn's own
// prompt can carry (files, the editor-context chip), because "add more while it works" is worth nothing if it
// only takes bare text: the daemon folds the same notes into the injected message that a fresh turn gets.
export const SteerSchema = z
    .object({
        conversationId: z.string().min(1),
        text: z.string().max(20_000),
        attachments: z.array(z.string().min(1)).max(20).optional(),
        editorContext: EditorContextSchema.optional(),
    })
    // An attachment-only steer (a screenshot dropped in mid-turn) is legal; an entirely empty one is not.
    .refine((steer) => steer.text.trim().length > 0 || (steer.attachments?.length ?? 0) > 0, {
        message: "text or attachments required",
    });
// True cancel for the conversation's in-flight turn — aborts the agent daemon-side, unlike closing the
// /agent fetch (which sends no cancel frame).
export const StopTurnSchema = z.object({ conversationId: z.string().min(1) });

// ---- claude rate-limit gate ----
// The GATE signal: whether the provider is letting turns through right now, and — when it is refusing — which
// window is binding and when it lifts. This is the SDK's rate_limit_event, mapped one-to-one, and it is only
// ever about the CURRENT moment. It is deliberately NOT the thing the headroom displays read: the event names a
// single window (whichever the CLI considered binding), which is how "weekly 1%" ended up standing in for an
// account that was really at 98% on another weekly pool.
export const RateLimitInfoSchema = z.object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    resetsAt: z.number().optional(), // epoch seconds
    rateLimitType: z.string().optional(), // 'five_hour' | 'seven_day' | 'seven_day_opus' | ...
    utilization: z.number().optional(), // 0-100, how much of the window is used
});
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

// ---- fast mode ----
// What speed a turn is actually being served at. `cooldown` is its own state rather than a flavour of `off`
// because it is the only one that lifts by itself: fast mode draws on a rate-limit pool separate from the
// model's, and a turn that exhausts it drops to standard speed and stays there until the pool reopens. The
// distinction is what lets the client say "not right now" instead of "not available", which are different
// answers to "why am I not getting what I asked for". Mirrors the harness's own vocabulary (SDK: FastModeState).
export const FastModeStateSchema = z.enum(["off", "cooldown", "on"]);
export type FastModeState = z.infer<typeof FastModeStateSchema>;

// ---- provider oauth ----
// Claude uses the PKCE authorize-URL + paste-back handshake (start → exchange). Codex uses OpenAI's device-code
// flow (start → poll): the browser signs in at verificationUri and enters userCode; the daemon polls until done.
// A sandbox can hold several accounts per provider side by side: `id` is the daemon-minted store key, `label`
// the user's display name (auto-filled from the sign-in identity where the token carries one). Tokens never
// ride this shape — connection status is existence in the list.

export const OauthAccountSchema = z.object({
    id: z.string(),
    label: z.string(),
    // WHO this account signs in as, in the provider's own words — Anthropic returns the email and the
    // organization alongside the tokens, so a connection can name itself instead of arriving as a second row
    // called "Claude". Kept BESIDE `label` rather than folded into it: the label is the user's to rename, and a
    // renamed account still has to be able to say whose it is. Absent when the provider tells us nothing (a
    // pasted API key carries no identity) — which is exactly when renaming is the only answer, so every
    // sandbox-owned account can be renamed.
    email: z.string().optional(),
    organization: z.string().optional(),
    scope: z.string().optional(),
    connectedAt: z.number(), // epoch ms
    // Set only when the account's stored credential can no longer be refreshed (revoked/expired refresh token)
    // — the user must reconnect. Absent ⇒ healthy or not-yet-probed; `detail` carries the reason for the UI.
    // Provider-agnostic; only Codex probes it today (Claude refreshes on-demand, Grok's tokens are OpenCode's).
    needsReauth: z.boolean().optional(),
    detail: z.string().optional(),
    // The account's last known subscription-usage snapshot, so the picker can show what's left on each account
    // before the user commits a turn to one. Absent until a reading exists for it — an unmeasured account reads
    // as unknown, never 0%. Claude is the provider that fills it here, because its stream reports the windows;
    // the routed subscriptions carry the identical field on TranslatorAccount, filled by a pulled reading.
    usage: AccountUsageSchema.optional(),
});
export type OauthAccount = z.infer<typeof OauthAccountSchema>;
export const OauthAccountListSchema = z.object({ accounts: z.array(OauthAccountSchema) });
export type OauthAccountList = z.infer<typeof OauthAccountListSchema>;
// Address one account of a provider (disconnect, and the turn's `account`).
export const AccountIdSchema = z.object({ id: z.string().min(1) });
// Rename one account of a provider whose credential the sandbox owns (Claude, Kimi). Blank ⇒ the daemon falls
// back to the derived name, so clearing a label restores the sign-in identity rather than leaving a nameless
// row. Grok is absent for the same reason it holds one account: OpenCode owns that credential, not this store.
export const AccountRenameSchema = z.object({ id: z.string().min(1), label: z.string().max(80) });
// The completing calls carry the user-chosen label (blank ⇒ the daemon derives one from the sign-in identity
// or a provider default).
export const OauthExchangeSchema = z.object({
    code: z.string().min(1),
    verifier: z.string().min(1),
    state: z.string().min(1),
    label: z.string().optional(),
});
export const AuthorizeChallengeSchema = z.object({ authorizeUrl: z.string(), verifier: z.string(), state: z.string() });
// xAI Grok (via OpenCode) uses subscription OAuth via the headless device-code method. `start` returns the
// `url` the user opens (xAI's verification_uri_complete, which pre-fills the code) and `code` — the same
// one-time code, surfaced so the card matches x.ai exactly. There is no paste-back: OpenCode polls to
// completion and the UI polls `/grok/accounts`.
// ponytail: OpenCode holds one xAI auth per data dir, so Grok stays single-account — the list is 0 or 1. Per
// account would need an OpenCode server per data dir; add when there's demand.
// A device-code login start: the verification URL + the one-time code the user enters there. The native Grok
// flow (via OpenCode) — see TranslatorStartSchema for the routed-provider connect, which adds `state`.
export const DeviceStartSchema = z.object({ url: z.string(), code: z.string() });
// A routed-provider subscription login start (codex/grok/kimi/gemini via CLIProxyAPI). Device flows poll to
// completion after the user approves upstream; redirect flows need the browser's landing URL pasted back. The
// explicit flow discriminator matters even when a provider's verification URL already embeds its optional code.
export const TranslatorStartSchema = z.object({
    url: z.string(),
    code: z.string(),
    state: z.string(),
    flow: z.enum(["device", "redirect"]),
});
// The paste-back half of a redirect login: the URL the provider sent the browser to, carrying the grant as
// ?code=&state=. `state` ties it to the handshake that issued it — the translator rejects a mismatch.
export const TranslatorCompleteSchema = z.object({
    provider: KeyedProviderSchema,
    redirectUrl: z.string().min(1),
    state: z.string().min(1),
});
// A provider's model catalog, resolved daemon-side from live discovery with a persisted last-known-good list and
// a seed floor (Grok via opencode.ts xaiModels, Codex via codex-models.ts, Claude via the Agent SDK's
// supportedModels) — never empty, so the picker is never blank. `label` is the provider's display name; `default`
// is the model a fresh chat on that provider seeds (always present). Shared by /grok/models, /codex/models,
// /claude/models. `efforts` is the reasoning-effort tiers the model accepts (Claude reports them per model);
// empty ⇒ the client's default tiers.
//
// EVERY field here is provider-reported — nothing about a model is curated in this repo, so a new release or a
// renamed family flows to the UI with no code change. Providers differ in how much they publish: the Claude
// Agent SDK reports a display name, a capability description, effort tiers, and capability flags, while the
// Some OpenAI-compatible /v1/models endpoints report ids only — those rows render label-only, and that absence
// is the honest answer rather than something to paper over with a hand-written table.
//
// ORDER IS MEANINGFUL: `models` arrives in the provider's own preference order, which is what the picker sorts
// by, and `default` is the provider's own default. Neither is re-ranked locally.
export const ModelBadgeSchema = z.enum(["reasoning", "fast"]);
export type ModelBadge = z.infer<typeof ModelBadgeSchema>;
export const ModelSchema = z.object({
    id: z.string(),
    label: z.string(),
    efforts: z.array(z.string()).optional(),
    description: z.string().optional(),
    badges: z.array(ModelBadgeSchema).optional(),
});
export type Model = z.infer<typeof ModelSchema>;
export const ModelsSchema = z.object({ models: z.array(ModelSchema), default: z.string() });

// ---- sessions ----

export const SessionIdParamSchema = z.object({ id: z.string() });
export const SessionSummarySchema = z.object({
    id: z.string(),
    title: z.string(),
    updatedAt: z.number(),
    // Why a searched session matched: the line of the USER's own prompt the query hit, windowed around it.
    // Absent on an unfiltered list, and on a match the title already shows — a snippet repeating the row's
    // own heading is noise, not evidence. See AgentMatchSchema for the same field on the fleet's side.
    snippet: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionsListSchema = z.object({ sessions: z.array(SessionSummarySchema) });

// ---- settings: per-sandbox agent settings (.intentic/settings.json) ----

// Which prompt the agent is, before this turn composes anything on top. Two built-in bases and an escape
// hatch: Intentic's own (the default), Claude Code's preset, or the owner's text. Declared out here rather
// than inline in the settings object because both sides of the wire branch on it — the daemon to build the
// turn, the browser to decide which base it can show you.
export const SystemPromptModeSchema = z.enum(["intentic", "claude", "custom"]);
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>;
// The two bases a user can READ and fork — "custom" is excluded because there is nothing to fetch: it is
// whatever they have already typed into the settings field.
export const BuiltinPromptSchema = z.object({ base: z.enum(["intentic", "claude"]) });

// Small user-owned config the /settings routes edit and streamAgent reads — all opt-in booleans the owner
// toggles in the UI (so each can be A/B benchmarked):
//   stableSystemPrompt — keeps the system prompt byte-stable across turns (the delegation note rides the user
//                        message instead of the preset `append`) so the provider prompt cache survives.
//   skills            — names of baked-tool skills to load into .claude/skills so the agent reaches for them
//                        (e.g. "lsp" — TS rename + diagnostics over the language service); a name absent ⇒ its
//                        skill file isn't written, so the agent doesn't reach for it. Data-driven: a new baked
//                        tool is one daemon-side registry entry, not a new settings field.
//   hashlineEdits     — swaps the native Read/Edit/Write for hash-anchored edits on the Claude path (stale-file
//                        guard + fewer output tokens); off ⇒ the native file tools.
//   terseOutput       — appends a concise-response steer to the end of the system prompt (a stable suffix, so it
//                        composes with stableSystemPrompt) to cut the model's OWN output tokens.
//   systemPromptMode  — which base the agent's prompt is: "intentic" (default), "claude", or "custom".
//   systemPrompt      — the owner's own prompt text, used only by "custom" mode, where it is the ENTIRE system
//                        prompt and nothing the daemon would otherwise append rides with it — see its own note.
//   iqSearch          — loads the image-baked iq Claude Code plugin (skill + SessionStart nudge) so the agent
//                        prefers the iq CLI over grep/find/Glob; off ⇒ plugin not loaded, native search tools
//                        only. Opt-in (default off); the browser Search box uses iq regardless.
//   iqContext         — retrieves for the user's message BEFORE the turn starts and prepends the ranked answer
//                        to it, so the model opens with the anchors instead of paying a search round-trip to
//                        find them. Independent of iqSearch: that one teaches the agent to search, this one
//                        answers ahead of it.
//   iqContextHoldout  — measurement control for iqContext, same shape as terseHoldout (UsageTurn.iqContext).
//   outputCleaners    — the Bash output-cleaner spec (agent-output-filter): "off" = filter disabled (default),
//                        "" = all cleaners on, else an iq-style allow-list / default-minus
//                        spec ("git,pnpm" = only those; "-cap" = all except). Threaded to the filter via env.
//   outputHoldout     — measurement control: a fraction [0,1] of Bash commands whose output bypasses cleaning
//                        (recorded raw as `heldOut`), so the savings report compares a real cleaned-vs-raw
//                        population instead of an estimate. 0 = no holdout (default).
//   verifyOnStop      — a turn that edited code and ran no passing check gets ONE follow-up asking for proof,
//                        naming the scripts this workspace defines; off ⇒ the turn ends when the model says so.
//   automationFailureLimit — consecutive `error` runs after which an automation is disabled rather than left
//                        firing forever; 0 (default) ⇒ never.
// The booleans default off, skills defaults [] (no skill loaded), outputCleaners defaults "off" (cleaning off)
// and outputHoldout 0 — a fresh sandbox starts with cleaning and iq off until the owner enables them.
//
// Every field carries that default IN THE SCHEMA, so a settings object written before a field existed still
// parses — the absent key reads as its default. That is not a compatibility layer, it is the seam this shape
// spans: the browser ships with the platform while the daemon ships inside the user's sandbox image, so a web
// build is routinely NEWER than the daemon answering it. Requiring the key instead makes the whole settings
// surface fail to parse the moment a toggle is added — which reaches the user as a page of switches that are
// silently dead, not as an error. It also means an older on-disk manifest keeps the owner's other picks rather
// than being discarded whole.

export const SandboxSettingsSchema = z.object({
    stableSystemPrompt: z.boolean().default(false),
    skills: z.array(z.string()).default([]),
    hashlineEdits: z.boolean().default(false),
    terseOutput: z.boolean().default(false),
    /* Measurement control for the terse steer, at TURN level — the same trick `outputHoldout` plays over
     * commands, one layer up. A fraction [0,1] of otherwise-eligible turns run WITHOUT the steer and record
     * which arm they ran on (UsageTurn.terse), so the savings report can compare two real populations.
     *
     * It has to be an experiment: unlike a cleaned command, which yields its own raw baseline in the same
     * event, a turn cannot be re-run to see what it would have said unsteered. 0 ⇒ no measurement (every
     * eligible turn is steered), which is the default because the control costs the very tokens it measures. */
    terseHoldout: z.number().min(0).max(1).default(0),
    /* WHICH SYSTEM PROMPT THE AGENT RUNS ON — the base, before anything this turn composes.
     *
     *   intentic — Intentic's own prompt, tuned for this harness (intentic-prompt.ts). The default.
     *   claude   — Claude Code's preset, as shipped in the CLI this sandbox runs. Not a copy stored here, so
     *              picking it tracks whatever the installed CLI's prompt is rather than freezing at a snapshot.
     *   custom   — `systemPrompt` below, and nothing else at all.
     *
     * The first two are peers: both get the harness's own guidance appended (the AskUserQuestion/plan blocks
     * the chat's cards need, the checklist guidance behind the todo panel, the browser-tool guidance), plus the
     * delegation note and the terse steer. `custom` is the one that does not, by the owner's explicit choice —
     * see the field below. */
    systemPromptMode: SystemPromptModeSchema.default("intentic"),
    /* The owner's own prompt, used only when `systemPromptMode` is "custom". Then it is the ENTIRE system
     * prompt: both built-in bases are gone and so is everything the daemon would otherwise append — the widget
     * guidance the chat's cards are driven by, and the terse-output steer (whose toggle goes inert). That is
     * the price of total control, and the UI states it at the moment of the edit rather than letting the
     * widgets go quietly dark. Only the cross-provider delegation note survives, because it has a home outside
     * the system prompt already (the user-message preamble stableSystemPrompt puts it in).
     *
     * Cap is roomy — the bases it stands in for are ~6.8k characters — but finite, because every turn pays it. */
    systemPrompt: z.string().max(20000).default(""),
    iqSearch: z.boolean().default(false),
    /* RETRIEVE BEFORE THE TURN, don't wait to be asked. The daemon runs the user's message through the resident
     * iq engine and prepends the ranked answer to it, so a turn that would have opened with two or three search
     * calls opens with the anchors already in hand. Independent of `iqSearch`, which only teaches the agent to
     * reach for the CLI once it decides to search — this one answers ahead of that decision, and the two
     * compose: the injected capsule names the anchors, the CLI is there for what it missed.
     *
     * It rides the USER message (turn-context.ts), never the system prompt, for the same reason the setup
     * notice does: it changes every turn, and the system prefix is kept byte-stable for the prompt cache.
     * Off by default — it spends input tokens on every eligible turn, and whether that trade pays is exactly
     * what the holdout below is for. */
    iqContext: z.boolean().default(false),
    // Measurement control for the pre-injection, identical in shape to `terseHoldout`: a fraction [0,1] of
    // otherwise-eligible turns run WITHOUT the retrieved context and stamp their arm onto the ledger
    // (UsageTurn.iqContext), so the report compares two real populations of turns instead of asserting a saving.
    iqContextHoldout: z.number().min(0).max(1).default(0),
    outputCleaners: z.string().default("off"),
    outputHoldout: z.number().min(0).max(1).default(0),
    /* The model behind the one-click helpers that are not a conversation — today the commit box's autofill.
     * `${provider}:${modelId}`, or EMPTY for Auto, which is the default and the interesting case: Auto is
     * resolved from whatever accounts are connected at the moment it is read (resolveQuickModel), so it can
     * never name a provider this sandbox has no credential for and it improves by itself when one is added.
     * Storing a resolved id here instead would go stale exactly like a pinned model does. */
    quickModel: z.string().default(""),
    /* WHAT AN AGENT RUN OPENS ON — the tier above quickModel, and the answer for every turn a SURFACE starts
     * rather than a person at a composer: Fix with agent on a pipeline or a deployment, a Maintenance chore, a
     * Documentation or Acceptance run, the fix a failed pre-push check proposes. `${provider}:${model}`
     * (quickModelKey) plus the reasoning effort beside it; both empty ⇒ whatever the chat composer would have
     * started with, which is the honest floor because it is the model the user already chose to work with.
     *
     * PINNED, NOT DERIVED — the deliberate opposite of quickModel one line above, and the reason these are two
     * settings rather than one. A quick helper exists to stay OFF the frontier tier, so cheapest-connected is
     * the right automatic answer. An agent run has to read a failing suite, or a container log, or a story, and
     * repair the thing: the tier is a judgement about how much the job is worth, nothing here can make it, and
     * a wrong guess is billed in whole sessions rather than in tokens.
     *
     * The daemon applies this to any turn flagged `unattended` that names no model of its own — one rule, so a
     * surface added tomorrow inherits it by saying what it is instead of re-deriving where models come from. */
    agentRunModel: z.string().default(""),
    agentRunEffort: z.string().default(""),
    // How long a finished agent stays on the board before it is archived automatically (days; 0 ⇒ never).
    // Unlike every other flag here this one defaults ON, because the lane it governs is the board's only
    // terminal state: without a sweep the Finished lane grows for the life of the sandbox, and each card it
    // holds is a live worktree checkout, not just a row.
    agentRetentionDays: z.number().min(0).max(365).default(3),
    /* Land a clean turn's delta into the main tree automatically at completion — the Claude Code review model,
     * and the historical behaviour, so it defaults ON (flipping the default would silently change every
     * existing sandbox). OFF holds finished work on the agent's branch instead: the card reads "Ready to
     * land" and the user lands it deliberately, from the review panel or the card. Sandbox-wide because
     * automation-opened agents (Discord, webhooks, email) finish turns with no browser in the room — a
     * browser-held preference could not govern them. Per-agent override: AgentSummarySchema.autoLand. */
    autoLand: z.boolean().default(true),
    /* When a turn dies because the MODEL PROVIDER was failing (500/502/503, a 529 at capacity, a dropped
     * socket), re-run it on an escalating backoff until it goes through or the attempts are spent.
     *
     * Defaults ON, and a spent Claude allowance is the counter-example that explains why: that one is the
     * user's own budget, and resuming into a freshly reset window spends something they may have been saving —
     * so a usage limit stops the turn and says when it resets, and nothing re-runs it. An
     * outage resume spends nothing the dead turn had not already committed, resolves in minutes rather than
     * hours, and — the deciding argument — the turns hurt worst by it are the ones with nobody in the room
     * (automation wakes, Discord, webhooks), which no browser-held preference could ever rescue. It is the same
     * reasoning that leaves the auth resume ungated: this is the provider's failure, not the user's decision. */
    resumeAfterOutage: z.boolean().default(true),
    /* When the daemon dies under a running turn, re-run that turn once it is back (agent/turn-journal.ts records
     * every in-flight turn; the boot pass in agent/turn-resume.ts re-runs what survived). ON by default, where
     * a spent usage limit re-runs nothing, and the difference is who broke the turn: a spent allowance is the
     * user's own budget, while a restart is usually intentic's OWN doing — the container is recreated on every update,
     * every environment approval and every dev-sandbox.sh swap. Approving the Dockerfile change an agent asked
     * for must not cost the run that asked for it, and a user who just clicked Approve is in the room expecting
     * the work to continue, not a second button.
     *
     * OFF still records the interruption: the fleet card reads `interrupted` (see AgentStatusSchema) and an
     * automation's row shows an `interrupted` run — nothing is re-run, but nothing is silently lost either. */
    autoResumeOnRestart: z.boolean().default(true),
    /* THE PRE-PUSH CHECK — the command run when the user pushes, before anything leaves the machine.
     * Empty ⇒ no check at all, which is the default: only the owner knows what verifies this workspace, and a
     * guessed command that fails on a fresh clone would read as the check finding a bug on its first run.
     *
     * Configuring it is the opt-in, which is why there is no separate enable flag to disagree with it. The
     * command runs in the workspace root through `sh -c`, exactly as a terminal would run it. */
    prepushCommand: z.string().max(500).default(""),
    // Ceiling on one run, after which the child's whole process group is killed and the result is `failed` with
    // `timedOut`. Never a pass: a suite that did not finish has said nothing about the tree, and the one thing
    // this check exists to prevent is a green light nobody earned.
    prepushTimeoutMs: z.number().min(60_000).max(3_600_000).default(900_000),
    /* ASK FOR PROOF BEFORE A TURN THAT EDITED CODE ENDS. The daemon keeps a per-turn ledger of which code
     * files were written and which commands the agent ran that constitute a check (test/typecheck/lint/build);
     * when the turn tries to stop with edits that no PASSING check followed, it gets one bounded follow-up
     * naming the scripts this workspace actually defines (agent/agent-verification.ts).
     *
     * Off by default, and the reason is the same one prepushCommand has no enable flag: only the owner knows
     * what verifies their workspace. A repo with known-failing baseline tests, or whose real check is a command
     * no table can guess, would get an ask it cannot satisfy — and the ask costs a whole extra model turn, not
     * a few tokens. So this is the opt-in you turn on once you know the nudge would be right here.
     *
     * It never runs anything itself and never claims more than it saw: a passing targeted run clears it, and
     * the follow-up says in as many words not to report a targeted check as the suite being green. */
    verifyOnStop: z.boolean().default(false),
    /* STOP AN AUTOMATION THAT ONLY EVER FAILS. After this many consecutive `error` runs the scheduler disables
     * it and says so on the row, instead of firing a job that has proven it cannot succeed every minute until
     * someone notices. 0 ⇒ never, which is the default.
     *
     * Off by default because quarantining edits the USER'S OWN configuration, and the failure it reacts to is
     * not always the automation's fault: an hourly poll against an API having a bad afternoon is broken for
     * three fires and fine on the fourth, and a job disabled at 3 a.m. is one nobody re-enables until they
     * notice it stopped. So the mechanism exists for the case it is unambiguously right for — a misconfigured
     * job burning a turn's worth of tokens on every tick — and the owner is the one who decides their
     * automations are the kind that should be stopped rather than retried.
     *
     * Only `error` counts. A `skipped` run is a guard doing its job, and an `interrupted` one means the daemon
     * died mid-fire, which says nothing about the automation — counting either would quarantine healthy jobs. */
    automationFailureLimit: z.number().min(0).max(20).default(0),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;

// One of the two built-in bases, as text: Intentic's own prompt, or Claude Code's preset read out of the CLI
// this sandbox runs (preset-prompt.ts captures it rather than storing a transcription). What the settings page
// shows behind "View" and drops into the editor behind "Edit a copy".
//
// `version` is the CLI build a captured preset came from, so the UI can say WHICH text the user is looking at:
// a custom prompt forked from an older build is a snapshot, and the version is the only honest way to tell.
// Empty for Intentic's prompt, which ships with the app and has no version of its own to report.
export const BuiltinPromptTextSchema = z.object({ text: z.string(), version: z.string() });
export type BuiltinPromptText = z.infer<typeof BuiltinPromptTextSchema>;

/* ---- savings report: what each token-reduction mechanism actually saved ----
 *
 * TWO FAMILIES, deliberately never one list of bars. They are measured differently, and a chart that ranks
 * them side by side claims a confidence and a denominator that only one of them has:
 *
 *   input  — shell output the cleaners trimmed before the model ever saw it. Both sides of the comparison come
 *            off the SAME command (raw in, emitted out), so the counterfactual is observed rather than
 *            estimated: exact, per command, no sample size to argue about.
 *   output — the model's own tokens under the terse steer. There is no second run of the same turn to compare
 *            against, so the only honest number is an experiment: a turn-level holdout, an n per arm, and a
 *            margin. It is absent entirely until both arms are large enough for the delta to mean anything.
 *
 * The two are also in different units of value — a saved tool-output token is saved again on every later
 * request of that conversation, an output token is saved once but costs several times as much — which is the
 * other reason they are separate sections with separate totals rather than one number.
 */

// One mechanism's realized saving, biggest first. `savedTokens` is what THIS stage removed from what reached
// it in pipeline order — sequential attribution, which is why the stages sum exactly to raw − emitted and can
// be drawn as one stacked bar. It is NOT "what turning this cleaner off would cost you": the cap downstream
// would have eaten some of the same lines. `commands` is how many commands the stage ran on. Negative for the
// `footer` stage, which adds the retrieval pointer back — a cost on the same ledger as what it bought.
export const SavingsStageSchema = z.object({ id: z.string(), commands: z.number(), savedTokens: z.number() });

// What the cleaners saved on the way in, aggregated from historyRoot/logs/filter-stats.jsonl — one row per
// agent Bash command, written by agent-output-filter. Every number here is windowed on the ledger's own
// calendar (the UTC day each command ran), so the reader's date range and the figures above it agree.
export const InputSavingsSchema = z.object({
    // When the ledger last recorded a command (epoch ms), so the card can show its age instead of implying
    // freshness it doesn't have. Absent when the ledger has never been written.
    updatedAt: z.number().optional(),
    commands: z.number(),
    rawTokens: z.number(),
    emittedTokens: z.number(),
    savedPct: z.number(),
    // Per-stage attribution, biggest first.
    perCleaner: z.array(SavingsStageSchema),
    // The measured control — commands the holdout left raw — against the cleaned population. A real saved-%
    // for the pipeline as a whole rather than an estimate, and the only whole-pipeline counterfactual there is.
    holdout: z.object({ cleaned: z.number(), heldOut: z.number(), measuredSavedPct: z.number().optional() }),
    /* High-volume commands that matched no cleaner: where the next handler is worth writing. GROUPED by the
     * command text — `commands` is how many times it ran and `tokens` their total — because the question this
     * list is read for is "what is worth a handler", and a handler is worth writing for a command that costs
     * 5k twenty times over, not for the single 60k outlier that happened to sort first. */
    gaps: z.array(z.object({ command: z.string(), commands: z.number(), tokens: z.number() })),
});
export type InputSavings = z.infer<typeof InputSavingsSchema>;

// One arm of a turn-level experiment: the turns that ran with the mechanism, and the turns the holdout ran
// without it. A mean PER TURN, because the arms never hold the same number of turns.
export const SavingsArmSchema = z.object({ turns: z.number(), mean: z.number() });

/* A turn-level A/B — the one shape both of this sandbox's turn experiments report in, because they differ in
 * nothing but which flag flips and what the turns are judged on. Only turns the mechanism was ELIGIBLE for are
 * counted: a turn under a custom system prompt drops the terse steer along with everything else the daemon
 * appends, so it belongs to neither arm.
 *
 * `metric` says what `mean` counts and what `deltaPct` is a delta in. The terse steer is judged on the model's
 * own PROSE, which is the thing it steers and the only part of its output that responds to being asked to be
 * brief (see UsageTurn.proseChars for why the turn's total output tokens cannot answer this). Pre-injection is
 * judged on COST, because it spends input tokens deliberately to buy back search turns — scored on output
 * tokens it would look like a pure expense, and scored on input tokens like a pure loss; the trade only nets
 * out in money. */
export const TurnExperimentSchema = z.object({
    metric: z.enum(["proseChars", "costUsd"]),
    on: SavingsArmSchema,
    off: SavingsArmSchema,
    /* How much of the treatment arm the treatment actually REACHED, when that is knowable and less than all of
     * it — pre-injection's arm is the coin flip (intention-to-treat, deliberately), and a turn can be assigned
     * the retrieval and still have nothing to prepend. Measured at four turns in five, which is the difference
     * between a mechanism worth little and one worth five times what the delta says.
     *
     * Absent ⇒ delivery is not a separate question for this experiment (the terse steer always lands) or no
     * turn in the window recorded it. The screen shows the delta as diluted rather than silently scaling it:
     * the correction is a division by a rate this small only when the rate is itself well measured. */
    deliveredPct: z.number().optional(),
    // Turns per arm before a delta is reported at all. Carried on the wire so the screen's "measuring…" state
    // counts toward the daemon's real threshold instead of a number the browser guessed.
    minTurns: z.number(),
    /* THE RESOLUTION, present as soon as both arms clear `minTurns`: ± percentage points at 95% (Welch,
     * unequal variances and unequal arms). Present even when the delta below is withheld, because "whatever
     * this mechanism does, it is smaller than ±35 points" is a true and useful thing to be told — it is the
     * reading that says to keep collecting rather than to act. */
    marginPct: z.number().optional(),
    /* THE CLAIM, present only once there is one. Both together, and only when the margin does NOT span zero.
     *
     * A schema that can't express a half-measured experiment is how a 34%-that-becomes-8%-tomorrow never
     * reaches the screen — and clearing `minTurns` turned out not to be enough to buy that. The terse steer
     * crossed its thirtieth control turn and immediately reported +31.2% ± 35.1pp: a confidence interval
     * running from −3.4% to +66.7%, which is to say no effect was measured at all, rendered as an alarming
     * number pointing the wrong way. Thirty turns is where the normal approximation starts to hold, not where
     * this much per-turn spread resolves an effect; requiring the interval to exclude zero is the same
     * withhold-until-it-means-something rule applied to the thing that actually decides whether it does.
     *   deltaPct — change in the metric's mean per turn under the mechanism; negative is a saving.
     *   saved    — what the delta is worth over the turns that actually ran with it, in this window, in the
     *              metric's own unit (characters, or dollars). */
    deltaPct: z.number().optional(),
    saved: z.number().optional(),
});
export type TurnExperiment = z.infer<typeof TurnExperimentSchema>;

// `output`/`context` are absent when that experiment isn't running at all (its flag off, or no holdout set) — a
// section that isn't there reads as "not measured", which is the truth, while zeros would read as "measured,
// worth nothing".
export const SavingsReportSchema = z.object({
    input: InputSavingsSchema,
    output: TurnExperimentSchema.optional(),
    context: TurnExperimentSchema.optional(),
});
export type SavingsReport = z.infer<typeof SavingsReportSchema>;

// ---- intentic CLI ----

export const IntenticRunSchema = z.object({ args: z.array(z.string()) });

// ---- git ----

// What a commit records — three shapes, each a real git spelling. The last two are for the case where nothing
// is staged yet and the caller has said what to stage; they are alternatives, and a caller sends at most one:
//   absent      ⇒ commit whatever is staged (plain `git commit`)
//   all: true   ⇒ stage every change in the repo, then commit (`commit -a`; VSCode's "stage all and commit")
//   paths       ⇒ `git add` those repo-relative paths, then commit the index
//
// `paths` is emphatically NOT `commit --only`. The index IS git's mechanism for choosing what a commit
// contains, so a second path-selection channel alongside it could only disagree with it: a partial commit over
// a half-staged file records the WORKTREE content while the row the user picked showed the INDEX content. This
// stages and then records the whole index, which is why it is safe — and why it also survives a merge, where
// git refuses a partial commit outright (and refuses it only AFTER moving the index).
export const CommitSchema = RepoParamSchema.extend({
    message: z.string().min(1),
    all: z.boolean().optional(),
    paths: z.array(z.string().min(1)).max(500).optional(),
});
export const DiscardSchema = RepoParamSchema.extend({
    // Repo-relative paths to discard; absent ⇒ discard every uncommitted change in the repo.
    paths: z.array(z.string().min(1)).max(500).optional(),
});
// Index moves. Both are per-path and never touch the worktree, so they are always safe and need no checkpoint.
export const GitStageSchema = RepoParamSchema.extend({ paths: z.array(z.string().min(1)).max(500) });
// `branch` defaults to the checked-out one. There is deliberately no "set upstream" flag: the daemon publishes
// (`push -u`) exactly when the branch has no upstream yet, which is never destructive and is the only way the
// result is coherent — see pushBranch.
export const PushSchema = RepoParamSchema.extend({ branch: z.string().min(1).optional() });
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1) });
export const GitFileWriteSchema = RepoParamSchema.extend({ path: z.string().min(1), content: z.string() });
// Which of the working tree's diffs to open — the same split the Changes panel lists under. A path that is
// staged AND edited again has genuinely different diffs, so the side is required rather than defaulted: a
// caller that doesn't say which one it means doesn't know what it is showing.
//   staged     ⇒ index vs HEAD      (what a bare `git commit` would record)
//   unstaged   ⇒ worktree vs index  (untracked ⇒ no before side)
//   conflicted ⇒ HEAD vs worktree   (what you had vs what the merge left, markers included — an unmerged path
//                                    has no stage 0, so the index is not a side it can be diffed against)
export const GitDiffSideSchema = z.enum(["staged", "unstaged", "conflicted"]);
export type GitDiffSide = z.infer<typeof GitDiffSideSchema>;
export const GitFileDiffQuerySchema = RepoParamSchema.extend({ path: z.string().min(1), side: GitDiffSideSchema });
export const GitStatusSchema = z.object({ branch: z.string(), dirty: z.boolean(), files: z.array(z.string()) });
export const GitFilesSchema = z.object({ files: z.array(z.string()) });
export const GitFileSchema = z.object({ path: z.string(), content: z.string() });
export const CommitResultSchema = z.object({ committed: z.boolean() });

// One repo's slice of a workspace-wide git action: the whole repo, or only the repo-relative paths named. The
// same pair the per-repo routes take as {repo} + `paths`, in the one shape a caller that spans repos can send.
export const RepoPathsSchema = z.object({ repo: z.string().min(1), paths: z.array(z.string().min(1)).max(500).optional() });
export type RepoPaths = z.infer<typeof RepoPathsSchema>;

/* AI-drafted commit message. Workspace-wide, not per repo, because the commit box's target IS a set of repos
 * sharing one message — so the draft has to see every one of their diffs to describe what the commit actually
 * records. The input mirrors CommitSchema field for field, which is the whole point: whatever the commit is
 * about to do is what gets described, and the two cannot drift.
 *   repos[].paths ⇒ the subset that commit will stage — read the WORKTREE, narrowed to those paths
 *   all: true     ⇒ the whole worktree, untracked included (what "Commit all" sweeps)
 *   neither       ⇒ the INDEX (what a bare commit records)
 * Getting that wrong would describe changes the commit isn't going to contain. */
export const CommitMessageDraftSchema = z.object({
    repos: z.array(RepoPathsSchema).min(1).max(50),
    all: z.boolean().optional(),
});
// The draft plus WHICH model wrote it, so the surface can name it rather than claiming an anonymous "AI" —
// that name is also the only place the resolved quick model is visible before anyone opens settings.
export const CommitMessageSchema = z.object({
    message: z.string(),
    provider: z.string(),
    model: z.string(),
});
export type CommitMessageDraft = z.infer<typeof CommitMessageSchema>;
// One change to a file — an uncommitted working-tree change (status vs HEAD, untracked included), an agent
// worktree's delta vs its base, or a file in a commit. `additions`/`deletions` are the numstat line counts,
// undefined for a binary file (git reports "-"/"-") or an untracked file (no HEAD blob to diff against).
export const GitChangeSchema = z.object({
    // Repo-relative path with forward slashes; for "renamed" the NEW path (`from` carries the old one).
    path: z.string(),
    // "conflicted" is git's unmerged state (`U`), and it is not a kind of modification: the index holds "ours"
    // and "theirs" at stages 2/3 with NO stage 0, so there is nothing a commit could record for this path and
    // git refuses to commit while one exists. It belongs to neither side — see RepoChanges.conflicted.
    status: z.enum(["added", "modified", "deleted", "renamed", "type-changed", "conflicted"]),
    from: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
});
export type GitChange = z.infer<typeof GitChangeSchema>;

// Where a repo's checked-out branch stands against its remote. Every field is optional-or-zero because every
// one of them is legitimately absent in a healthy repo: no remote configured yet, a branch created locally and
// never pushed, a detached HEAD. `ahead` = commits only we have; `behind` = commits only the upstream has,
// which is meaningful only as of the last fetch — the panel's Fetch button is what refreshes it.
export const GitRemoteStateSchema = z.object({
    // The remote this branch pushes to: its OWN remote when it tracks one, else the first `git remote` lists
    // (where a never-pushed branch would publish). Those differ in a fork — `origin` and `upstream` both
    // configured — and pushing to the wrong one succeeds while leaving `ahead` stuck. Absent ⇒ no remote.
    remote: z.string().optional(),
    // The checked-out branch; absent on a detached HEAD or an unborn repo.
    branch: z.string().optional(),
    // The tracking ref ("origin/main"); absent ⇒ this branch has no upstream, so the next push publishes it.
    upstream: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
});
export type GitRemoteState = z.infer<typeof GitRemoteStateSchema>;

// A ref name (branch/tag), validated structurally — git enforces the rest of ref-name legality itself.
const RefNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .max(200);

// One local branch, for the switcher. `at` is its tip's committer time in ms (the list sorts newest-first).
export const GitBranchSchema = z.object({
    name: z.string(),
    current: z.boolean(),
    upstream: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
    // The configured upstream no longer exists on the remote (a merged PR's deleted branch) — distinct from
    // "no upstream", and the signal that this local branch is safe to delete.
    gone: z.boolean().optional(),
    at: z.number(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;
/* One REMOTE-TRACKING branch — somebody else's tip, as this repo last saw it.
 *
 * A separate shape from GitBranch rather than the same one with optional fields, because the two genuinely
 * differ: a remote-tracking branch has no upstream of its own and no ahead/behind, and giving it those fields
 * as zeroes would make it look like a synced local branch. `name` is the full `origin/main`; `remote` and
 * `branch` are it split, so a selector can group by remote without re-parsing. */
export const GitRemoteBranchSchema = z.object({ name: z.string(), remote: z.string(), branch: z.string(), at: z.number() });
export type GitRemoteBranch = z.infer<typeof GitRemoteBranchSchema>;
// Locals and remote-tracking branches in one response: the switcher pairs them, and two round trips to draw one
// list would only ever show a half-populated one first.
export const GitBranchesSchema = z.object({ branches: z.array(GitBranchSchema), remotes: z.array(GitRemoteBranchSchema) });
// Create at `start` (a sha or ref; absent ⇒ HEAD); `checkout` switches to it immediately (`git switch -c`).
export const GitBranchCreateAtSchema = RepoParamSchema.extend({
    name: RefNameSchema,
    start: z.string().min(1).optional(),
    checkout: z.boolean().optional(),
});
// `force` is the deliberate retry after git refuses to drop an unmerged branch.
export const GitBranchDeleteSchema = RepoParamSchema.extend({ name: RefNameSchema, force: z.boolean().optional() });

/* THE OPERATION A REPO IS HALTED IN THE MIDDLE OF — a merge, rebase, cherry-pick or revert that stopped on a
 * conflict and was never finished or aborted.
 *
 * Every verb the daemon runs itself aborts cleanly on failure, so this is never something the UI started. It is
 * what an agent or a user left behind in a terminal, and it is a state git refuses to do almost anything else
 * from — so a surface listing the conflicted files without naming it leaves the reader with no way out.
 * Absent means the worktree is not mid-anything. */
export const GitOperationSchema = z.enum(["merge", "rebase", "cherry-pick", "revert"]);
export type GitOperation = z.infer<typeof GitOperationSchema>;
export const GitOperationStateSchema = z.object({ repo: z.string(), operation: GitOperationSchema.optional() });
export type GitOperationState = z.infer<typeof GitOperationStateSchema>;

export const RepoChangesSchema = z.object({
    // The {repo} param the per-repo git routes accept: "root" or a repo id (its root-relative dir).
    repo: z.string(),
    // Absent on an unborn HEAD (a repo initialized but never committed).
    branch: z.string().optional(),
    // Unmerged paths — a merge, rebase, cherry-pick or pull that git could not finish. First, because until
    // they are resolved nothing else in this repo can be committed at all: git refuses outright. Held apart
    // from the two sides rather than listed in them, because "staged or not" is not a question an unmerged path
    // has an answer to. Staging one (`git add`) is exactly how you tell git it is resolved.
    conflicted: z.array(GitChangeSchema),
    /* The merge/rebase/cherry-pick/revert this repo is halted in the middle of, when it is. Carried on the SCAN
     * rather than fetched per repo because it belongs beside `conflicted`: the panel already lists the files,
     * and this is the sentence that says why they are conflicted and what ends it. Absent = not mid-anything,
     * which is every repo almost all of the time. */
    operation: GitOperationSchema.optional(),
    // The two sides git actually models, kept apart because a path can appear on BOTH with different statuses
    // (a staged edit that was then edited again — the classic `MM`). `staged` is index-vs-HEAD: exactly what a
    // bare `git commit` would record. `unstaged` is worktree-vs-index plus untracked files. Each side's
    // additions/deletions describe the diff it is listed under, never a conflation of the two.
    staged: z.array(GitChangeSchema),
    unstaged: z.array(GitChangeSchema),
    // How many changes were CUT from the two sides above (conflicts are never cut). A cloned monorepo or a
    // mass delete carries six-figure change lists — a payload no panel can render and no browser should hold —
    // so past the daemon's per-repo budget the lists arrive truncated and this carries the dropped count, which
    // the panel adds to its badges and states under the group. Absent ⇒ the lists are complete.
    truncated: z.number().optional(),
    // Where this repo stands against its remote; `ahead`/`behind` are 0 with no remote or no upstream.
    remote: GitRemoteStateSchema.optional(),
    // WHICH AGENT PUT IT THERE: repo-relative path → the agent ids that landed it, newest land first. Keyed by
    // PATH rather than carried on each GitChange because a path can be listed on two sides at once (staged and
    // edited again) and its origin is the same fact for both. Only branch-backed agents whose work passed
    // through land can appear here; workspace conversations, terminal edits and the user's typing are absent
    // (see agents/origins.ts), so the panel badges an attributable agent and says nothing for anyone else.
    // Ids, not titles: the identity for every id named here rides the response once, in `originAgents`.
    origins: z.record(z.string(), z.array(z.string())).optional(),
    // Why the repo could not be scanned at all, condensed to git's own one-line reason ("fatal: bad object HEAD").
    // A repo left torn by a canceled or failed upload used to be dropped from the response entirely, so it just
    // vanished from the panel with nothing to act on; it now arrives with empty change lists and this set instead.
    error: z.string().optional(),
});
export type RepoChanges = z.infer<typeof RepoChangesSchema>;

// WHO AN ORIGIN ID IS — the display identity of one agent named in `origins`, carried BY THE RESPONSE rather
// than looked up in the client's fleet roster. The roster is the LIVE board and deliberately drops archived
// agents (AgentsRegistry.list), while a landing outlives the agent that made it: archiving a finished agent
// does not commit its lines, so the very common case — land, archive the card, review at leisure — is exactly
// the one a roster lookup cannot answer, and the panel fell back to "Agent 1a2b3c" with a generic icon for it.
// The daemon reads attribution and identity from the same registry in the same pass, so it is the one place
// they cannot disagree. Per response, not per repo: one agent commonly lands into several.
export const OriginAgentSchema = z.object({
    // Absent for an entry that never got a title (a turn that failed before one was derived).
    title: z.string().optional(),
    provider: AgentProviderSchema,
});
export type OriginAgent = z.infer<typeof OriginAgentSchema>;

// The aggregated review set across every repo (root + every discovered repo); a repo appears when it has changes,
// when it is out of sync with its remote, or when it failed to scan.
export const GitChangesSchema = z.object({
    repos: z.array(RepoChangesSchema),
    // Keyed by agent id; covers every id any repo's `origins` names, and only those. Absent when nothing in
    // the review is attributable. An id can still be missing from it — the retention sweep can retire an
    // entry whose landed lines are somehow still uncommitted — and the panel keeps its id-shaped fallback for
    // exactly that, rather than dropping the chip and re-attributing the file to the user.
    originAgents: z.record(z.string(), OriginAgentSchema).optional(),
});
export type GitChanges = z.infer<typeof GitChangesSchema>;

// One file an agent touched, plus whether that change is ALREADY in the main tree. The review lists the
// agent's CUMULATIVE output (base → worktree), not just the not-yet-landed remainder, because landing is not
// the end of the review: a clean turn auto-lands within milliseconds, and a list scoped to the remainder shows
// the user an empty panel for work they never got to look at. `landed` is what still separates the two — the
// remainder is what "Land now" would apply, and the panel filters on exactly this flag.
export const AgentChangeSchema = GitChangeSchema.extend({ landed: z.boolean() });
export type AgentChange = z.infer<typeof AgentChangeSchema>;

// An agent conversation-worktree's delta vs its recorded base — deliberately NOT RepoChanges. There is no index
// side to speak of here: the question a fleet review answers is "what did this agent write", which is one flat
// set. Sharing the working-tree shape would have forced a meaningless empty `staged` on every
// row and invited the panel to render a staging affordance that cannot work on a worktree the user never checks out.
export const AgentRepoChangesSchema = z.object({
    repo: z.string(),
    branch: z.string().optional(),
    changes: z.array(AgentChangeSchema),
});
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
/* The review, plus WHY the last land refused — because a conflict is discovered by the daemon (a clean turn
 * auto-lands the moment it finishes) and acted on in the browser, possibly hours later, on a surface the user
 * reaches by clicking the card's "Resolve conflict". Carrying the report only in the land RESPONSE meant the
 * one path that opens the review already knowing there is a conflict was the one path that could not show it:
 * the panel opened with an empty report, no explanation, and no merge affordance — a dead end at the exact
 * moment the UI had promised something to resolve. It rides the review because that is the surface that
 * resolves it, and it refreshes with it: every land invalidates this query, so the report is never staler
 * than the last attempt. */
export const AgentChangesSchema = z.object({ repos: z.array(AgentRepoChangesSchema), conflicts: z.array(LandConflictSchema).optional() });
export type AgentChanges = z.infer<typeof AgentChangesSchema>;

// ---- git history graph (the "Git Graph" view over a repo's real commits) ----
// A hex sha (full or git-abbreviated): the only shape the graph ever sends back, so the per-commit routes
// constrain to it rather than accepting an arbitrary git revision expression.
const ShaSchema = z.string().regex(/^[0-9a-f]{4,64}$/);
// One commit in the graph. `parents` (0 = root, 1 = normal, 2+ = merge) drive the lane layout, computed
// client-side. `refs` are the branch/tag decorations at this commit (tags keep their `tag: ` prefix; the bare
// "HEAD" marker is lifted into `head` instead). `at` is author time in ms since epoch; `short` is git's
// abbreviated sha; `body` is the message minus its subject line.
export const GitCommitSchema = z.object({
    sha: z.string(),
    short: z.string(),
    parents: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    author: z.string(),
    email: z.string(),
    at: z.number(),
    refs: z.array(z.string()),
    head: z.boolean(),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;
// One repo's log: commits newest-first across ALL refs (branch topology is the point of a graph), plus the
// checked-out branch (absent on a detached HEAD or an unborn repo).
export const GitLogSchema = z.object({
    repo: z.string(),
    branch: z.string().optional(),
    commits: z.array(GitCommitSchema),
    // Whether a further page exists behind this one. The daemon learns it by asking git for one commit more than
    // it returns — see commitLog. It is also what stops the oldest row of a page from being drawn as a ROOT
    // commit, which is how a truncated history used to claim it began where the page happened to stop.
    hasMore: z.boolean(),
});
export type GitLog = z.infer<typeof GitLogSchema>;
export const GitLogQuerySchema = RepoParamSchema.extend({
    limit: z.coerce.number().int().positive().max(2000).optional(),
    // How many newer commits to step over — the page cursor. Paged rather than one big read because a large
    // repository's log is tens of thousands of rows, and every one of them costs a zod validation, a wire
    // payload and a lane computation before anything is drawn.
    skip: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
});
// Every real git repo under /work as root-relative dir ids ("root" is implicit — the /work repo itself).
export const GitReposSchema = z.object({ repos: z.array(z.string()) });
export type GitRepos = z.infer<typeof GitReposSchema>;
export const GitCommitDiffQuerySchema = RepoParamSchema.extend({ sha: ShaSchema });
// A commit's changed files (vs its first parent; a root commit vs the empty tree) — the graph's detail tree
// renders these (line stats included) and reuses the diff UI on click. Just GitChanges: the line stats live on
// GitChange now, so working-tree and commit files share one shape.
export const GitCommitDiffSchema = z.object({ files: z.array(GitChangeSchema) });
export type GitCommitDiff = z.infer<typeof GitCommitDiffSchema>;
export const GitCommitFileDiffQuerySchema = RepoParamSchema.extend({ sha: ShaSchema, path: z.string().min(1) });
// Git write actions from the graph's commit context menu (VSCode "Git Graph" parity). Non-destructive: branch
// and tag just add a ref (HEAD + worktree untouched, no checkpoint). Sequence ops (revert / cherry-pick /
// merge / rebase / drop) add or replay commits and are auto-checkpointed daemon-side; a conflict aborts and
// reports `ok:false` (an expected outcome, not a throw). Checkout and reset move HEAD (reset --hard discards
// the worktree) — also auto-checkpointed. A `{repo, sha}` names the target commit for every commit-scoped
// action; a ref name (branch/tag) is validated structurally, git enforces the rest of ref-name legality
// (RefNameSchema is declared above, with the branch schemas that first use it).
export const GitBranchCreateSchema = RepoParamSchema.extend({ sha: ShaSchema, name: RefNameSchema });
export const GitTagCreateSchema = RepoParamSchema.extend({ sha: ShaSchema, name: RefNameSchema });
export const GitCheckoutSchema = RepoParamSchema.extend({ ref: RefNameSchema });
// Deleting a tag locally, and — when a remote is named — on that remote too. The remote half is best-effort: a
// tag that was never pushed must not make deleting the local one report a failure.
export const GitTagDeleteSchema = RepoParamSchema.extend({ name: RefNameSchema, remote: RefNameSchema.optional() });
// Publishing ONE tag, named explicitly so it never drags every other unpushed tag along with it.
export const GitTagPushSchema = RepoParamSchema.extend({ name: RefNameSchema, remote: RefNameSchema });
export const GitResetSchema = RepoParamSchema.extend({ sha: ShaSchema, mode: z.enum(["soft", "mixed", "hard"]) });
export const GitCommitActionSchema = RepoParamSchema.extend({ sha: ShaSchema });
export const GitActionResultSchema = z.object({ ok: z.boolean(), reason: z.string().optional() });
export type GitActionResult = z.infer<typeof GitActionResultSchema>;

/* THE STASH — work set aside without committing it, and the one part of a repository's real state the workspace
 * used to be blind to entirely. A `git stash` in a terminal made the agent's (or the user's) work vanish from
 * every surface here.
 *
 * An entry IS a commit: it has a sha, a time, a diff, and parents (HEAD when it was taken, the index, and the
 * untracked tree when `-u` was used). What it does not have is a place in any branch's ancestry, so the graph
 * hangs it off the commit it was taken on rather than flowing it down a lane.
 *
 * `ref` (`stash@{0}`) is the handle every verb takes, and it is POSITIONAL — dropping one renumbers the rest, so
 * a caller must re-read the list after any mutation rather than holding an index across it. */
export const StashEntrySchema = z.object({
    ref: z.string(),
    sha: z.string(),
    short: z.string(),
    // git's own `WIP on <branch>: …` scaffolding stripped, leaving what a reader would call the message.
    subject: z.string(),
    branch: z.string().optional(),
    at: z.number(),
    parents: z.array(z.string()),
});
export type StashEntry = z.infer<typeof StashEntrySchema>;
export const StashListSchema = z.object({ repo: z.string(), stashes: z.array(StashEntrySchema) });
// A stash ref as git numbers them. Constrained rather than free text because it reaches a shell argument.
const StashRefSchema = z.string().regex(/^stash@\{\d{1,4}\}$/);
export const StashPushSchema = RepoParamSchema.extend({ message: z.string().max(500).optional(), includeUntracked: z.boolean().optional() });
// `pop` drops the entry on a clean apply; `apply` keeps it. Git's own distinction, and both are things people
// mean: pop is "resume this", apply is "try this here too".
export const StashApplySchema = RepoParamSchema.extend({ ref: StashRefSchema, pop: z.boolean().optional() });
export const StashRefParamSchema = RepoParamSchema.extend({ ref: StashRefSchema });
export const StashDiffQuerySchema = RepoParamSchema.extend({ ref: StashRefSchema });

/* THE LAST THING THAT MOVED THIS BRANCH, and whether it can be walked back.
 *
 * Complements the Checkpoints timeline rather than duplicating it: a checkpoint restores the WORKING TREE, this
 * moves the BRANCH. After a bad rebase the files are often already right and only the ref is wrong, and
 * restoring a whole worktree snapshot to fix that would drag every unrelated edit since back with it.
 *
 * `description` is git's own reflog subject, so the button can name what it will undo in git's words rather than
 * a guess. `previousSha` is where the branch returns to, and it doubles as the CONCURRENCY TOKEN: the undo is
 * refused when the repository has moved since this was read, so an undo prepared against a stale view cannot
 * land somewhere the user never looked at. Absent = nothing to undo (a fresh branch, a detached HEAD, or a
 * halted operation, which ends by aborting rather than by moving the branch). */
export const UndoKindSchema = z.enum(["commit", "amend", "merge", "rebase", "cherry-pick", "revert", "reset", "pull", "other"]);
export type UndoKind = z.infer<typeof UndoKindSchema>;
export const UndoableActionSchema = z.object({
    kind: UndoKindSchema,
    description: z.string(),
    branch: z.string(),
    sha: z.string(),
    previousSha: z.string(),
    // The action rewrote FILES as well as the ref, so undoing it faithfully needs a hard reset. The UI uses this
    // to decide whether it has to warn about losing work.
    changesWorkingTree: z.boolean(),
});
export type UndoableAction = z.infer<typeof UndoableActionSchema>;
export const GitUndoStateSchema = z.object({ repo: z.string(), action: UndoableActionSchema.optional() });
export type GitUndoState = z.infer<typeof GitUndoStateSchema>;
// `previousSha` is the position the caller was shown; `discardChanges` picks a hard reset over a soft one.
export const GitUndoSchema = RepoParamSchema.extend({ previousSha: ShaSchema, discardChanges: z.boolean().optional() });

// ---- history: daemon-owned workspace snapshots (diff + restore) ----
// The daemon snapshots /work into bare git dirs on /history (outside the agent's reach). A "snapshot" groups
// one commit per scope (root + each nested repo) under a shared id. Only checkpoint triggers (turn / user /
// pre-restore / restore) are listed; "interval" captures are a hidden safety net that dissolves into the next
// visible checkpoint's diff.

export const SnapshotTriggerSchema = z.enum(["turn", "interval", "pre-restore", "restore", "user"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export const SnapshotSchema = z.object({
    id: z.string(),
    // Committer time, ms since epoch.
    at: z.number(),
    trigger: SnapshotTriggerSchema,
    // Human-readable checkpoint label — the turn's prompt for "turn" snapshots; absent otherwise.
    label: z.string().optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/* WHICH CONVERSATION MESSAGE A TURN ANSWERS — carried alongside the turn so its pre-turn checkpoint can be
 * filed under it (see the sandbox's agent/rewind-points.ts). `index` is the transcript position the turn began
 * at, which is also how many messages a rewind to it keeps. */
export interface SnapshotTurn {
    readonly conversationId: string;
    readonly index: number;
}
export const SnapshotsListSchema = z.object({ snapshots: z.array(SnapshotSchema) });

/* REWIND — go back to a message and carry on from there. Restores the workspace to that turn's checkpoint,
 * drops every message after it, and forgets the provider session so the next turn opens a fresh one.
 *
 * `index` is the transcript position of the user message being rewound TO, which is also how many messages
 * survive — rewinding to the first message of a conversation keeps none of it and restores the workspace to
 * before it ran. */
export const RewindTurnSchema = z.object({
    conversationId: z.string().min(1),
    index: z.number().int().nonnegative(),
});
export const RewindResultSchema = z.object({
    // The checkpoint the workspace was restored to, for the History timeline to select.
    snapshot: z.string(),
    // Messages dropped from the transcript — what the client removes from its own bubbles.
    dropped: z.number().int().nonnegative(),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;
export const SnapshotIdSchema = z.object({ id: z.string().min(1) });
export const SnapshotChangeSchema = z.object({
    scope: z.string(),
    // Scope-relative path with forward slashes.
    path: z.string(),
    status: z.enum(["added", "modified", "deleted", "type-changed"]),
});
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export const SnapshotDiffSchema = z.object({ changes: z.array(SnapshotChangeSchema) });
export const SnapshotFileDiffQuerySchema = z.object({
    id: z.string().min(1),
    scope: z.string().min(1),
    path: z.string().min(1),
});
// Both sides of a file diff — a snapshot vs its parent, or a working tree vs HEAD; an absent side means the
// file was added/deleted. Binary or oversized content is flagged instead of shipped.
export const FileDiffSchema = z.object({
    before: z.string().optional(),
    after: z.string().optional(),
    binary: z.boolean().optional(),
    truncated: z.boolean().optional(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

// ---- workspace tree + files ----

/* One node of the full /work filesystem tree the agent sees (untracked + generated files included), distinct
 * from the git-tracked listing. `path` is root-relative with forward slashes so it feeds straight back to the
 * file route.
 *
 * Recursive, and the type is declared rather than inferred. Zod's getter form does infer one, but it collapses
 * to `{}` below the first level of nesting — so `entry.children[0].name` type-checked as an index-signature
 * read on both sides of the wire, and the tree walker's own suite was reading a `hidden` field off entries
 * that has never existed there without the compiler minding. The interface is the contract; the schema
 * validates against it, and z.ZodType makes a divergence between the two an error here. */
export interface WorkspaceTreeEntry {
    readonly name: string;
    readonly path: string;
    readonly type: "file" | "dir";
    readonly size?: number | undefined;
    // Ignored-by-tooling (node_modules, .git, .gitignore'd paths, browser profiles): the client grays the row.
    readonly ignored?: boolean | undefined;
    // A DIR without `children` was listed but not descended into — because it's ignored, or because the walk's
    // breadth-first budget stopped above it. Either way the client lazy-loads it via /workspace/children on
    // expand, so "not loaded yet" and "empty directory" (`children: []`) stay distinguishable.
    readonly children?: readonly WorkspaceTreeEntry[] | undefined;
}
export const WorkspaceTreeEntrySchema: z.ZodType<WorkspaceTreeEntry> = z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "dir"]),
    size: z.number().optional(),
    ignored: z.boolean().optional(),
    get children() {
        return z.array(WorkspaceTreeEntrySchema).optional();
    },
});
export const WorkspaceTreeSchema = z.object({
    root: z.string(),
    tree: z.array(WorkspaceTreeEntrySchema),
    // How many of the ROOT's own entries the budget cut (0 = complete); per-dir cuts are counted on each dir entry.
    hidden: z.number(),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;
// Lazy-load one directory's children — for a dir the tree walk listed but didn't descend into. Child dirs again
// carry no `children`, so they lazy-load on their own expand. `hidden` = how many entries the cap cut (0 = all
// listed).
export const WorkspaceChildrenQuerySchema = z.object({ path: z.string().min(1) });
export const WorkspaceChildrenSchema = z.object({
    entries: z.array(WorkspaceTreeEntrySchema),
    hidden: z.number(),
});
export type WorkspaceChildren = z.infer<typeof WorkspaceChildrenSchema>;
export const WorkspaceFileQuerySchema = z.object({ path: z.string().min(1) });
/* The credential a <video>/<audio> element carries to GET /workspace/media, which is the one workspace route a
 * browser cannot put a header on. Minted here, over the ordinary bearer-authenticated contract, and scoped to
 * the single path it was asked for — see auth/media-tickets.ts for why scope rather than single-use is what
 * bounds it. `expiresAt` is epoch ms so a player can tell a dead ticket from a dead file. */
export const WorkspaceMediaTicketSchema = z.object({ ticket: z.string(), expiresAt: z.number() });
/* A text read is a read of a WINDOW: `offset` is the byte to start at (negative reads that many bytes from the
 * END, which is what following a growing log means — the tail's offset isn't knowable until the size is), and
 * `limit` how many bytes to serve. The daemon clamps `limit` to its own cap, so an omitted or oversized one is
 * the cap rather than the file. Coerced: these arrive as query strings. */
export const WorkspaceFileReadQuerySchema = z.object({
    path: z.string().min(1),
    offset: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).optional(),
});
// `size` is the whole file; `offset`/`bytes` the byte range `content` decodes from, so the reader can tell a
// window from a whole file (offset > 0 || offset + bytes < size ⇒ there is more) and ask for the next one.
export const WorkspaceFileSchema = z.object({
    path: z.string(),
    content: z.string(),
    size: z.number(),
    offset: z.number(),
    bytes: z.number(),
});
// Resolve a file reference an agent (or a compiler, or a terminal) NAMED to the workspace path it means. Prose
// paths are routinely partial — a model that has been discussing `_apps/web/src` writes
// `pages/workspace/Foo.vue` — so a clickable mention has to be matched as a path SUFFIX against the real tree,
// not read as root-relative. `path` is absent when nothing in the workspace ends in that reference.
export const WorkspaceResolveQuerySchema = z.object({ path: z.string().min(1).max(512) });
export const WorkspaceResolveSchema = z.object({ path: z.string().optional() });
// Direct file management over the /work tree (delete / new folder / rename+move / copy). Byte writes + the
// editor's text save go through the plain POST /workspace/upload route (a body doesn't fit oRPC), not here.
export const WorkspaceDirSchema = z.object({ path: z.string().min(1) });
export const WorkspaceMoveSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
// Deterministic (no-LLM) classification of the dropped workspace: each repo dir and loose file sorted into one
// coarse bucket. Read-only — the browser turns it into a proposed layout and applies the accepted moves via the
// existing /workspace/move route. `reason` records the winning signal (magic:<mime>, ext:<ext>,
// repository:<marker>, text-content, unknown) so the proposal is explainable.
export const WorkspaceBucketSchema = z.enum(["repositories", "documents", "media", "archives", "other"]);
export type WorkspaceBucket = z.infer<typeof WorkspaceBucketSchema>;
export const WorkspaceClassificationSchema = z.object({
    classifications: z.array(z.object({ path: z.string(), bucket: WorkspaceBucketSchema, reason: z.string() })),
});
export type WorkspaceClassification = z.infer<typeof WorkspaceClassificationSchema>;
// ---- workspace search ----

// The workspace-search wire shape — shared by the daemon's /workspace/search route and the web client.
// (Implementation detail, not part of the contract: the daemon backs this route with a resident in-process iq
// engine; the engine is interchangeable behind this shape.) Groups are relevance-ranked (best first, never path
// order); each hit carries the match-reason tags the fused engines contributed, and the char spans within `text`
// that matched, so clients highlight without re-finding the needle.
export const WorkspaceSearchQuerySchema = z.object({
    query: z.string().min(2).max(512),
    // Search verbs only — anchor/git verbs (outline, context, log, who, …) are CLI-only surface. Natural language
    // has no verb of its own: `q` classifies the query and answers it semantically when the words call for it.
    mode: z.enum(["q", "find", "files", "def", "refs", "sym", "ast"]).optional(),
    includeIgnored: z.stringbool().optional(),
    // How `find` reads the query — the three switches every editor's search box has (VSCode: Aa, ab, .*).
    // `literal` treats it as fixed text instead of a regex; `caseSensitive` off means case-INSENSITIVE, not
    // ripgrep's smart case.
    literal: z.stringbool().optional(),
    word: z.stringbool().optional(),
    caseSensitive: z.stringbool().optional(),
    limit: z.coerce.number().int().positive().optional(),
    after: z.string().optional(),
});
export const WorkspaceSearchTagSchema = z.object({
    kind: z.enum(["def", "text", "sem", "bm25", "rerank", "path", "import", "call", "type", "write", "fuzzy", "heuristic"]),
    score: z.number().optional(),
});
export type WorkspaceSearchTag = z.infer<typeof WorkspaceSearchTagSchema>;
export const WorkspaceSearchSpanSchema = z.object({ start: z.number(), end: z.number() });
export type WorkspaceSearchSpan = z.infer<typeof WorkspaceSearchSpanSchema>;
export const WorkspaceSearchHitSchema = z.object({
    line: z.number(),
    text: z.string(),
    // Every matched span in `text`, in order — a text search marks all of them, the way an editor does. Empty
    // where the LINE is the match and no span of it is (a semantic or definition hit reports none).
    spans: z.array(WorkspaceSearchSpanSchema),
    tags: z.array(WorkspaceSearchTagSchema),
    // Enclosing symbol ("createWidget (fn)") — parent-document context so the reader often needs no follow-up.
    context: z.string().optional(),
});
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHitSchema>;
export const WorkspaceSearchGroupSchema = z.object({
    path: z.string(),
    score: z.number(),
    hits: z.array(WorkspaceSearchHitSchema),
    // This file had more matching lines than the engine keeps per file, so `hits` is a floor — a panel showing a
    // per-file count has to say "50+" rather than "50".
    capped: z.boolean().optional(),
});
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
// `building` = index still filling (progress 0..1, e.g. embeddings pending); `stale` = revalidation was skipped
// (cursor replay). ageMs = time since the index last matched the disk state.
export const WorkspaceSearchFreshnessSchema = z.object({
    state: z.enum(["fresh", "building", "stale"]),
    ageMs: z.number().optional(),
    progress: z.number().optional(),
    // How many files the index has not caught up with, when it is stale. A count is reportable; "stale" alone
    // reads as a warning about the answer, which it almost never is.
    behind: z.number().optional(),
});
export type WorkspaceSearchFreshness = z.infer<typeof WorkspaceSearchFreshnessSchema>;
export const WorkspaceSearchResultSchema = z.object({
    mode: z.string(),
    total: z.number(),
    // Files the query matched in total, which `groups` reports only for the page it carries — the count a
    // results panel puts beside the hit total ("218 results in 61 files").
    files: z.number(),
    shown: z.number(),
    groups: z.array(WorkspaceSearchGroupSchema),
    freshness: WorkspaceSearchFreshnessSchema,
    truncated: z.boolean(),
    // `total` is a FLOOR: at least one file had more matches than the engine keeps per file. Distinct from
    // `truncated`, which is about this PAGE — a result can be complete on the page and still count partially.
    partial: z.boolean().optional(),
    cursor: z.string().optional(),
    hint: z.string().optional(),
    // What the engine did with the query that the query did not ask for — a pattern rerun as literal text
    // because it is not valid regex, grep-style escapes rewritten, a language filter that matched no files. The
    // text surface has always printed this above the results; a JSON caller could not see it at all.
    note: z.string().optional(),
    // Code-graph neighbors of the top hits (definition anchors + the strongest caller of each).
    related: z.array(z.string()).optional(),
    // Ranked `path:line` anchors that placed but were NOT shown, best first — the answer often sits at rank 5–13,
    // behind groups the budget spent itself on. The text surface has always printed this map; a JSON caller could
    // not see it, so it had to page through `cursor` to learn what the terminal was told up front.
    candidates: z.array(z.string()).optional(),
    // Run provenance for benchmarking: retrieval stages DISABLED this invocation (absent = full pipeline).
    features: z.array(z.string()).optional(),
});
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;

// ---- codebase health: one repository's structure and risk, in numbers ----

// The repo-level companion to the management panel and the git-history graph: what the same resident engine's
// `hotspots` (churn × complexity) and `map` (PageRank over the import graph) verbs rank, as figures a panel can
// plot instead of lines a terminal prints.
//
// Every field is a COUNT that can be recounted in the files themselves — commits, branch points, exported
// symbols. Deliberately no composite "maintainability grade": those aren't comparable across projects and can't
// be checked, and a repo-health surface that launders counts into a letter is worse than none.
// How many hotspot files and key modules a report carries when the caller names no limit. A leaderboard, not an
// inventory: past a screenful the ranking stops being the point, and the reader should be reading the files.
export const HEALTH_LIMIT = 20;
export const WorkspaceHealthQuerySchema = z.object({
    // "root" (the /work repo) or a nested repo's root-relative dir — the same {repo} ids the git routes take.
    repo: z.string().min(1),
    // Churn window (2d, 12h, 1w, 3m). Absent = all of history, which is what a hotspot ranking wants by default.
    since: z.string().max(16).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
});
// One file that is BOTH churning and tangled. `score` is the product the ranking sorts by — carried explicitly
// so the panel plots the number it ranks by rather than recomputing it.
export const WorkspaceHotspotSchema = z.object({
    path: z.string(),
    commits: z.number(),
    adds: z.number(),
    dels: z.number(),
    complexity: z.number(),
    score: z.number(),
    // Epoch ms of the latest commit touching the file, within the window.
    latestMs: z.number(),
});
export type WorkspaceHotspot = z.infer<typeof WorkspaceHotspotSchema>;
// A file of the import graph's ranked skeleton — order IS the rank, so no rank number rides along.
export const WorkspaceKeyModuleSchema = z.object({ path: z.string(), exports: z.number() });
export type WorkspaceKeyModule = z.infer<typeof WorkspaceKeyModuleSchema>;
export const WorkspaceHealthSchema = z.object({
    repo: z.string(),
    totals: z.object({
        files: z.number(),
        symbols: z.number(),
        // Summed branch points across the scoped files.
        complexity: z.number(),
        // How many files qualify as hotspots at all — the lists below are capped, this is not.
        hotspots: z.number(),
    }),
    hotspots: z.array(WorkspaceHotspotSchema),
    modules: z.array(WorkspaceKeyModuleSchema),
    // Same index-freshness signal the search route reports: a panel drawn off a half-built index says so.
    freshness: WorkspaceSearchFreshnessSchema,
});
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>;

// ---- workspace setup (dependency readiness) ----

// One project under /work and whether its dependencies are actually installed. A drop omits node_modules/.venv
// on purpose, so a freshly imported project is present-but-unusable until this says "ready" — the import UI,
// the agent's post-edit type-check, and the agent's turn context all gate on it.
// `dir` is root-relative ("" = the workspace root itself); `manager` is the real binary (pnpm/npm/uv/…);
// `evidence` is the file that decided it ("pnpm-lock.yaml"), so the UI can show WHY, not just what.
// state: ready | installing | needs-setup | unsupported (manager absent from this sandbox — `manager` names it)
//      | stale — installed ONCE and since outgrown: the manifests declare dependencies that are not on disk,
//        which is what an agent leaves behind when it adds one and does not install it. Same command fixes it,
//        so `missing` (how many names cannot resolve) is what separates the two in the UI's wording.
export const ProjectSetupSchema = z.object({
    dir: z.string(),
    ecosystem: z.enum(["node", "python"]),
    manager: z.string(),
    command: z.string(),
    evidence: z.string(),
    state: z.enum(["ready", "installing", "needs-setup", "unsupported", "stale"]),
    missing: z.number().optional(),
});
export type ProjectSetup = z.infer<typeof ProjectSetupSchema>;
export const WorkspaceSetupSchema = z.object({ projects: z.array(ProjectSetupSchema) });
export type WorkspaceSetup = z.infer<typeof WorkspaceSetupSchema>;
// Install these projects' dependencies. Dirs already ready, already installing, or whose manager is missing are
// skipped server-side, so a stale client list can't spawn redundant installs — `started` is what actually ran.
export const WorkspaceInstallSchema = z.object({ dirs: z.array(z.string()).min(1) });
export const WorkspaceInstallResultSchema = z.object({ started: z.array(z.string()) });

// ---- workspace repos ----

// Every discovered repo's id (root-relative dir under /work), sorted — roles included.
export const ReposListSchema = z.object({ repos: z.array(z.string()) });
export const CloneRepoSchema = z.object({ name: z.string().min(1), cloneUrl: z.string().min(1), branch: z.string().optional() });
export const CloneResultSchema = z.object({ name: z.string(), path: z.string() });
// Per-repo result of a workspace sync (fetch + guarded fast-forward). `status` mirrors GitSyncResult plus the
// turn-orchestration outcomes skipped/error; behind/ahead/head/message are present per status (see RepoSyncOutcome).
export const RepoSyncSchema = z.object({
    repo: z.string(),
    status: z.enum(["updated", "current", "dirty", "diverged", "no-remote", "skipped", "error"]),
    behind: z.number().optional(),
    ahead: z.number().optional(),
    head: z.string().optional(),
    message: z.string().optional(),
});
export const WorkspaceSyncSchema = z.object({ repos: z.array(RepoSyncSchema) });
// Add one or more named app instances into an EXISTING monorepo. Each entry pairs a template key from the
// source repo's templates.json manifest (e.g. "api", "web", "landing") with a user-chosen instance name
// (e.g. "shop-api"); {repo} names the target monorepo.
export const AppInstanceInputSchema = z.object({
    template: z.string().min(1),
    name: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/),
});
export type AppInstanceInput = z.infer<typeof AppInstanceInputSchema>;
export const AddAppsSchema = z.object({
    repo: z.string(),
    apps: z.array(AppInstanceInputSchema).min(1),
});

// Run vitest for one or more repo-relative project dirs in a named one-shot tmux panel session
// (panel-<repo>--<session>), driven by the apps extension's Run-tests actions. `session` is a slug suffix
// (an app/package name as `<name>__test`, or `tests` for the library section); `dirs` are repo-relative
// package dirs, where "" targets the repo root.
export const RunTestsSchema = z.object({
    repo: z.string(),
    session: z.string(),
    dirs: z.array(z.string()).min(1),
});

// One addable app type the configured source repo offers (from its templates.json), listed for the operator
// panel's Add-app picker: the manifest key + its label/description.
export const TemplateSummarySchema = z.object({ key: z.string(), label: z.string(), description: z.string() });
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export const TemplatesListSchema = z.object({ templates: z.array(TemplateSummarySchema) });
export type TemplatesList = z.infer<typeof TemplatesListSchema>;

// One app instance currently in a monorepo, with its own preview dev server + live status (started/stopped
// from the apps extension). `app` is the user-chosen instance name (the _apps/ dir); `kind` is what sort of
// app it is — the manifest key it was scaffolded from (api/web/landing), else the framework detected from its
// dependencies (astro/next/…), and absent when it was discovered purely by its `dev` script. previewUrl is
// https://preview-<repo>--<app>-<sandboxId>.<zone> (absent on loopback — no zone or no connect token).
export const RepoAppSchema = z.object({
    app: z.string(),
    kind: z.string().optional(),
    previewUrl: z.string().optional(),
    running: z.boolean(),
    healthy: z.boolean(),
});
export type RepoApp = z.infer<typeof RepoAppSchema>;
export const AppsListSchema = z.object({ apps: z.array(RepoAppSchema) });
export type AppsList = z.infer<typeof AppsListSchema>;
// One workspace package in a pnpm monorepo, discovered from pnpm-workspace.yaml's packages globs. `dir` is the
// repo-relative package dir (e.g. "_apps/web"); `group` is its top-level dir segment (e.g. "_apps"), the
// dependencies view's coloring axis.
export const WorkspacePackageSchema = z.object({ name: z.string(), dir: z.string(), group: z.string() });
export type WorkspacePackage = z.infer<typeof WorkspacePackageSchema>;
export const WorkspaceDepTypeSchema = z.enum(["prod", "dev", "peer"]);
export type WorkspaceDepType = z.infer<typeof WorkspaceDepTypeSchema>;
// A workspace-internal dependency edge: `from` DEPENDS ON `to` (from's package.json lists to), typed by which
// dependency block declared it. Pure data — layout/direction is the client's concern.
export const WorkspaceDepEdgeSchema = z.object({ from: z.string(), to: z.string(), type: WorkspaceDepTypeSchema });
export type WorkspaceDepEdge = z.infer<typeof WorkspaceDepEdgeSchema>;
export const WorkspaceGraphSchema = z.object({ packages: z.array(WorkspacePackageSchema), edges: z.array(WorkspaceDepEdgeSchema) });
export type WorkspaceGraph = z.infer<typeof WorkspaceGraphSchema>;
// One module a changed file can be grouped under in the review panels: a repo-relative dir ("_apps/web", or ""
// for a repo that is itself one package) and the name its package.json declares. Distinct from
// WorkspacePackage, which is the DEPENDENCY graph's node — that one is pnpm's view of the workspace and carries
// the grouping axis its diagram colours by; this one is a filesystem fact about where a path lives.
export const WorkspaceModuleSchema = z.object({ dir: z.string(), name: z.string() });
export type WorkspaceModule = z.infer<typeof WorkspaceModuleSchema>;
export const RepoModulesSchema = z.object({ repo: z.string(), modules: z.array(WorkspaceModuleSchema) });
export type RepoModules = z.infer<typeof RepoModulesSchema>;
export const WorkspaceModulesSchema = z.object({ repos: z.array(RepoModulesSchema) });
export type WorkspaceModules = z.infer<typeof WorkspaceModulesSchema>;
// Path params for the per-repo apps routes: the monorepo name (validated in the handler like PanelRepoParam)
// and, for per-app preview control (start/stop), the app key (api/web/landing).
export const RepoAppsParamSchema = z.object({ repo: z.string() });
export const AppParamSchema = z.object({
    repo: z.string(),
    app: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/),
});

// ---- inventory: the i.have.* / i.want.service entries in deploy.config.ts's managed region ----
// The daemon renders/parses these; the browser edits them through the inventory routes. Moved here from the
// daemon's deploy-config.ts so the daemon and the browser validate against ONE schema (no cross-repo dupes).

export const InventoryProviderSchema = z.enum(["host", "cloudflare", "github", "gitlab", "stripe"]);
export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export const ServiceKindSchema = z.enum(["signoz", "outline", "paperless", "openproject", "invoiceninja", "infisical"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;
// Non-secret option values the user provides; secret options (sshKey, apiToken, apiKey) are emitted as env()
// references and never travel over the wire.
export const InventoryValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]));
// `const <name>` binding in deploy.config.ts, so it must be a valid identifier.
const inventoryName = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const BackendEntrySchema = z.object({
    kind: z.literal("backend"),
    provider: InventoryProviderSchema,
    name: z.string(),
    values: InventoryValuesSchema,
});
export const ServiceEntrySchema = z.object({
    kind: z.literal("service"),
    service: ServiceKindSchema,
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
// i.want.app — a deployable app built from source. Single production environment on `main`; `values.domain` is
// where it's exposed. Multi-env/teams/use wiring is hand-authored outside the managed region.
export const AppEntrySchema = z.object({
    kind: z.literal("app"),
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
export const InventoryEntrySchema = z.discriminatedUnion("kind", [BackendEntrySchema, ServiceEntrySchema, AppEntrySchema]);
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export const AddInventoryInputSchema = z.discriminatedUnion("kind", [
    BackendEntrySchema.extend({ name: inventoryName }),
    ServiceEntrySchema.extend({ name: inventoryName }),
    AppEntrySchema.extend({ name: inventoryName }),
]);
export type AddInventoryInput = z.infer<typeof AddInventoryInputSchema>;
export const InventoryNameParamSchema = z.object({ name: z.string() });
export const InventoryListSchema = z.object({ entries: z.array(InventoryEntrySchema) });

// A deploy-target host self-registering via the connect-host script's POST /enroll (connect-token auth). The SSH
// key (+ optional Cloudflare token) is written to desired-state/.env; the host (+ cf) is upserted into inventory.
export const EnrollHostInputSchema = z.object({
    name: inventoryName,
    user: z.string().min(1),
    address: z.string().min(1),
    port: z.coerce.number().default(22),
    via: z.enum(["direct", "cloudflared"]).default("cloudflared"),
    sshKey: z.string().min(1),
    cfToken: z.string().optional(),
    // The zone the connect script resolved alongside cfToken — recorded on the i.have.cloudflare entry so
    // resolve validates against it (no re-discovery) and the Add-service dialog offers `<subdomain>.<zone>`.
    cfZone: z.string().optional(),
});
export type EnrollHostInput = z.infer<typeof EnrollHostInputSchema>;

// ---- capabilities: the sandbox's unified capability manifest (.intentic/capabilities.json) ----
// Everything a user adds to a sandbox is a capability with an idempotent apply + a status check. The manifest is
// the source of truth for what's active; `mcp`-kind entries also feed the agent's MCP servers each turn. DevOps
// is the capability that scaffolds the intent/desired-state repos — until it's active the sandbox is empty.

export const CapabilityKindSchema = z.enum([
    "devops",
    "monorepo",
    "mcp",
    "service",
    "integration",
    "cli",
    "plugin",
    "extension",
    "ssh",
    "vpn",
    "docker",
    "browser",
    "host",
    "agent",
    "endpoint",
]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
export const CapabilityStateSchema = z.enum(["active", "pending", "error", "inactive"]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

// A manifest entry id (capabilities + automations) — also the `mcp__<id>__…` server name for mcp capabilities,
// so it's a safe identifier.
const entryId = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

// Per-kind config. Secrets (an mcp token) live here and are denylisted like tools.json.
export const McpConfigSchema = z.object({ url: z.url(), token: z.string().optional() });
export const ServiceConfigSchema = z.object({
    service: ServiceKindSchema,
    domain: z.string().min(1),
    on: z.string().min(1),
    expose: z.string().min(1),
});
// External-app credential injected into DEPLOYED apps (i.have.stripe → STRIPE_API_KEY from env). Agent-facing
// connectors are `cli` capabilities instead (see below), not integrations.
// Closed, unlike a `cli` provider: this becomes an `i.have.<provider>` entry in deploy.config.ts, and the
// desired-state resolver only knows the providers in InventoryProviderSchema. So an integration card is NOT
// extension-contributable — the vocabulary belongs to the deploy engine, not to a manifest.
export const IntegrationConfigSchema = z.object({ provider: z.literal("stripe") });
// A `cli` capability gives the AGENT an authenticated command-line tool (not a deployed-app credential like
// `integration`): the credential + any non-secret URL are stored here and injected into the agent's env each
// turn (see cliEnvOf), and a .claude/skills/<id> cheatsheet teaches the agent to use it via curl. The provider
// data (fields, env, skill, image fragment) is DATA in an installed extension's `contributes.capabilities`, not
// a per-provider schema arm — so the config is `provider` + arbitrary string fields, validated against the
// card's declared fields at add-time (see the sandbox's capabilities/contributions.ts) rather than by this schema.
export const CliConfigSchema = z.object({ provider: z.string().min(1) }).catchall(z.string());
// A Claude Code plugin from a git repo. The daemon only owns the checkout; the Agent SDK's plugin loader reads
// its internals (skills/agents/hooks/commands/.mcp.json). `path` = subdirectory for plugins that live inside a
// marketplace/monorepo checkout. `token` = https auth for private repos (never echoed; becomes hasToken).
export const PluginConfigSchema = z.object({
    url: z.url(),
    // Branch / tag / commit sha to pin; absent = the default branch's HEAD.
    ref: z.string().min(1).optional(),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional(),
    token: z.string().min(1).optional(),
});
// An intentic extension from a git repo (an intentic-extension.json checkout — UI bundle + agent contributions
// + processes). Unlike `plugin`, `ref` is a REQUIRED full commit sha: extension code runs trusted in the
// owner's browser, so the owner approves exactly the code that runs — pin by construction, updates are explicit
// re-adds at a new sha. `path`/`token` as in PluginConfigSchema.
export const ExtensionConfigSchema = z.object({
    url: z.url(),
    ref: z.string().regex(/^[0-9a-f]{40}$/, "ref must be a full 40-character commit sha"),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional(),
    token: z.string().min(1).optional(),
});
// A remote machine the AGENT can reach over SSH. One capability = one machine; the id is its ssh-config Host
// alias, so the agent runs `ssh <id> "…"`. The handler writes a per-machine config block + a 0600 key/password
// file under ~/.ssh (see the ssh handler), so — unlike `cli` — nothing is injected into the agent's env, and
// several machines never collide. Discriminated by auth so exactly one credential shape is required.
export const SshConfigSchema = z.discriminatedUnion("auth", [
    z.object({
        auth: z.literal("key"),
        host: z.string().min(1),
        port: z.coerce.number().default(22),
        user: z.string().min(1),
        privateKey: z.string().min(1),
    }),
    z.object({
        auth: z.literal("password"),
        host: z.string().min(1),
        port: z.coerce.number().default(22),
        user: z.string().min(1),
        password: z.string().min(1),
    }),
]);
// ---- vpn ----
// A VPN the agent's traffic rides. One capability = one tunnel, discriminated by `provider` so a new protocol
// is a new arm (plus a driver in the daemon's vpn/), never a reinterpretation of an existing field:
//   wireguard — a pasted .conf, brought up with wg-quick.
//   fortinet  — a FortiGate SSL-VPN (what FortiClient's <sslvpn> connections speak), dialled with openconnect
//               --protocol=fortinet. openconnect is the client rather than openfortivpn because it routes over
//               tun instead of pppd: it needs exactly the tun + NET_ADMIN grant this kind already carries, and
//               no /dev/ppp device (which the runtime allowlist does not — and should not — include).
//   ipsec     — an IKEv1/IKEv2 tunnel with a pre-shared key and optional XAuth (FortiClient's <ipsecvpn>
//               connections), run by strongSwan. `aggressive` mirrors FortiClient's dial-up default.
// Connecting is NOT a config field: connect/disconnect are live operations (see vpn.contract.ts) that both the
// user and the agent drive, so a stored tunnel's up/down state is read from the OS, never from the manifest.
// `autoConnect` is the only persisted intent — whether the daemon dials this tunnel again on boot.
export const VpnProviderSchema = z.enum(["wireguard", "fortinet", "ipsec"]);
export type VpnProvider = z.infer<typeof VpnProviderSchema>;

const autoConnect = z.enum(["on", "off"]).default("on");

// FortiClient wraps every stored credential in its own "EncX <hex>" (older builds: "Enc <hex>") encryption,
// keyed to the machine that exported the config — it is NOT recoverable from the file. Pasting one is an easy
// mistake to make, because in the XML it sits exactly where the credential belongs, and the failure it causes
// is unreadable: phase 1 negotiates fine and IKE then reports "calculated HASH does not match HASH payload",
// which says nothing about where the bad value came from. Rejecting it here turns that into a sentence at the
// point of entry. (The FortiClient importer already drops these — this catches a hand-paste.)
// Exported so the add form can flag it inline on blur instead of only on a rejected round-trip — one
// definition of what "this is ciphertext, not a credential" means, shared by the browser and the daemon.
export const isForticlientCiphertext = (value: string): boolean => /^Enc[X]?\s+[0-9A-Fa-f]{8,}$/.test(value.trim());

const notForticlientCiphertext = <T extends z.ZodType<string>>(field: T, label: string): T =>
    field.refine((value) => !isForticlientCiphertext(value), {
        message: `That looks like a value copied straight out of a FortiClient config — FortiClient encrypts it with a key tied to the machine that exported it, so it can't be used here. Enter the actual ${label} (ask whoever administers the gateway).`,
    }) as unknown as T;

export const WireguardVpnConfigSchema = z.object({
    provider: z.literal("wireguard"),
    // The pasted .conf ([Interface] + [Peer]) — it holds the private key, so it's this arm's secret field.
    config: z.string().min(1),
    autoConnect,
});
export const FortinetVpnConfigSchema = z.object({
    provider: z.literal("fortinet"),
    // Gateway host only; the port is its own field so a pasted "host:port" can be split on import.
    server: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(443),
    username: z.string().min(1),
    password: notForticlientCiphertext(z.string().min(1), "password"),
    // A FortiGate on a self-signed/private-CA certificate: openconnect pins this digest
    // ("sha256:…", copied from its own refusal message) instead of trusting a CA. Absent ⇒ normal CA validation.
    trustedCert: z.string().min(1).optional(),
    // Some gateways scope a login to a realm/group (openconnect --usergroup, FortiClient's tunnel realm).
    realm: z.string().min(1).optional(),
    autoConnect,
});
export const IpsecVpnConfigSchema = z.object({
    provider: z.literal("ipsec"),
    server: z.string().min(1),
    presharedKey: notForticlientCiphertext(z.string().min(1), "pre-shared key"),
    // The local IKE identity (FortiClient's <localid>) — dial-up FortiGates key their phase-1 selection off it.
    localId: z.string().min(1).optional(),
    remoteId: z.string().min(1).optional(),
    // XAuth (FortiClient's <xauth>) — absent for PSK-only tunnels.
    username: z.string().min(1).optional(),
    password: notForticlientCiphertext(z.string().min(1), "XAuth password").optional(),
    ikeVersion: z.enum(["1", "2"]).default("1"),
    // Perfect Forward Secrecy for phase 2. Must match the gateway EXACTLY: it decides whether a KE payload is
    // sent in quick mode, and a mismatch fails with NO_PROPOSAL_CHOSEN only after phase 1 and XAuth have
    // succeeded — which reads like anything but a phase 2 problem. FortiClient stores it as <pfs> under
    // <ipsec_settings> and defaults it on, so that is the default here too.
    pfs: z.enum(["on", "off"]).default("on"),
    // The Diffie-Hellman group, as FortiClient numbers them. ONE field for both phases on purpose: in IKEv1
    // strongSwan sends a single KE payload in quick mode and the phase-2 group ends up following phase 1, so
    // offering a phase-1 list that starts with a different group than the gateway wants for phase 2 fails with
    // NO_PROPOSAL_CHOSEN no matter what the esp= line says. 14 (modp2048) is FortiClient's phase-2 default;
    // it is <dhgroup> under <ipsec_settings> in an export.
    dhGroup: z.enum(["2", "5", "14", "15", "16", "19", "20"]).default("14"),
    // IKEv1 aggressive mode: insecure by construction, and exactly what FortiGate dial-up with a group PSK
    // requires — hence opt-in per connection rather than a global strongSwan setting.
    aggressive: z.enum(["on", "off"]).default("on"),
    autoConnect,
});
export const VpnConfigSchema = z.discriminatedUnion("provider", [WireguardVpnConfigSchema, FortinetVpnConfigSchema, IpsecVpnConfigSchema]);
// A logged-in browser session the AGENT drives via Playwright MCP tools — for social platforms whose APIs can't
// cover "all the actions" (X reads are paywalled; X community-join and YouTube community-posts have no API). No
// secret in the manifest: the session lives in a persisted Chromium profile under .intentic/browser/<platform>,
// established once through the guided-login WebSocket (/system/browser-login). Chromium itself rides this kind's
// Dockerfile fragment, applied on an owner rebuild. One capability = one platform (the id doubles as the profile).
//
// `platform` is an OPEN slug, not an enum, for the reason `cli`'s `provider` is: a platform is a card, a login URL
// and a skill in an installed extension's `contributes.capabilities`, so the set of them is not a fact this
// contract can know. The add route validates it against the contributed entry instead (see contributions.ts).
export const BrowserConfigSchema = z.object({ platform: z.string().min(1) });
/* A connected COMPUTER of the user's own — the inverse of `ssh`, which reaches a server the sandbox can dial.
 * A machine behind NAT can't be dialled, so it dials US: the @intentic/host agent (installed by a one-liner,
 * enrolled with a single-use pairing token) holds one outbound WebSocket to this daemon and serves an MCP tool
 * surface — shell, files, screenshots — from the far end. The daemon tunnels the agent's JSON-RPC over it and
 * never implements a tool itself, so the machine's capabilities evolve with ITS binary, not with a daemon release.
 *
 * One capability = one machine. The id is the machine's name and namespaces its tools (mcp__laptop__run_command),
 * so several connected machines never collide — the `ssh` precedent. `platform` splits the SKILL pack: a Windows
 * machine is taught PowerShell and a Linux one systemd/D-Bus, and neither carries the other's noise.
 *
 * SCOPES ARE THE GRANT, and they are enforced ON THE MACHINE, never here: the daemon pushes them down on every
 * connect, and the agent refuses out-of-scope calls itself. So a sandbox that is compromised — or an agent talked
 * into it by something it read on the internet — still cannot exceed what the owner ticked. `roots` bounds file
 * reads AND writes to a set of directories (empty ⇒ the user's home).
 *
 * Like a browser `platform`, this is an OPEN slug: an OS is a card plus a skill pack in an installed extension's
 * `contributes.capabilities`, and teaching the agent a new one should not need a daemon release. */
// on/off rather than a boolean: capability configs arrive from the add form as strings (the vpn autoConnect
// precedent), and a select is what the form renders for an enum.
const hostScope = z.enum(["on", "off"]);
export const HostScopesSchema = z.object({
    // Run commands in a real shell (PowerShell on Windows, the login shell on Linux). Off ⇒ files/screen only.
    shell: hostScope.default("on"),
    // Create, modify and trash files under `roots`. Reads are always allowed within them; this is the write half.
    write: hostScope.default("off"),
    // Capture the screen. Off ⇒ screenshot refuses, and the agent is told so rather than getting a black frame.
    screen: hostScope.default("on"),
    /* Move the pointer, click, type and scroll — GUI work, for the things with no command-line way in. Its own
     * switch rather than part of `screen` because looking and touching are not the same permission: a screenshot
     * is bounded by what is on the display, while one click can confirm a dialog nobody read. Default off, like
     * `write`, and for the same reason — a user who has not thought about it should not discover the agent has
     * been driving their desktop. */
    control: hostScope.default("off"),
    // One directory per line. Empty ⇒ the machine's home directory, which is what the agent reports at connect.
    roots: z.string().optional(),
});
export type HostScopes = z.infer<typeof HostScopesSchema>;
export const HostConfigSchema = HostScopesSchema.extend({ platform: z.string().min(1) });
// An ACP (Agent Client Protocol) agent served as a chat provider: the daemon spawns `command` as a long-lived
// subprocess speaking JSON-RPC over stdio, and the capability id becomes the provider id in the chat picker
// (see AgentProviderSchema). `command` is split on whitespace — no shell quoting. `env` is a pasted KEY=VALUE
// block (one per line); credentials ride here, so the whole block is the secret field (echoed as hasSecret) —
// the vpn-conf precedent. `loginCommand` is an interactive login the user completes in a visible terminal
// (device-code flows); the agent persists credentials in its own store inside the container. `name` is the
// picker's display label; absent = the id.
export const AcpAgentConfigSchema = z.object({
    command: z.string().min(1),
    name: z.string().min(1).optional(),
    env: z.string().optional(),
    loginCommand: z.string().min(1).optional(),
});

/* A MODEL API THE USER POINTED US AT — one shape for every server that serves models over HTTP, whether it runs
 * beside this container or in another datacentre. There is deliberately NO local/remote axis: an Ollama on the
 * docker host, a vLLM on the GPU box down the hall, a LiteLLM gateway and OpenRouter differ only in the URL, and
 * inventing a distinction would mean two code paths, two cards and two sets of bugs for one concept.
 *
 * `protocol` is the only real fork, and it is about the WIRE, not about where the server lives:
 *   openai    — the endpoint speaks OpenAI /v1/chat/completions (Ollama, vLLM, llama.cpp, LM Studio, TGI,
 *               OpenRouter, most gateways). The Claude Code harness speaks only the Anthropic Messages API, so
 *               these are re-served through the bundled translator, which is already in the image for exactly
 *               this job (agent/translator.ts). The user's key stays in the translator's config on /history and
 *               never reaches the harness — it gets the loopback bearer instead.
 *   anthropic — the endpoint already speaks the Anthropic Messages API (LiteLLM's /v1/messages, a Bedrock or
 *               Vertex router, a corporate Anthropic gateway). Nothing to translate: the harness is pointed
 *               straight at it with the user's own key.
 *
 * `headers` is a pasted `Name: value` block, one per line — the extra headers gateways ask for (a tenant id, a
 * routing hint). The key is the secret field; the header block is not, because it is where non-credential
 * routing metadata lives and hiding it would make a misrouted endpoint undiagnosable. */
export const EndpointProtocolSchema = z.enum(["openai", "anthropic"]);
export type EndpointProtocol = z.infer<typeof EndpointProtocolSchema>;
export const EndpointConfigSchema = z.object({
    // The API root, INCLUDING the version segment the server publishes (…:11434/v1). Taken verbatim rather than
    // normalised: "which suffix does this server want" is the one thing that actually varies between them, and
    // guessing it is how a working URL becomes an unexplainable 404.
    baseUrl: z.url(),
    protocol: EndpointProtocolSchema.default("openai"),
    apiKey: z.string().optional(),
    headers: z.string().optional(),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
export type CliConfig = z.infer<typeof CliConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type WireguardVpnConfig = z.infer<typeof WireguardVpnConfigSchema>;
export type FortinetVpnConfig = z.infer<typeof FortinetVpnConfigSchema>;
export type IpsecVpnConfig = z.infer<typeof IpsecVpnConfigSchema>;
export type VpnConfig = z.infer<typeof VpnConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type HostConfig = z.infer<typeof HostConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
export type EndpointConfig = z.infer<typeof EndpointConfigSchema>;

export const CapabilitySchema = z.discriminatedUnion("kind", [
    z.object({ id: entryId, kind: z.literal("devops"), config: z.object({}) }),
    // A pnpm+turbo monorepo the user scaffolds as its own repo; the `id` is the repo name. No config — apps are
    // added into it afterwards from its operator panel.
    z.object({ id: entryId, kind: z.literal("monorepo"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("mcp"), config: McpConfigSchema }),
    z.object({ id: entryId, kind: z.literal("service"), config: ServiceConfigSchema }),
    z.object({ id: entryId, kind: z.literal("integration"), config: IntegrationConfigSchema }),
    z.object({ id: entryId, kind: z.literal("cli"), config: CliConfigSchema }),
    z.object({ id: entryId, kind: z.literal("plugin"), config: PluginConfigSchema }),
    z.object({ id: entryId, kind: z.literal("extension"), config: ExtensionConfigSchema }),
    z.object({ id: entryId, kind: z.literal("ssh"), config: SshConfigSchema }),
    // No IFNAMSIZ cap on the id: the tunnel's interface name is DERIVED (see the daemon's vpn/vpn-paths.ts
    // interfaceName) rather than being the id itself, so a descriptive name is free.
    z.object({ id: entryId, kind: z.literal("vpn"), config: VpnConfigSchema }),
    // The in-sandbox Docker Engine (baked into the base image, dormant by default). No config: the capability's
    // whole effect is its fragment's `--privileged` runtime directive + running dockerd. No remove — the engine's
    // state (/var/lib/docker) and whatever runs on it make a silent de-privilege more destructive than useful.
    z.object({ id: entryId, kind: z.literal("docker"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("browser"), config: BrowserConfigSchema }),
    z.object({ id: entryId, kind: z.literal("host"), config: HostConfigSchema }),
    z.object({ id: entryId, kind: z.literal("agent"), config: AcpAgentConfigSchema }),
    // A model API (EndpointConfigSchema). The id becomes `endpoint/<id>` in the chat picker — the `agent` kind's
    // precedent, with the prefix because these two are the only capability kinds that mint providers and they
    // want opposite ability records (an ACP agent owns its own loop; an endpoint runs the full Claude Code one).
    z.object({ id: entryId, kind: z.literal("endpoint"), config: EndpointConfigSchema }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilityStatusSchema = z.object({ state: CapabilityStateSchema, detail: z.string().optional() });
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
// The list row: manifest entry + live status. Secrets are never returned (an mcp token becomes hasToken).
export const CapabilitySummarySchema = z.object({
    id: z.string(),
    kind: CapabilityKindSchema,
    status: CapabilityStatusSchema,
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
// A capability the WORKSPACE asks for but the manifest doesn't carry — derived from what is checked out under
// /work, not from anything the user configured. It exists because the failure it prevents is illegible: a
// compose-backed dev database (`pnpm db:up`) dies on a missing /var/run/docker.sock, and nothing on that error
// points at the one-time privileged rebuild that fixes it. `evidence` is the workspace-relative path that
// triggered it, rendered verbatim so the claim is checkable rather than magic.
export const CapabilityRecommendationSchema = z.object({ kind: CapabilityKindSchema, evidence: z.string() });
export type CapabilityRecommendation = z.infer<typeof CapabilityRecommendationSchema>;
export const CapabilitiesListSchema = z.object({
    capabilities: z.array(CapabilitySummarySchema),
    // Defaulted for the daemon-older-than-browser seam: the platform's web app talks to whichever sandbox
    // version the user has, and a required field here would fail the parse — taking the whole Capabilities page
    // down on every sandbox predating this route, to hide a badge.
    recommendations: z.array(CapabilityRecommendationSchema).default([]),
});
export const CapabilityIdParamSchema = z.object({ id: z.string() });
// POST /capabilities/{id}/secret body: replace just the capability's secret field (its key is per-kind, see the
// sandbox's secretField) and re-run its idempotent apply — the /secrets page's edit path.
export const CapabilitySecretInputSchema = z.object({ id: z.string(), value: z.string().min(1) });
// POST /capabilities/{id}/login response: the interactive tmux session running the agent's loginCommand,
// which the web surfaces in the terminal panel for the user to complete the sign-in.
export const CapabilityLoginSchema = z.object({ session: z.string() });

// ---- hosts: the user's own connected computers (the `host` capability's live half) ----
// The manifest says which machines the user INTENDS to have connected; this says which are actually holding a
// socket right now. Nothing here is remembered across a daemon restart except the enrollment itself: a machine
// is "online" exactly while its WebSocket is attached, so a laptop that closed its lid reads as offline within
// a heartbeat rather than staying green until someone asks it to do something.

// What a machine reports about itself once, at connect (the agent's own `host.describe`, cached until it
// reconnects). It is the difference between an agent guessing what is on the box and knowing: the SKILL pack
// tells it HOW to drive Windows, this tells it WHICH Windows this is.
export const HostFactsSchema = z.object({
    // The OS's own name for itself — "Windows 11 Pro 24H2", "Ubuntu 24.04.1 LTS".
    os: z.string(),
    arch: z.string(),
    // The shell run_command actually spawns, so the agent writes for the right one from its first command.
    shell: z.string(),
    // The machine's home directory, and the default root when the capability declares none.
    home: z.string(),
    // Roots in force right now (the capability's `roots`, or [home]) — the agent sees its own boundary.
    roots: z.array(z.string()),
});
export type HostFacts = z.infer<typeof HostFactsSchema>;

export const HostSummarySchema = z.object({
    // The capability id — the machine's name, and the prefix of its tools (mcp__<id>__run_command).
    id: z.string(),
    platform: z.string().min(1),
    online: z.boolean(),
    // The agent binary's version, so a machine running an old build is visible rather than mysteriously lacking
    // a tool. Absent until the machine has connected once.
    version: z.string().optional(),
    // Epoch ms of the last time this machine held a socket. Absent ⇒ it has not connected since this daemon
    // booted — liveness is a fact about a socket, so a restart forgets it rather than claiming stale uptime.
    lastSeen: z.number().optional(),
    facts: HostFactsSchema.optional(),
});
export type HostSummary = z.infer<typeof HostSummarySchema>;
export const HostsListSchema = z.object({ hosts: z.array(HostSummarySchema) });

// ---- vpn: live tunnel state + connect/disconnect ----
// The manifest says which VPNs EXIST; this says which are UP right now. Every field is read back from the OS
// (wg show / ip / openconnect's pidfile / swanctl), never remembered by the daemon — so a tunnel the agent
// dropped from a shell and one the UI dropped read identically, and a daemon restart loses nothing.

export const VpnStateSchema = z.enum([
    // The tunnel is up and carrying traffic.
    "connected",
    // Dialling: openconnect authenticated but the interface has no address yet, or strongSwan is negotiating.
    "connecting",
    // Configured and idle — the normal resting state for a tunnel nobody asked for.
    "disconnected",
    // The tunnel's client isn't installed yet: the capability's image fragment needs an owner-run rebuild.
    "unavailable",
    // The last dial failed; `detail` carries the client's own message.
    "failed",
]);
export type VpnState = z.infer<typeof VpnStateSchema>;

export const VpnLinkSchema = z.object({
    id: z.string(),
    provider: VpnProviderSchema,
    state: VpnStateSchema,
    // The gateway this tunnel dials — host:port for fortinet, the [Peer] endpoint for wireguard, the IKE peer
    // for ipsec. Display only; never a secret.
    gateway: z.string().optional(),
    // The tun/wg interface carrying the tunnel, once it exists.
    interface: z.string().optional(),
    // The address the gateway assigned this sandbox — the single most useful "am I on the VPN?" fact.
    address: z.string().optional(),
    // The CIDRs routed into the tunnel ("0.0.0.0/0" = full tunnel). Empty until the link is up.
    routes: z.array(z.string()).default([]),
    // DNS servers the tunnel pushed, when it pushed any.
    dns: z.array(z.string()).default([]),
    // Epoch ms the link came up — the UI renders "connected 14m ago". Absent unless connected.
    since: z.number().optional(),
    // Whether the daemon re-dials this tunnel on boot (the manifest's autoConnect).
    autoConnect: z.boolean(),
    // Why it is failed/unavailable, or an extra note on a healthy link. Never carries credentials.
    detail: z.string().optional(),
});
export type VpnLink = z.infer<typeof VpnLinkSchema>;
export const VpnListSchema = z.object({ links: z.array(VpnLinkSchema) });

// POST /vpn/{id}/connect body. `otp` is a one-time 2FA code, supplied per dial and NEVER stored — a FortiGate
// with token auth rejects the dial without it, and the daemon surfaces that as a retry-with-a-code error.
export const VpnConnectInputSchema = z.object({ id: z.string(), otp: z.string().min(1).optional() });
export const VpnIdParamSchema = z.object({ id: z.string() });

// POST /vpn/import-forticlient: parse an exported FortiClient configuration (the XML FortiClient writes from
// File → Settings → Backup) into addable connections. Credentials in that file are wrapped in FortiClient's
// proprietary "EncX …" encryption, which is NOT reversible here — so a parsed connection carries the endpoint
// and, when it was stored in the clear, the username; the password is always typed by the user afterwards.
export const ForticlientImportInputSchema = z.object({ xml: z.string().min(1) });
export const ForticlientConnectionSchema = z.object({
    // FortiClient's connection name, slugged into a legal capability id.
    id: z.string(),
    // The original <name>, shown so the user recognises the connection they picked.
    label: z.string(),
    provider: VpnProviderSchema,
    server: z.string(),
    port: z.number(),
    // Present only when FortiClient stored it unencrypted; an EncX-wrapped username is dropped, not guessed.
    username: z.string().optional(),
    description: z.string().optional(),
    // ipsec-only, and only when the file stored them in the clear.
    localId: z.string().optional(),
    aggressive: z.boolean().optional(),
    // Phase-2 settings, read from <ipsec_settings> — the pair that decides whether quick mode can succeed.
    pfs: z.boolean().optional(),
    dhGroup: z.string().optional(),
    // What the user still has to supply for this connection to dial (always at least the password).
    needs: z.array(z.string()),
});
export type ForticlientConnection = z.infer<typeof ForticlientConnectionSchema>;
export const ForticlientImportSchema = z.object({ connections: z.array(ForticlientConnectionSchema) });

// Browse an extension/plugin registry (a git repo with .claude-plugin/marketplace.json — see
// @intentic/registry for the format). POST so the optional token for a private registry never rides a URL or
// an access log.
export const MarketplaceRequestSchema = z.object({ url: z.url(), token: z.string().min(1).optional() });
// The rows are RegistryEntry — the curated decision joined to the resolved pointer and the scanner's upstream
// facts, exactly as the site's gallery renders them, so browsing in the app and browsing the web show one list.
export const MarketplaceSchema = z.object({ name: z.string(), plugins: z.array(RegistryEntrySchema) });
export type Marketplace = z.infer<typeof MarketplaceSchema>;

// ---- extensions: installed extension-kind capabilities resolved to their manifests ----
// What the web extension host boots from: each row is an extension capability whose checkout still parses —
// the approved manifest (contribution declarations), and the checked-out commit (the code identity; the bundle
// route's ETag). A rotted checkout is skipped here; its capability row still shows status.
// The routing handle: a git-installed extension uses its capability entry id; an image-baked one has no
// capability entry and is addressed by the manifest-derived publisher.name — hence the dot in the pattern.
const extensionId = z
    .string()
    .min(1)
    .max(121)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const ExtensionSummarySchema = z.object({
    id: extensionId,
    manifest: ExtensionManifestSchema,
    commit: z.string(),
    // Image-baked first-party extension (no git checkout, not removable) vs a git-installed capability — the
    // web hides the uninstall affordance for baked ones.
    builtin: z.boolean(),
    // The owner's switch (.intentic/extension-enablement.json). A disabled extension is still listed — that's
    // what makes it switchable back on — but the daemon wires none of its contributions up and the web host
    // doesn't activate it.
    enabled: z.boolean(),
});
export type ExtensionSummary = z.infer<typeof ExtensionSummarySchema>;
export const ExtensionsListSchema = z.object({ extensions: z.array(ExtensionSummarySchema) });
// The extension's contributes.settings values, persisted daemon-side (.intentic/extension-settings.json) keyed
// by the manifest-derived extension id — the checkout stays pristine, so a re-clone update never loses them.
// Secret-marked values are stripped from `settings`; `secretsSet` lists the secret keys that DO hold a value,
// so the UI renders "•••• (set)" without ever receiving the secret back.
export const ExtensionSettingsSchema = z.object({
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    secretsSet: z.array(z.string()),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
export const ExtensionSettingsInputSchema = z.object({
    id: z.string(),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
// Flip one extension on or off. Persisted by publisher.name (like settings), so the choice outlives the
// checkout; the daemon's immediate half of the flip — declared processes — converges in the same handler.
export const ExtensionEnabledInputSchema = z.object({ id: z.string(), enabled: z.boolean() });
// One declared background process (contributes.processes) — status/start/stop, addressed by the capability
// entry id + the manifest's process name. Undeclared names are NOT_FOUND, the manifest-honesty rule again.
export const ExtensionProcessParamSchema = z.object({ id: z.string(), name: z.string() });
export const ExtensionProcessStatusSchema = z.object({
    name: z.string(),
    running: z.boolean(),
    port: z.number().optional(),
    previewUrl: z.string().optional(),
});
export type ExtensionProcessStatus = z.infer<typeof ExtensionProcessStatusSchema>;

// ---- automations: scheduled agent wake-ups (.intentic/automations.json) ----
// An automation wakes the agent autonomously: the daemon's scheduler fires each enabled automation on its
// trigger, runs the optional guard command (a shell command in the workspace; non-zero exit skips the wake),
// then runs one agent turn with the prompt. The manifest is user config; run history is daemon-recorded.

// `schedule` fires on its cron; `event` fires when an external system POSTs /automations/{id}/fire?token=…
// (a plain Hono route — webhook bodies are arbitrary). The token is the webhook's own auth (senders can't do
// Google ID tokens): optional on input — the daemon generates one on upsert — and always present in stored and
// listed automations, so the owner's UI can render the copyable URL.
// `listener` fires from a realtime source's connection to the provider (an extension's gateway process holds
// it, e.g. Discord) — no cron, no token, never reachable via /fire. channelId narrows to one channel; absent ⇒
// every channel the bot can read. eventType narrows to one kind of event (a Discord message, a live voice
// utterance batch, or a finished voice transcript); absent ⇒ all event kinds the source emits. mentioned
// narrows message events to those that @mention one of the workspace's bots or reply to a bot's message;
// absent ⇒ all messages. `provider` and `eventType` are open strings — a realtime source is now extension-
// declared (contributes.listener), so the daemon validates a listener trigger at upsert against `webchat` ∪ the
// installed extensions' declared providers/eventTypes rather than a hardcoded enum here.
// `webchat` is the exception: it has no gateway. An embeddable widget POSTs a visitor's message to
// /webchat/<id>/message and the agent's reply streams back over SSE. Its address is the public automation id, so
// allowedOrigins (the widget's embed sites) + a per-conversation rate limit are its abuse boundary — no secret
// token can live in a browser.
// `ci` is the other gateway-less source: the daemon's own pipeline receiver (ci/events.ts) dispatches it from a
// provider webhook, or from the REST poller on a sandbox whose hooks could not be registered. Its channelId is
// the workspace repo, and `branch` is its SECOND narrowing axis — a fleet pushes a branch per agent, so a
// pipeline trigger that can only say "this repo" says "every agent's every failure".
// `workspace` fires from the sandbox's OWN codebase instead of the outside world — see WorkspaceEventKindSchema.

// What the daemon emits as the fleet works, and what a `workspace` trigger names. These are the events a code
// CHORE runs on (continuous review, post-land checks): the daemon is both producer and consumer, so unlike
// `event` there is no token and no route — nothing outside the sandbox can reach them.
//
// The two OVERLAP on the common path: a clean turn auto-lands, firing both. A chore should name exactly one.
// `turn.settled` fires once per isolated turn whatever its outcome, so it also covers the errored and
// conflicted turns most worth a second pair of eyes, and it fires while the user is still looking at the diff —
// before they decide to land. `agent.landed` fires only when work actually reached the main tree, including an
// explicit Land from the review panel long after the turn ended.
export const WorkspaceEventKindSchema = z.enum(["turn.settled", "agent.landed"]);
export type WorkspaceEventKind = z.infer<typeof WorkspaceEventKindSchema>;

// The payload a workspace-triggered wake carries: one JSON object, in $AUTOMATION_PAYLOAD for the guard and
// appended to the prompt for the turn.
//
// `repos` names the change to look at as an OPEN span — `git -C <dir> diff <from>`, with no upper bound. Each
// `from` is where that repo stood before the turn (its last landed tip, or the base it branched from); the
// other end is deliberately the working tree rather than a sha, because a turn that ERRORED left its work
// uncommitted in the worktree and a commit-to-commit span would report it as nothing at all. `dir` is that
// repo's dir inside the agent's own checkout, so a chore reads the agent's work without touching /work.
//
// No diffstat rides along on purpose: the registry's counts are refreshed at land, so an errored or conflicted
// turn would carry stale numbers, and a guard that wants a size threshold gets the true one from
// `git -C <dir> diff --numstat <from>` for the price of one spawn.
export const WorkspaceEventSchema = z.object({
    event: WorkspaceEventKindSchema,
    agentId: z.string(),
    title: z.string().optional(),
    branch: z.string(),
    // `ready` is a clean turn whose delta was HELD on the branch (auto-land off) — for a chore, the moment
    // before the user's deliberate Land, which is exactly when a pre-land review wants to run.
    outcome: z.enum(["landed", "conflict", "ready", "idle", "error"]),
    repos: z.array(z.object({ repo: z.string(), from: z.string(), dir: z.string() })),
});
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;

export const TriggerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("schedule"), cron: z.string().min(1) }),
    z.object({ kind: z.literal("event"), token: z.string().min(1).optional() }),
    z.object({
        kind: z.literal("listener"),
        provider: z.string().min(1),
        channelId: z.string().min(1).optional(),
        eventType: z.string().min(1).optional(),
        mentioned: z.boolean().optional(),
        // ci only: the git ref the pipeline ran on. Absent ⇒ every branch of the matched repos.
        branch: z.string().min(1).optional(),
        // webchat only: the website origins allowed to POST to the widget endpoint. Absent/empty ⇒ none admitted.
        allowedOrigins: z.array(z.string()).optional(),
    }),
    // `repo` narrows to events whose span touches one workspace repo ("root" or a repo id); absent ⇒ any.
    z.object({ kind: z.literal("workspace"), event: WorkspaceEventKindSchema, repo: z.string().min(1).optional() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

/* The Doorbell widget's settings — everything about the embeddable chat that isn't the automation's prompt.
 * Present only on `webchat` listener automations; the trigger keeps `allowedOrigins` because that one is the
 * admission gate the message route reads, not a rendering choice.
 *
 * Split deliberately into what the WIDGET may read (title/greeting/accent/position/access/googleClientId/
 * turnstileSiteKey — all public by construction, they ship to a stranger's browser) and what only the daemon
 * may read (turnstileSecret). GET /webchat/<id>/config serves the first group by naming it, never by omitting
 * the second: a field added here is invisible to the widget until it is listed there. */
export const WebchatConfigSchema = z.object({
    // `public` admits anyone; `google` refuses a message that carries no verifiable Google ID token. Absent ⇒
    // public — a Doorbell with no access setting is the anonymous support box it looks like.
    access: z.enum(["public", "google"]).optional(),
    // Ask an anonymous visitor for a display name before the first message. Cosmetic: the name is typed, so it
    // reaches the model as untrusted `displayName`, never as identity.
    requireName: z.boolean().optional(),
    /* The bot ceiling. `turnstile` is Cloudflare's (invisible, needs the site's own keys); `pow` is a
     * hashcash-style challenge the daemon issues and the widget solves in a worker, so a site with no
     * Cloudflare account still has something. Absent ⇒ off: the origin allowlist and the rate limit are then
     * the whole boundary, which is the right default for an internal or invite-only page. */
    antiBot: z.enum(["turnstile", "pow"]).optional(),
    turnstileSiteKey: z.string().optional(),
    turnstileSecret: z.string().optional(),
    // The site's OWN Google OAuth web client id. It cannot be intentic's: Google Identity Services only issues
    // a token to an authorized JavaScript origin, and intentic's client can't list every customer domain.
    googleClientId: z.string().optional(),
    /* Widget chrome. `position` picks the launcher corner.
     *
     * `accent` is a HEX colour, not any CSS colour, because the widget derives values from its channels rather
     * than just painting it: a glyph step for the scheme, a 14% wash for the send button, a bubble edge, a focus
     * ring, and the label that goes on top (see webchat-widget's styles.ts). A colour we cannot read is a widget
     * with half its accent silently missing, so the unreadable case is rejected here instead. */
    title: z.string().max(80).optional(),
    greeting: z.string().max(500).optional(),
    accent: z
        .string()
        .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "accent must be a hex colour, e.g. #e47100")
        .optional(),
    position: z.enum(["top-right", "top-left", "bottom-right", "bottom-left"]).optional(),
    /* Two ceilings on top of the route's fixed per-minute window, because a public endpoint's real exposure is
     * cost, not request rate: `dailyMessageMax` caps the whole automation per UTC day, `conversationMessageMax`
     * caps one visitor thread for its lifetime.
     *
     * `dailyMessageMax` absent ⇒ WEBCHAT_DAILY_MAX_DEFAULT, not uncapped. Every message here is an agent turn
     * billed to the owner, and the per-minute window bounds the RATE without bounding the DAY — twenty a minute,
     * sustained, is tens of thousands of turns before anyone notices. A Doorbell nobody configured should not be
     * able to spend that, so the safe number is the one you get for free and the owner raises it deliberately.
     * `conversationMessageMax` stays optional-means-uncapped: it is per visitor thread, which the daily ceiling
     * already bounds in aggregate. */
    dailyMessageMax: z.number().int().positive().optional(),
    conversationMessageMax: z.number().int().positive().optional(),
    // (WEBCHAT_DAILY_MAX_DEFAULT, below the schema, is the number `dailyMessageMax` falls back to.)
    // How long a visitor thread keeps resuming the same conversation before the next message starts a fresh
    // one. Absent ⇒ WEBCHAT_SESSION_TTL_MS (the daemon's default).
    sessionTtlMinutes: z.number().int().positive().optional(),
});
export type WebchatConfig = z.infer<typeof WebchatConfigSchema>;

/* The daily agent-turn ceiling a Doorbell gets when its owner sets none. Lives here rather than beside the
 * route that enforces it because both ends need the number: the daemon to apply it, and the automation editor
 * to show the owner what they are already protected by (an invisible limit is one people hit and file as a bug).
 *
 * 200 is chosen to be irrelevant to real support traffic and decisive against a script. A Doorbell answering
 * two hundred questions in one UTC day is a busy one; a scripted flood reaches that in ten seconds and then
 * stops costing anything. */
export const WEBCHAT_DAILY_MAX_DEFAULT = 200;

/* ---- the widget wire: three shapes GET /webchat/<id>/config, GET …/challenge and POST …/message speak ----
 *
 * They live here, beside the stored config they derive from, because the Doorbell widget is a SECOND client of
 * this daemon — a bundle running on a stranger's page — and the reason this package exists is that both ends of
 * a wire read one definition. The widget imports these as types only (`import type`), so zod never reaches a
 * visitor's browser. */

// What the widget is told about itself. Fully RESOLVED — every default is applied daemon-side, so the widget
// carries no fallback logic and one place decides what an unset field means. Everything here is public by
// construction: it ships to any browser that can reach the endpoint from an allowed origin.
export const WebchatPublicConfigSchema = z.object({
    automationId: z.string(),
    title: z.string(),
    greeting: z.string(),
    accent: z.string(),
    position: z.enum(["top-right", "top-left", "bottom-right", "bottom-left"]),
    access: z.enum(["public", "google"]),
    requireName: z.boolean(),
    // "off" is spelled out rather than left absent: the widget branches on this, and a missing field that means
    // "no challenge" is the kind of default that turns one serialization bug into an open door.
    antiBot: z.enum(["turnstile", "pow", "off"]),
    turnstileSiteKey: z.string().optional(),
    googleClientId: z.string().optional(),
});
export type WebchatPublicConfig = z.infer<typeof WebchatPublicConfigSchema>;

// A proof-of-work challenge: find a nonce whose SHA-256 of `${salt}:${nonce}` starts with `difficulty` zero
// bits. Issued per visitor conversation, spent on its first message.
export const WebchatChallengeSchema = z.object({ salt: z.string(), difficulty: z.number().int().positive() });
export type WebchatChallenge = z.infer<typeof WebchatChallengeSchema>;

// One visitor message. `conversationId` is the widget's own localStorage id — it threads the visitor's messages
// into ONE sandbox conversation, so it is the thread key, not a secret (anyone can mint one; the origin
// allowlist, the challenge and the rate limit are the gate).
export const WebchatMessageSchema = z.object({
    conversationId: z.string().min(1).max(200),
    content: z.string().min(1),
    // What the visitor TYPED as their name. Never identity — it reaches the model tagged as unverified, and a
    // signed-in visitor's verified name comes from the ID token instead.
    displayName: z.string().max(200).optional(),
    // A Google ID token from the site's own client id, verified daemon-side against Google's JWKS.
    idToken: z.string().optional(),
    // The anti-bot answer, whichever kind the config asked for. Checked once per conversation, not per message.
    turnstileToken: z.string().optional(),
    powNonce: z.string().optional(),
    // The widget's own transcript, sent ONLY on the first message of a thread — after that the sandbox
    // conversation resumes and carries its own context.
    history: z
        .array(z.object({ author: z.string().optional(), content: z.string() }))
        .max(50)
        .optional(),
});
export type WebchatMessage = z.infer<typeof WebchatMessageSchema>;

export const AutomationSchema = z.object({
    id: entryId,
    trigger: TriggerSchema,
    // Shell command run in the workspace root before waking; exit 0 ⇒ wake, non-zero ⇒ the run is "skipped".
    guard: z.string().min(1).optional(),
    prompt: z.string().min(1),
    // The Doorbell widget's settings — `webchat` listener automations only, ignored on every other trigger.
    webchat: WebchatConfigSchema.optional(),
    // The tool names this automation's wake may call (AgentTurnSchema.allowedTools). The reason it exists: a
    // webchat automation is driven by strangers, and an automation turn runs bypassPermissions by default — so
    // the allowlist, not the prompt's wording, is what bounds what an injected instruction can reach.
    allowedTools: z.array(z.string().min(1)).optional(),
    // Which provider adapter serves the wake; absent ⇒ claude. Same dispatch as a chat turn (AgentTurnSchema.agent).
    agent: AgentProviderSchema.optional(),
    /* Which connected account of that provider serves the wake; absent ⇒ the provider's first account, exactly
     * as for a chat turn (AgentTurnSchema.account).
     *
     * An automation needs this more than a chat does, and for a reason a chat never meets: nobody is watching.
     * A sandbox holds several accounts side by side, and when the first one is out of headroom — or belongs to
     * an organization that has disabled the plan — every fire of every automation errors against it until a
     * human happens to read the row. Pinning the wake to an account that can actually run is the difference
     * between "my nightly sweep is quiet" and a Doorbell that turns visitors away all day. */
    account: z.string().optional(),
    // Which harness (agentic loop) runs the wake; absent ⇒ native. Same semantics as AgentTurnSchema.harness.
    harness: AgentHarnessSchema.optional(),
    // Which model the wake runs on (see agent-catalog.ts modelsFor); absent ⇒ the provider's default.
    model: z.string().optional(),
    // When true, a fire doesn't wake the agent — it's held in the approvals queue until the owner approves.
    requireApproval: z.boolean().optional(),
    // A code CHORE: maintenance of THIS codebase rather than a reaction to the outside world. Purely a
    // classification — the daemon fires a chore exactly like any other automation — but it cannot be derived
    // from the trigger, which is why it is stored: a nightly `pnpm audit` sweep and a nightly Stripe poll are
    // both `schedule`, and belong on different shelves. Absent ⇒ an ordinary automation.
    chore: z.boolean().optional(),
    enabled: z.boolean(),
});
export type Automation = z.infer<typeof AutomationSchema>;

// A wake held for owner approval (.intentic/approvals/<id>.json, one file per held wake). It snapshots the
// trigger payload so an approved run replays exactly what fired, even across a daemon restart. The id is minted
// by the daemon (an entryId-safe filename).
export const AutomationApprovalSchema = z.object({
    id: entryId,
    automationId: z.string(),
    // The event/listener payload the wake would have carried; absent for schedule triggers.
    payload: z.string().optional(),
    // The provenance + title the held wake would have opened its conversation with — snapshotted alongside the
    // payload so an approved external wake surfaces on the fleet exactly as an auto one would have.
    origin: AgentOriginSchema.optional(),
    title: z.string().optional(),
    /* The CONTINUING THREAD this wake belonged to, when it had one — the conversation the dispatcher had
     * already opened for it and the provider session that conversation last ran on.
     *
     * Snapshotted for the same reason the payload is, and it is the half that was missing: without it an
     * approved wake fell through to minting a fresh conversation, so a Doorbell visitor's chat became one card
     * per approved message instead of the single thread the dispatcher had opened for them — a second worktree
     * each time, and an agent that met the visitor again on every turn. Absent for a schedule or a webhook,
     * which own no thread. */
    conversationId: z.string().optional(),
    sessionId: z.string().optional(),
    createdAt: z.number(),
});
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;
export const AutomationApprovalsListSchema = z.object({ approvals: z.array(AutomationApprovalSchema) });
export const AutomationApprovalIdParamSchema = z.object({ id: z.string() });

export const AutomationRunSchema = z.object({
    at: z.number(),
    // skipped = the guard said no; error = the guard passed but the agent turn surfaced an error; interrupted =
    // the daemon died mid-wake, so the run reached no outcome of its own (see agent/turn-journal.ts). Without
    // that last one an interrupted fire records NOTHING and simply vanishes from the row's history, which reads
    // as "it never fired" — the one reading a 3 a.m. automation must not be given.
    outcome: z.enum(["completed", "skipped", "error", "interrupted"]),
    detail: z.string().optional(),
    // The stable conversation opened by the wake, so the row can open the provider-neutral agent transcript.
    // Absent only for a run skipped before a conversation was needed.
    conversationId: z.string().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

// The list row: the stored automation + its recent runs + the next scheduled fire (absent when disabled).
export const AutomationSummarySchema = AutomationSchema.extend({
    runs: z.array(AutomationRunSchema),
    nextRun: z.number().optional(),
});
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export const AutomationsListSchema = z.object({ automations: z.array(AutomationSummarySchema) });
export const AutomationIdParamSchema = z.object({ id: z.string() });

// ---- workflows: a designed graph of sessions ----
/* THE THIRD DRIVER. An automation answers "run this at 3am", a loop answers "run this until it is done", and a
 * workflow answers "run these, in this order, each handing its result to the next".
 *
 * IT IS A GRAPH OF LOOPS, and that is the whole implementation. A step is not a new kind of execution — it is
 * a Loop with a declared output and a place in a dependency graph, driven on a conversation of its own. So
 * every step gets the fleet card, the worktree, the transcript, the cost ledger, the Stop button, the stall
 * detector and the spend ceiling without a line of new code, and this file's job is only to say what the steps
 * are and what depends on what.
 *
 * WHY IT IS NOT "AN AUTOMATION WITH SEVERAL PROMPTS". Because the value is in the SEAM between steps: the
 * output of one is validated before the next is allowed to start, the reviewing step is a different session
 * from the implementing one, and a step that cannot converge stops the branch below it rather than feeding
 * garbage forward. None of that exists in a prompt that says "then do X".
 */

// A step id: short and slug-shaped because it is spliced into the derived conversation id (`wf-<run>-<step>`),
// which is itself a branch name and a directory name. The regex is the injection guard, the length cap is what
// keeps the derived id inside ConversationIdSchema's 64.
const StepIdSchema = z
    .string()
    .min(1)
    .max(24)
    .regex(/^[a-z0-9][a-z0-9-]*$/);

/* HOW A STEP MEETS ITS PREDECESSOR — the fork the whole feature turns on, and the one the user has to choose
 * because neither answer is right twice in a row.
 *
 * `fresh` opens a NEW conversation: its own fleet card, its own session, its own worktree when the run is
 * isolated. What it knows about the step before it is exactly what that step declared as output. This is the
 * only honest way to run a review, an audit or a second opinion — a session that spent nine turns arguing for
 * an approach is the worst available judge of whether that approach worked, and the fix is not a better prompt,
 * it is a different session.
 *
 * `continue` sends the next prompt into the SAME conversation. The model keeps everything it learned, the
 * prefix stays cached, and — when the run is isolated — the work stays in one worktree on one branch, which is
 * the only way a chain like implement → test → document can build on itself at all. Requires exactly one
 * predecessor: two upstream sessions cannot both be continued into one.
 */
export const WorkflowHandoffSchema = z.enum(["fresh", "continue"]);
export type WorkflowHandoff = z.infer<typeof WorkflowHandoffSchema>;

// Enough steps for a real pipeline, few enough that a workflow stays legible as one picture. A design past
// this is two workflows, and reading it as one graph was never going to work.
const WORKFLOW_STEPS_MAX = 24;

export const WorkflowStepSchema = z.object({
    id: StepIdSchema,
    // What the node says on the graph. Short — the prompt is where the detail goes.
    title: z.string().min(1).max(60),
    /* What "done" means for this step, in the user's words. Restated in every iteration's prompt and put to the
     * judge; it is the sentence the step is measured against.
     *
     * ABSENT ⇒ THE RUN'S OWN REQUEST IS THE GOAL, which is the ordinary case and not the exotic one. A saved
     * workflow is a SHAPE — "two models on one task" — and for most of its steps the thing being asked for is
     * whatever the person typed this time. Writing a goal here as well means saying the same thing twice and
     * keeping the two in agreement forever; leaving it out means the step is measured against the request,
     * which is what anyone would have written anyway. Declare one only where the step's bar is genuinely its
     * own ("the suite is green") rather than the run's.
     */
    goal: z.string().min(1).optional(),
    /* What the step is told to DO. A different sentence from the goal: "the suite is green" is the goal,
     * "run the tests, take the top failure, fix it" is the instruction.
     *
     * ABSENT ⇒ THE REQUEST IS HANDED OVER VERBATIM, with none of the workflow's own framing around it (see
     * briefForStep). That is the default because the framing is not free: every heading between the reader's
     * sentence and the model is a chance for the model to answer the frame instead of the question, and a step
     * whose whole job is "do what was asked" has nothing to add to it. A step that DOES declare a prompt is
     * saying it has a job of its own — review this, merge those — and gets the full brief, request included.
     */
    prompt: z.string().min(1).optional(),
    // The steps that must finish before this one starts. Empty ⇒ a root, started when the run starts. The
    // graph must be acyclic and every id must exist; both are checked when the workflow is saved.
    needs: z.array(StepIdSchema),
    handoff: WorkflowHandoffSchema,
    output: LoopOutputSchema,
    checks: z.array(LoopCheckSchema),
    // How the step's own ITERATIONS meet each other — the Ralph question, one level down from `handoff`. A
    // long-running step wants `fresh` (no context rot); a short refine-this step wants `continue`.
    context: LoopContextSchema,
    /* NO CEILINGS HERE, and their absence is the design. A step used to declare its own iteration cap, idle-round
     * cap and dollar cap — three numbers to answer before a workflow would run, on a page that already asks for
     * a prompt and a goal. Nobody has a considered answer to "how many rounds", and a wrong guess is a step
     * that gives up mid-job. A step now runs the way any agent session in this product runs: until it is done
     * or until you stop it. The loop underneath keeps a runaway backstop of its own (WORKFLOW_STEP_ROUNDS in
     * the scheduler) — a backstop is not a setting, and it is not something a user should have to think about.
     */
    agent: AgentProviderSchema.optional(),
    harness: AgentHarnessSchema.optional(),
    model: z.string().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/* THE GATE — how a finished run becomes a release decision, and how a machine with no identity asks for one.
 *
 * A workflow is a DESIGN; a gate is a PROMISE ABOUT ITS RESULT, and keeping the two separable is the whole
 * point. What a run does — how many sessions, whether they drive a browser, which repos they touch — stays the
 * graph's business, because the value of running a release check this way is that the check is a workflow like
 * any other: an acceptance sweep today, a security review or a performance budget next month, with nothing
 * here ever learning what any of them are.
 *
 * So a gate reads exactly one thing: a named FIELD off a named STEP's declared output (output-fields.ts). That
 * field already exists for precisely the reason this needs it — a declared field is the one part of a session's
 * answer that was VALIDATED rather than parsed back out of the prose the model was talking to a person in —
 * and pointing at one is the entire rule.
 */
export const WorkflowGateSchema = z.object({
    // Which step's declared output carries the decision. Ordinarily a leaf that weighs up the steps before it;
    // nothing requires that, and a one-step workflow naming its only step is the common small case.
    step: StepIdSchema,
    // Which of that step's declared fields is read. Checked against what the step actually declares when the
    // workflow is saved — a gate pointed at a field nobody writes answers `blocked` on every run, forever.
    field: z.string().min(1),
    /* The values of that field that mean SHIP IT. Everything else fails the gate.
     *
     * An allowlist rather than a blocklist, because the two are not symmetric under a model's vocabulary. A
     * step that answers "mostly-pass", "pass-with-notes" or "pass (2 minor defects)" must not ship, and the
     * allowlist gets that right without anyone having had to enumerate the ways a model can hedge.
     */
    pass: z.array(z.string().min(1)).min(1),
    // The webhook's own auth, minted on save exactly as an event automation's is. The caller is a pipeline
    // runner with no Google identity, so this is the only credential in the exchange.
    token: z.string().optional(),
    /* Runs per UTC day, across every caller. A gate is a paid endpoint reachable with no person in the loop:
     * one of these wired into a push-triggered pipeline is a fan-out of sessions per commit, and the
     * per-request deadline bounds one call's WALL CLOCK without bounding the day's SPEND. Absent ⇒
     * GATE_DAILY_MAX_DEFAULT, not uncapped, for the reason the Doorbell's ceiling is not optional either.
     */
    dailyMax: z.number().int().positive().optional(),
});
export type WorkflowGate = z.infer<typeof WorkflowGateSchema>;

/* The gate's daily ceiling when its author sets none. Deliberately small next to the Doorbell's 200: a
 * Doorbell message is one turn, a gate run is a whole graph of sessions, and the honest comparison is cost
 * rather than count. Twenty is a busy day of merges and a script's first minute. */
export const GATE_DAILY_MAX_DEFAULT = 20;

/* What a gate answers a pipeline, and the three-way split is load-bearing.
 *
 * `blocked` exists for the same reason acceptance's verdict has one: "we could not reach a judgment" is not
 * "the product is broken". A gate that reported them the same way would go red for its own outages, and a team
 * that cannot tell the two apart turns the gate off — so `blocked` is meant to be the honest answer far more
 * often than it is the convenient one. It maps to a NEUTRAL pipeline exit, never a failed build.
 */
export const GateOutcomeSchema = z.enum(["pass", "fail", "blocked"]);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

// What the gate route answers with. `value` is the field as the step actually wrote it, absent when the gate
// never got one to read — which is every `blocked` that is not a disagreement about the value.
export const GateVerdictSchema = z.object({
    outcome: GateOutcomeSchema,
    // One line: why. Realistically the only part of this a pipeline log will ever show.
    reason: z.string(),
    runId: z.string(),
    value: z.string().optional(),
});
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export const WorkflowSchema = z.object({
    id: entryId,
    name: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    steps: z.array(WorkflowStepSchema).min(1).max(WORKFLOW_STEPS_MAX),
    // Present ⇒ this design can be run by a machine and answers a release decision. Absent ⇒ an ordinary
    // workflow, started by a person from the workflows page, with no public door onto it at all.
    gate: WorkflowGateSchema.optional(),
    /* EVERY STEP RUNS IN ITS OWN WORKTREE, always, with no toggle — the same thing an isolated agent session
     * does, which is what every session in this product already is.
     *
     * It was a per-workflow choice between worktrees and the shared /work tree, and the shared side never
     * earned its place: parallel steps on one tree collide, a `fresh` step there sees a half-finished
     * predecessor's edits as if they were the workspace, and the branch names that make a fan-in READABLE
     * (`git diff main...<branch>` — see workflow-brief) only exist on the isolated side. A setting whose other
     * value is a subtle trap is not a setting, it is a mistake waiting for somebody to make it.
     */
    // How many steps may run at once. Bounded because a fan-out of twelve is twelve provider sessions, twelve
    // worktrees and twelve times the burn rate — and because the machine this runs on is one machine.
    maxParallel: z.number().int().min(1).max(8),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// The rules a graph has to clear before it can be saved or run — the acyclic `needs`, the once-only
// continuation — are in workflow-faults.ts, because they are about the graph rather than about any field here.

/* How one step ended. `skipped` is the one that carries information the others cannot: it means the step never
 * ran because something it waited for did not finish, which is why a failed workflow shows one red node and a
 * trail of grey ones rather than a wall of failures that all say the same thing.
 */
export const WorkflowStepStateSchema = z.enum(["pending", "running", "done", "failed", "skipped", "stopped"]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

export const WorkflowStepRunSchema = z.object({
    stepId: StepIdSchema,
    state: WorkflowStepStateSchema,
    // The conversation this step ran on — derived, and the door from a node on the graph to a real transcript.
    // Shared with the predecessor when the handoff is `continue`, which is what makes those steps one card.
    conversationId: z.string(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
    iterations: z.number().int().min(0),
    costUsd: z.number().optional(),
    // How the step's LOOP ended — `exhausted` and `stalled` both land as a `failed` step, and the difference
    // between them is the difference between "give it more room" and "more room will not help".
    loopState: LoopStateSchema.optional(),
    detail: z.string().optional(),
    // What the step produced. Present once the step has written a valid document, which for a `json` output
    // means it matched the declared fields. This is what the steps downstream are given.
    document: LoopDocumentSchema.optional(),
    /* The step's closing words, truncated. Two jobs, and it would be stored for either: it is the only output a
     * `none` step has, and it is what a resumed run hands forward for a step that finished before the daemon
     * died — without it, resuming would either re-run finished work or feed the next step a blank. */
    report: z.string().optional(),
});
export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;

// `done` means every step that ran finished; a run with skipped steps is `failed`, because a graph that did not
// reach its leaves did not do what it was asked whatever the survivors managed.
export const WorkflowRunStateSchema = z.enum(["running", "done", "failed", "stopped", "overspent", "error"]);
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;

export const WorkflowRunSchema = z.object({
    runId: z.string().min(1),
    /* The workflow AS IT WAS WHEN THE RUN STARTED, snapshotted rather than referenced. Three things need this
     * and none of them tolerate a live lookup: the run view draws the graph the run actually ran (not the one
     * that has been edited twice since), the boot resume needs the step definitions of a workflow that may have
     * been deleted, and a history row for a deleted workflow is otherwise an id and nothing else. */
    workflow: WorkflowSchema,
    /* WHAT THIS RUN WAS ASKED TO DO — the sentence the user typed when they started it, handed to every step
     * on top of its own prompt. Absent for a run started from the workflows page, which has no composer.
     *
     * It is what makes one saved design worth keeping: "two models, one task" is a SHAPE, and the task is
     * different every time. Without this the only way to point a workflow at today's job is to open the
     * designer and retype a step's prompt, which means the design and the request are the same document —
     * and editing a graph to ask a question is not something anybody does twice.
     *
     * Snapshotted on the run beside the workflow, and for the same reason: the run has to stay readable, and
     * "what was this one about" is the first thing anyone asks of a row in the history.
     */
    request: z.string().optional(),
    state: WorkflowRunStateSchema,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    // How many daemon boots have picked this run back up — the same counter, and the same reason, as a loop's.
    resumed: z.number().int().min(0),
    detail: z.string().optional(),
    // One entry per step, in the workflow's own order. Written at start with every step `pending`, so the graph
    // is complete from the first frame and a node's absence never has to mean two things.
    steps: z.array(WorkflowStepRunSchema),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// The list row: the stored workflow plus the runs it has had, newest first.
export const WorkflowSummarySchema = WorkflowSchema.extend({ runs: z.array(WorkflowRunSchema) });
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

export const WorkflowsListSchema = z.object({ workflows: z.array(WorkflowSummarySchema) });
export const WorkflowRunsListSchema = z.object({ runs: z.array(WorkflowRunSchema) });
export const WorkflowIdParamSchema = z.object({ id: z.string() });
export const WorkflowRunIdParamSchema = z.object({ runId: z.string() });
/* Starting a run: which design, and what to point it at. The request is optional because the workflows page
 * starts runs with no composer to read one from — a design whose steps already say what they want is complete
 * on its own, and only a design written as a shape needs today's sentence. */
export const WorkflowRunStartSchema = WorkflowIdParamSchema.extend({ request: z.string().min(1).max(20_000).optional() });

// ---- ci: pipeline runs on the workspace repos' github/gitlab remotes ----
// The daemon maps each workspace repo to the CI project behind its remote (a connected github/gitlab
// capability supplies the token), registers a webhook so completed pipelines dispatch `ci` listener
// automations instantly, and serves the Pipelines rail view from a webhook-freshened cache backfilled over the
// same REST clients. `host` names WHICH provider API serves a repo; the listener provider is always `ci` — one
// automation covers both hosts because the repo, not the vendor, is what a trigger narrows to.

export const CiHostSchema = z.enum(["github", "gitlab"]);
export type CiHost = z.infer<typeof CiHostSchema>;

// Terminal-or-not over both vendors' vocabularies: github's status+conclusion pair and gitlab's single status
// both collapse onto these five. `running` covers everything non-terminal (queued, manual, preparing …) — the
// view only needs "still moving" vs the three ways it stopped.
export const PipelineStatusSchema = z.enum(["running", "success", "failed", "canceled", "skipped"]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const PipelineRunSchema = z.object({
    // The workspace repo dir (the panels `repo` convention) — the join key back to the tree and to triggers.
    repo: z.string(),
    host: CiHostSchema,
    // owner/name (github) or the full project path (gitlab).
    project: z.string(),
    // The vendor's numeric run/pipeline id — what rerun/cancel address.
    runId: z.number(),
    // The run's headline: github's display_title (the commit subject, or the PR title when a PR triggered it),
    // gitlab's pipeline name or the head commit's subject. Absent ⇒ the view falls back to ref@sha.
    title: z.string().optional(),
    // Who the vendor credits for the run — the actor who set it off, matching what both vendors' own UIs
    // show. The avatar is a vendor-hosted URL; absent ⇒ the view draws the author's initials instead.
    authorName: z.string().optional(),
    authorAvatarUrl: z.string().optional(),
    // What set the run off, in the vendor's own vocabulary: gitlab's pipeline `source` (push, schedule,
    // merge_request_event, web, api, trigger…) or github's `event` (push, pull_request, schedule,
    // workflow_dispatch…). Left raw rather than flattened into a shared enum — the vendor's word is the
    // precise one, and the view only calls it out when it isn't the everyday push.
    trigger: z.string().optional(),
    branch: z.string(),
    sha: z.string(),
    status: PipelineStatusSchema,
    // The vendor's run page — the deep link out.
    url: z.string(),
    createdAt: z.number(),
    durationSeconds: z.number().optional(),
    // Names of the failed jobs — fetched only for failed runs (one extra call), so a wake or a view names what broke.
    failedJobs: z.array(z.string()).optional(),
});
export type PipelineRun = z.infer<typeof PipelineRunSchema>;

// One job inside a pipeline run. The view fetches these lazily (one extra call per visible run) so the list
// endpoint stays cheap. Both GitHub Actions jobs and GitLab CI jobs normalize onto these fields.
// `stage` is GitLab's native sequential grouping and is absent on GitHub — the Actions jobs API exposes no
// `stage` and no `needs`, so the view instead layers GitHub jobs into execution waves off the timestamps
// below (overlapping runtimes ⇒ ran in parallel). Both are epoch ms; absent while a job is still queued.
export const PipelineJobSchema = z.object({
    name: z.string(),
    status: PipelineStatusSchema,
    stage: z.string().optional(),
    startedAt: z.number().optional(),
    finishedAt: z.number().optional(),
    durationSeconds: z.number().optional(),
    // The job's page on its host — the shortest path from "this step failed" to the log that says why.
    webUrl: z.string().optional(),
});
export type PipelineJob = z.infer<typeof PipelineJobSchema>;

export const CiJobsResponseSchema = z.object({
    jobs: z.array(PipelineJobSchema),
});
export type CiJobsResponse = z.infer<typeof CiJobsResponseSchema>;

// One mapped repo's CI wiring state. `hookWarning` is the manual-setup story when webhook registration was
// refused (token scope, role) or impossible (no public URL): what happened plus the target URL + secret to
// paste into the repo's webhook settings — the git-access sshRegistrationWarning pattern.
export const CiRepoSchema = z.object({
    repo: z.string(),
    host: CiHostSchema,
    project: z.string(),
    // The project's home page on its host.
    url: z.string(),
    hookWarning: z.string().optional(),
});
export type CiRepo = z.infer<typeof CiRepoSchema>;

/* How often the daemon polls a repo whose webhook could NOT be registered (ci/poller.ts) — the fallback that
 * keeps a `ci` automation firing on a sandbox with no public URL or a token without hook scope.
 *
 * Here rather than beside the poller because both ends need the number: the daemon to run on it, and the
 * automation editor to tell the owner what a `hookWarning` actually costs them. "Webhooks are off" is a fact
 * about infrastructure; "this fires within two minutes instead of instantly" is the answer to the question
 * they were really asking. */
export const CI_POLL_INTERVAL_MS = 2 * 60_000;

export const CiRunsResponseSchema = z.object({
    repos: z.array(CiRepoSchema),
    // Newest first, across all mapped repos.
    runs: z.array(PipelineRunSchema),
    // When the owner last opened the pipelines view. Rides the runs response so the rail can decide what is
    // NEW without a second call — a breakage older than this has already been seen and must not badge again.
    // Absent ⇒ never opened, so everything counts as unseen.
    seenAt: z.number().optional(),
});
export type CiRunsResponse = z.infer<typeof CiRunsResponseSchema>;

// Stamping the view as read hands back the timestamp it wrote, so the client updates without a refetch.
export const CiSeenResponseSchema = z.object({ seenAt: z.number() });
export type CiSeenResponse = z.infer<typeof CiSeenResponseSchema>;

// rerun/cancel/fix address a run by repo + vendor id; the daemon re-resolves repo → project + token per call,
// so a stale card can't act on a project the workspace no longer maps to.
export const CiRunParamSchema = z.object({ repo: z.string(), runId: z.number() });
export type CiRunParam = z.infer<typeof CiRunParamSchema>;

// The fix route opens an isolated conversation (fleet card + chat tab) seeded with the failure context.
export const CiFixResponseSchema = z.object({ conversationId: z.string() });
export type CiFixResponse = z.infer<typeof CiFixResponseSchema>;

/* ---- Komodo deployments: the Deployments rail view's wire shape ----
 *
 * The daemon does the VENDOR translation (Komodo's tagged unions and enums → the flat shapes below); the
 * extension does the ATTENTION model on top of them (which alerts are incidents, which have been seen, what
 * the rail says). Same split as CI, and for the same reason: what a breakage MEANS is a UI decision that has
 * to be unit-testable without a daemon, while what Komodo's `ContainerStateChange` variant looks like is a
 * detail no view should ever learn.
 *
 * Routes are per-connection (`/komodo/{capability}/…`): a sandbox can hold two Komodo capabilities, and the
 * credential the daemon resolves per call is the one the path names. The browser never holds either half of
 * the API key — that is the whole reason these routes exist rather than the view calling Komodo directly. */

// Every Komodo container state (DeploymentState ∪ StackState — eleven words between them) collapsed onto the
// five a view can tone. `stopped` swallows exited/stopped/paused/created/down/not_deployed on purpose: being
// down is a LEVEL and says nothing about whether it was meant to be. What says a running thing STOPPED is the
// alert log, which is why the badge reads alerts and this enum only colours a chip.
export const DeployStateSchema = z.enum(["running", "deploying", "stopped", "unhealthy", "unknown"]);
export type DeployState = z.infer<typeof DeployStateSchema>;

// Stacks and deployments are one row type in the view: a stack is a compose project, a deployment a single
// container, and an operator looking for what is down does not want them in separate lists.
export const DeployResourceKindSchema = z.enum(["deployment", "stack"]);
export type DeployResourceKind = z.infer<typeof DeployResourceKindSchema>;

// One service inside a stack — free of extra calls (Komodo's ListStacks already returns them under `info`),
// so a stack row can expand without a per-row fetch.
export const DeployServiceSchema = z.object({
    name: z.string(),
    image: z.string(),
    updateAvailable: z.boolean(),
});
export type DeployService = z.infer<typeof DeployServiceSchema>;

export const DeployResourceSchema = z.object({
    kind: DeployResourceKindSchema,
    // Komodo's resource id — what the action routes address (names collide across resource types, ids don't).
    id: z.string(),
    name: z.string(),
    state: DeployStateSchema,
    // Komodo's own status prose ("Up 4 days", "Exited (1) 20 minutes ago"). Passed through rather than
    // regenerated: docker's phrasing is more precise than anything we would compose from a state word.
    status: z.string().optional(),
    // The host it runs on — the grouping key of the whole view. Absent on a resource Komodo has not placed yet.
    server: z.string().optional(),
    image: z.string().optional(),
    // A newer image exists at the same tag. An opportunity, never a breakage — see the tone table in
    // ext-deployments' incidents.ts for why this may not reach the rail as `danger`.
    updateAvailable: z.boolean(),
    // Stacks only, and empty when the stack has none deployed yet.
    services: z.array(DeployServiceSchema),
    // Deep link into Komodo's own UI for this resource — we do not reimplement Komodo, we get you there.
    url: z.string(),
});
export type DeployResource = z.infer<typeof DeployResourceSchema>;

export const DeployServerStateSchema = z.enum(["ok", "unreachable", "disabled"]);
export type DeployServerState = z.infer<typeof DeployServerStateSchema>;

// A host, with the three gauges that explain a large share of deployment failures. All three ride ListServers'
// own `info.stats`, so the strip costs nothing extra; absent when the server is unreachable (no stats to have).
export const DeployServerSchema = z.object({
    id: z.string(),
    name: z.string(),
    state: DeployServerStateSchema,
    cpuPercent: z.number().optional(),
    memPercent: z.number().optional(),
    diskPercent: z.number().optional(),
    url: z.string(),
});
export type DeployServer = z.infer<typeof DeployServerSchema>;

// One entry from Komodo's alert log — an EDGE, already timestamped and resolve-flagged server-side. This is
// what makes the rail badge possible without keeping any local history: Komodo records the transition, we only
// decide whether the owner has seen it. `type` stays the raw AlertData variant tag (ContainerStateChange,
// ServerUnreachable, DeploymentImageUpdateAvailable, BuildFailed…) — a variant we have not met yet is exactly
// the one worth surfacing, so it passes through instead of being dropped into an "other" bucket.
export const DeployAlertSchema = z.object({
    id: z.string(),
    type: z.string(),
    level: z.enum(["ok", "warning", "critical"]),
    // Komodo closes an alert when the condition clears; a resolved container-state alert IS the recovery.
    resolved: z.boolean(),
    // Epoch ms the alert OPENED — compared against seenAt, so further trouble inside one open alert can't re-badge.
    ts: z.number(),
    // The resource it is about, when the variant names one, and the host it sits on.
    resource: z.string().optional(),
    server: z.string().optional(),
    // The container/stack state transition, on the variants that carry one ("running" → "restarting").
    from: z.string().optional(),
    to: z.string().optional(),
});
export type DeployAlert = z.infer<typeof DeployAlertSchema>;

/* Who the API key acts as. Komodo filters EVERY list by the caller's permissions, so a key minted on a service
 * user with no grants returns 200 and an empty array — byte-identical to a Komodo with nothing deployed. That
 * ambiguity shipped once and cost a user an afternoon: their Komodo had four stacks and the board said "no
 * stacks or deployments yet". Carrying the viewer lets the empty state name the actual reason. */
export const DeployViewerSchema = z.object({
    username: z.string(),
    // Either of Komodo's admin flags — an admin key sees everything, so its empty board really is empty.
    admin: z.boolean(),
});
export type DeployViewer = z.infer<typeof DeployViewerSchema>;

/* A workspace repo that ships a compose file, and the Komodo stack it belongs to.
 *
 * Komodo names a stack whatever its creator typed; a repo names its compose project in the file. The two
 * usually agree, or nearly — `intentic` in the repo against `intentic-platform` in Komodo — so the daemon
 * SUGGESTS and the owner decides. The link is explicit and persisted because a guess that silently becomes a
 * fact is worse than no guess: the owner is the one who knows that `atlas` is this repo's staging stack. */
export const DeployRepoLinkSchema = z.object({
    // The workspace repo dir — the same `repo` key the rest of the app joins on.
    repo: z.string(),
    // The compose project name: the file's own `name:` when it has one, else the repo dir. This is what
    // `docker compose up` would call the project, so it is the best guess at the stack's name.
    projectName: z.string(),
    // Workspace-relative path of the compose file the name came from, so the UI can say where it looked.
    composePath: z.string(),
    // The stack the owner linked, once they have. Absent ⇒ unlinked, and `suggestions` is the offer.
    linkedStack: z.string().optional(),
    // Stack names that look like this repo, best first. Empty when nothing resembles it — in which case the
    // UI offers the full list rather than pretending it has an opinion.
    suggestions: z.array(z.string()),
});
export type DeployRepoLink = z.infer<typeof DeployRepoLinkSchema>;

// Link a repo to a stack, or clear the link with an empty `stack`. Explicit rather than a toggle: the owner
// may be replacing one stack with another, and a toggle cannot express that in one call.
export const DeployLinkParamSchema = z.object({
    capability: z.string(),
    repo: z.string(),
    stack: z.string(),
});
export type DeployLinkParam = z.infer<typeof DeployLinkParamSchema>;

/* EVERY FIELD ADDED AFTER THIS ROUTE FIRST SHIPPED IS OPTIONAL OR DEFAULTED, and that is a rule rather than a
 * style. The browser validates this response with `.parse()`, and the daemon it is talking to is not
 * necessarily built from the same commit — a sandbox image is rebuilt on the owner's schedule, the web bundle
 * on ours. `repos` shipped REQUIRED and the first daemon that predated it took the whole view down with
 * `Invalid input: expected array, received undefined at repos`: not a missing band, a dead page, on the
 * surface whose entire job is to tell you whether production is up.
 *
 * So: a new field is `.default(...)` when the view can render without it, and `.optional()` when its absence
 * is itself meaningful. Neither is ever `required`. A newer browser must degrade against an older daemon. */
export const DeployOverviewResponseSchema = z.object({
    komodoUrl: z.string(),
    // FALSE means Komodo did not answer — the view says so loudly and the badge must not read `danger`.
    // "We cannot see production" is not "production is broken", the same line ciAttention draws when it
    // leaves the last known state standing rather than blanking the tile.
    reachable: z.boolean(),
    // Why it did not answer, in Komodo's own words — the view shows it instead of a bare "unavailable".
    unreachableReason: z.string().optional(),
    // Absent when Komodo did not answer — or when the daemon predates the field, which the empty state has to
    // tell apart from "the key sees nothing", since only one of those is the owner's to fix.
    viewer: DeployViewerSchema.optional(),
    // Every workspace repo with a compose file, with its suggested or linked stack. Independent of whether
    // Komodo returned anything: a repo the owner could link is worth showing even on an empty board, since
    // that is exactly the moment they need to know what this view is for.
    repos: z.array(DeployRepoLinkSchema).default([]),
    resources: z.array(DeployResourceSchema),
    servers: z.array(DeployServerSchema),
    // Newest first. Unresolved and resolved both: the view shows recent history, the badge reads only the
    // unresolved half.
    alerts: z.array(DeployAlertSchema),
    // When the owner last opened THIS connection's view. Rides the response so the rail decides what is new
    // without a second call. Absent ⇒ never opened, so everything counts as unseen.
    seenAt: z.number().optional(),
});
export type DeployOverviewResponse = z.infer<typeof DeployOverviewResponseSchema>;

// Which Komodo connection a call addresses — the capability id, which is also the rail tile's key.
export const DeployCapabilityParamSchema = z.object({ capability: z.string() });
export type DeployCapabilityParam = z.infer<typeof DeployCapabilityParamSchema>;

// The five state-changing operations the view offers. Deliberately no `write/*`: editing config from a
// dashboard is how you get drift the desired-state repo then fights, so configuration stays in Komodo or in
// the intent repo. `pull` pulls the newest image AND deploys — the routine version bump as one click.
export const DeployActionSchema = z.enum(["deploy", "restart", "start", "stop", "pull"]);
export type DeployAction = z.infer<typeof DeployActionSchema>;

export const DeployActionParamSchema = z.object({
    capability: z.string(),
    kind: DeployResourceKindSchema,
    // Komodo's resource id. Re-resolved to a live resource per call, so a stale card cannot act on something
    // that has since been deleted — the CI actions' "re-resolve per call" rule.
    id: z.string(),
    action: DeployActionSchema,
});
export type DeployActionParam = z.infer<typeof DeployActionParamSchema>;

export const DeployLogsParamSchema = z.object({
    capability: z.string(),
    kind: DeployResourceKindSchema,
    id: z.string(),
});
export type DeployLogsParam = z.infer<typeof DeployLogsParamSchema>;

// Komodo returns a `Log` with both channels; the view renders them together, newest at the bottom, the way a
// terminal would.
export const DeployLogsResponseSchema = z.object({ stdout: z.string(), stderr: z.string() });
export type DeployLogsResponse = z.infer<typeof DeployLogsResponseSchema>;

// The fix route opens an isolated conversation seeded with the resource, its state, and its log tail — the
// thing Komodo's own UI structurally cannot do, since the repo that holds the bug is open in the next tab.
export const DeployFixResponseSchema = z.object({ conversationId: z.string() });
export type DeployFixResponse = z.infer<typeof DeployFixResponseSchema>;

export const DeploySeenResponseSchema = z.object({ seenAt: z.number() });
export type DeploySeenResponse = z.infer<typeof DeploySeenResponseSchema>;

/* ---- the pre-push check: the workspace's own answer to "would this push go red" ----
 *
 * WHERE THIS SITS. A fleet of 5-20 agents lands work into the main tree, the user reviews and commits it by
 * parts, pushes, and CI answers minutes later. The check front-runs that answer at the push itself — the last
 * moment before the work leaves the machine, and the first moment at which what will be pushed is finally
 * settled.
 *
 * WHY THE PUSH AND NOT THE LAND, which is where this used to run. A post-land verdict is about a tree that
 * keeps moving: the user commits by parts, another agent lands, an edit arrives — so the verdict spent its life
 * either stale or being recomputed, and needed a content fingerprint, a staleness rule and a badge to say which.
 * All of that machinery existed to answer a question the push asks for free, because at the push there is
 * exactly one artifact and the user is standing in front of it waiting.
 *
 * SO THERE IS NO STORED VERDICT AND NOTHING IS POLLED AT REST. A run exists while it runs, reports to the
 * dialog that started it, and is gone. Nothing survives a daemon restart because nothing needs to: the next
 * push asks again. */

/* Where a run is.
 *
 *   idle      — nothing has run in this daemon's life, or the last run was cleared.
 *   running   — the check is live. `output` grows as it streams.
 *   passed    — exited 0. The push goes.
 *   failed    — exited non-zero, or was killed by prepushTimeoutMs (`timedOut`). The state a fix answers.
 *   error     — the check could not run at all: the command was not spawnable. NOT a fix-able failure, because
 *               there is nothing wrong with the code — the command is misconfigured, and saying "tests failed"
 *               would send an agent hunting a bug that isn't there.
 *   cancelled — the user stopped the run.
 */
export const PrepushStatusSchema = z.enum(["idle", "running", "passed", "failed", "error", "cancelled"]);
export type PrepushStatus = z.infer<typeof PrepushStatusSchema>;

export const PrepushRunSchema = z.object({
    status: PrepushStatusSchema,
    // The command this run executed, echoed rather than read back from settings: a result read after the
    // setting changed still has to say what produced it.
    command: z.string(),
    startedAt: z.number().optional(),
    finishedAt: z.number().optional(),
    exitCode: z.number().optional(),
    timedOut: z.boolean().optional(),
    // The check's own output, tail-capped (PREPUSH_OUTPUT_BYTES). The TAIL, not the head: a suite's verdict and
    // its failure summary are at the end, and a head-capped buffer of a chatty build is all progress lines.
    output: z.string(),
});
export type PrepushRun = z.infer<typeof PrepushRunSchema>;

// ---- drafts: agent-proposed posts awaiting owner approval (.intentic/drafts/<id>.json) ----
// One JSON file per draft. The AGENT creates drafts with its normal file tools — it can't call daemon routes,
// the same split as the environment proposal — while the daemon edits/deletes them on the owner's behalf, so
// the two writers never share a file. The id IS the filename (entryId charset ⇒ path-safe); the body never
// carries it. Posting is the agent's job too (there is no typed publish path): a "publish approved drafts"
// automation wakes the agent for due drafts, which posts via the platform skills and flips the status.

export const DraftStatusSchema = z.enum(["proposed", "approved", "posting", "posted", "failed"]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

// The on-disk file body. proposed (agent) → approved (owner) → posting (publisher, set BEFORE acting so a dead
// turn can't double-post) → posted | failed. Reject = delete the file; retry = re-approve a failed draft.
export const DraftSchema = z.object({
    // Which skill posts it: "x" | "reddit" | "youtube" | "discord" | … — a bare string so new platforms need
    // no contract change; an unknown platform simply fails at posting time.
    platform: z.string().min(1),
    content: z.string().min(1),
    // Reddit posts / YouTube uploads need one.
    title: z.string().optional(),
    // Where on the platform: subreddit / Discord channel id / community.
    target: z.string().optional(),
    // Workspace-relative attachment paths, e.g. ".intentic/drafts/media/chart.png".
    media: z.array(z.string()).optional(),
    // Suggested post time (epoch ms, the at/nextRun convention). Optional — the agent may propose without a
    // date and the owner sets one at approval; an approved draft with no date posts as soon as it's picked up.
    scheduledAt: z.number().optional(),
    // Agent-written files only need platform + content; status defaults, the rest are optional, so a
    // well-formed proposal never lands in `invalid` just for omitting bookkeeping fields.
    status: DraftStatusSchema.default("proposed"),
    createdAt: z.number().optional(),
    postedAt: z.number().optional(),
    // Why posting failed; set with status "failed".
    error: z.string().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

// The list row / upsert input: the file body plus its filename id.
export const DraftSummarySchema = DraftSchema.extend({ id: entryId });
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
// `invalid` = filenames that failed to parse. Agent-written files are a trust boundary — without this a typo'd
// draft would silently never post.
export const DraftsListSchema = z.object({ drafts: z.array(DraftSummarySchema), invalid: z.array(z.string()) });
// entryId, not a bare string: the id becomes a filename under .intentic/drafts/.
export const DraftIdParamSchema = z.object({ id: entryId });

// ---- panels: per-repository dev servers + the content facts extensions detect on ----
// Every discovered git repo under /work is one list row: its runnable-panel runtime status (a `dev` script at
// operator/ or the repo root; the daemon runs it, auto-assigns a free port, and the preview proxy routes
// preview-<panelKey>-<sandboxId>.<zone> to it) PLUS content facts — evidence the web app's extensions run their
// detect() over, computed daemon-side in one pass so the browser never scans /work file-by-file.

export const PanelSummarySchema = z.object({
    // The repo id: its root-relative dir under /work (slashes become `--` in the preview subdomain label).
    repo: z.string(),
    // Whether the repo ships a runnable dev server (a package.json `dev` script at operator/ or the root).
    hasPanel: z.boolean(),
    running: z.boolean(),
    // A plain probe of the running panel's port; false when not running.
    healthy: z.boolean(),
    // The dev server's OS-assigned port; absent when not running.
    port: z.number().optional(),
    // https://preview-<repo>-<sandboxId>.<zone>; absent when the sandbox has no zone or connect token (loopback/tests).
    previewUrl: z.string().optional(),
    // The workspace role this repo dir occupies (the three fixed dirs); absent for extra clones.
    role: z.enum(["intent", "desired-state", "app"]).optional(),
    // Content facts: deploy.config.ts (the intent ledger's day-one marker), desired-state.json (present after
    // the first resolve), .intentic/ui/index.html (a sandboxed directory UI), pnpm-workspace.yaml +
    // turbo.json (a pnpm+turbo monorepo), vitest evidence (a root vitest.config.ts, or "vitest" in the
    // root manifest / workspace catalog), and docs/user-stories (a directory of stories an agent can test
    // against the running app — the one fact here that says nothing about the repo's language).
    deployConfig: z.boolean(),
    desiredState: z.boolean(),
    directoryUi: z.boolean(),
    monorepo: z.boolean(),
    vitest: z.boolean(),
    userStories: z.boolean(),
});
export type PanelSummary = z.infer<typeof PanelSummarySchema>;
export const PanelsListSchema = z.object({ panels: z.array(PanelSummarySchema) });
export type PanelsList = z.infer<typeof PanelsListSchema>;
// The {repo} path param on the start/stop/terminals routes (a bare string: unknown repo is a handler NOT_FOUND).
export const PanelRepoParamSchema = z.object({ repo: z.string() });

// ---- ports: every listening TCP socket in the sandbox + explicit port forwarding ----
// Anything run in a terminal (a turbo TUI fanning out dev servers, `python -m http.server`, an agent's ad-hoc
// process) binds ports the daemon never assigned — the panel machinery can't see them. The /ports routes are
// the generic complement: `list` reports the live listeners (procfs scan, on demand), `forward` makes one
// reachable at port-<slot>-<sandboxId>.<zone> through the preview proxy. Forwarding is an explicit gesture —
// previews are public, so nothing is exposed until the owner (or an agent acting for them) asks.

export const PortSummarySchema = z.object({
    port: z.number(),
    // The loopback address the listener actually answers at inside the sandbox — a `localhost` bind can land
    // on ::1 only (Vite). The preview proxy and the desktop mirror (Mutagen forward) both dial this.
    host: z.enum(["127.0.0.1", "::1"]),
    // Whether the proxy can actually reach the listener at `host`. False for a bind to a loopback alias like
    // Docker's embedded DNS (127.0.0.11), which answers only at its own address, not 127.0.0.1 — such rows are
    // listed for transparency but the Ports view hides Preview and forwarding them is refused.
    forwardable: z.boolean(),
    // Which bucket the Ports view files it under: `workspace` = user-run (dev servers in repos, terminal
    // processes, published container ports) — the previewable set; `system` = the sandbox's own machinery
    // (agent runtimes, translator, dockerd, sshd), listed for transparency but nobody previews it.
    kind: z.enum(["workspace", "system"]),
    // The owning process, resolved from procfs; absent when no /proc/*/fd entry matched the socket's inode.
    pid: z.number().optional(),
    // How the row is labeled: the process argv joined with spaces ("node /work/app/node_modules/.bin/vite"),
    // falling back to the kernel `comm` name when argv is empty, or a synthesized name for attributable
    // infrastructure the pid walk can't reach ("Docker embedded DNS"). Absent only when wholly unattributable.
    command: z.string().optional(),
    // The process working directory (how the UI attributes a port to a repo).
    cwd: z.string().optional(),
    forwarded: z.boolean(),
    // https://port-<slot>-<sandboxId>.<zone>; present only while forwarded AND the sandbox has a zone + id.
    previewUrl: z.string().optional(),
});
export type PortSummary = z.infer<typeof PortSummarySchema>;
export const PortsListSchema = z.object({ ports: z.array(PortSummarySchema) });
export type PortsList = z.infer<typeof PortsListSchema>;

export const PortParamSchema = z.object({ port: z.number().int().min(1).max(65535) });
// `previewUrl` is absent on a loopback/no-tunnel sandbox — the slot is mapped, but no public hostname exists.
export const PortForwardResultSchema = z.object({ previewUrl: z.string().optional() });
export type PortForwardResult = z.infer<typeof PortForwardResultSchema>;

// ---- public: the workspace outbox ----
// The mirror image of the reference shelf. Files under the workspace's `public/` directory are served as static
// files at public-<slot>-<sandboxId>.<zone>, with no auth in front of them — the process-free half of preview
// (a panel needs a running dev server; a file needs nothing). The directory's existence is the switch: it is
// absent until something is published and removed again when the last file leaves, so "publishing is off" is
// the resting state rather than a flag someone has to remember to set back.

export const PublicFileSchema = z.object({
    // Outbox-relative, forward-slash ("report.pdf", "site/index.html").
    path: z.string(),
    size: z.number(),
    modifiedAt: z.number(),
    // The file's public URL. Absent when the sandbox has no tunnel, or when a guard refuses this file.
    url: z.string().optional(),
    // Why a file sitting in the outbox is NOT served — a hidden name, a credential-shaped name, contents that
    // match a known token format, or sheer size. The publisher reads it here; a stranger requesting the same
    // file only ever gets the same 404 every other miss returns, so this list can't be probed from outside.
    blocked: z.string().optional(),
});
export type PublicFile = z.infer<typeof PublicFileSchema>;

// `url` is the outbox root — the base every file's URL hangs off, and what the view shows as "your public
// address". Absent on a loopback/no-tunnel sandbox, which has nowhere to publish to.
export const PublicListSchema = z.object({ url: z.string().optional(), files: z.array(PublicFileSchema) });
export type PublicList = z.infer<typeof PublicListSchema>;

// A WORKSPACE-relative path (the space the file tree speaks) to copy into the outbox. A copy, not a move: the
// repo a build output came from must not lose it because someone shared it.
export const PublishSchema = z.object({ path: z.string().min(1) });
// An OUTBOX-relative path to withdraw — the path space PublicFile.path speaks, not the workspace's.
export const UnpublishSchema = z.object({ path: z.string().min(1) });
export const PublishResultSchema = z.object({ path: z.string(), url: z.string().optional() });
export type PublishResult = z.infer<typeof PublishResultSchema>;

// ---- terminal ----
// EVERY live surface in the sandbox the web app's ONE global panel can show. Mostly tmux sessions (the
// interactive I/O is the /system/terminal WebSocket, not oRPC), plus the agent's browser, which is not a
// terminal at all — no more than a `process` row is — but IS the same question: what is running right now,
// and can I look at it? One list, because the panel that answers that question is one panel.
//
// `shell` = a web-* session the user opened (numbered pill),
// `panel` = a panel-* dev-server session (labeled by its panel key, started via Start; running:false =
// untracked, e.g. a finished one-shot job's lingering shell), `agent` = an agent-* session the Claude agent's
// Bash commands run in (live-watchable, AI-marked in the UI; running:false once every window is a finished
// command's dead pane, which is what lets the panel sweep it), `job` = a job-* session the daemon's terminal
// runner executes user-triggered flows in (capability adds, infra check), `process` = a managed background
// process riding a panel session (an extension's declared processes, dockerd) — surfaced in the panel's
// background-processes popover with read-only log views, never as a killable tab; running is the actual
// process (a lingering shell after a crash reads false). A process row that maps to an installed extension's
// declared process carries extensionId+processName, the address for its /extensions start/stop routes. The
// `{name}` kill-route param is a bare string validated in the handler (a bad name is a BAD_REQUEST) since the
// same charset gates a `tmux kill-session -t` shell-out. The agent's BROWSER is deliberately NOT one of these
// kinds: a Chromium with its own tab strip is a surface in its own right, not a pane in the terminal panel, so
// it lists from /system/browsers with the pages it has open (BrowserSessionSchema below).
//
// `activityAt` (epoch ms of the session's last output) and `exitCode` (the LAST window's exit status, absent
// while that pane still lives) describe a session beyond "it exists": the panel's work popover orders its live
// rows by the one and dates them off it, and the daemon's retention sweep ages sessions out by the same clock.
// 0 is "tmux didn't say" — treated as unknown by both, never as 1970.
export const TerminalSessionSchema = z.object({
    name: z.string(),
    label: z.string().optional(),
    kind: z.enum(["shell", "panel", "agent", "job", "process"]),
    running: z.boolean(),
    activityAt: z.number(),
    exitCode: z.number().optional(),
    extensionId: z.string().optional(),
    processName: z.string().optional(),
});
export const TerminalsListSchema = z.object({ sessions: z.array(TerminalSessionSchema) });
export type TerminalsList = z.infer<typeof TerminalsListSchema>;
export const TerminalNameParamSchema = z.object({ name: z.string() });

/* ---- browsers: the Chromium the agent drives through its @playwright/mcp tools ----
 *
 * A `browser-<sdk session>` Chromium (browser/browser-sessions.ts), watchable live over the
 * /system/browser-view WebSocket. It lists apart from the terminals because it is shaped differently in the one
 * way that decides a UI: a terminal is ONE stream of bytes, while a browser holds SEVERAL pages at once and the
 * question "what is the agent looking at?" only has an answer if the wire carries all of them. So `pages` is the
 * point of this schema — the view renders them as a tab strip and binds the screencast to whichever the user
 * picks, and `active` is the one the agent itself last touched (what the view follows until the user says
 * otherwise).
 *
 * `id` is opaque and minted per session, and it is what makes a tab survive a relist: it is stable for the life
 * of the page, unlike its url (the agent navigates away) or its position (a closed tab renumbers the rest). */
export const BrowserPageSchema = z.object({
    id: z.string(),
    // The page's own title. Absent mid-navigation, which is exactly when a tab still needs to render.
    title: z.string().optional(),
    url: z.string(),
    // The page the agent last drove — on a finished session, the one it ended on. Exactly one page has it.
    active: z.boolean(),
});
export const BrowserSessionSchema = z.object({
    name: z.string(),
    // The pill's text: the active page's title, else its host, else which browser this is.
    label: z.string(),
    // Which MCP server drives it: `web` (the credential-free browser) or a logged-in capability's id — the
    // difference between a throwaway page and one signed in as the user, which is worth saying out loud.
    server: z.string(),
    // False once that Chromium is gone (the turn ended, the agent closed it, it crashed). A finished session
    // still lists for a while, with the pages it had — the record of where the agent went.
    running: z.boolean(),
    activityAt: z.number(),
    // When that Chromium went away, for the "closed 20m ago" line a finished session leads with. Absent while
    // running, which is the same fact as `running` — but the view needs the timestamp, not just the flag.
    finishedAt: z.number().optional(),
    pages: z.array(BrowserPageSchema),
});
export type BrowserPage = z.infer<typeof BrowserPageSchema>;
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowsersListSchema = z.object({ sessions: z.array(BrowserSessionSchema) });
export type BrowsersList = z.infer<typeof BrowsersListSchema>;
export const BrowserNameParamSchema = z.object({ name: z.string() });

/* ---- subagents: the agents an agent starts ----
 *
 * The third thing a turn spawns that the operator can be shown, after its shell and its browser — and the only
 * one that is itself an agent. Two kinds land in this one list, because from outside they are the same fact
 * (another agent, working, that you did not start):
 *   • `subagent` — the SDK's Agent/Task tool. The daemon learns of it from the SubagentStart/SubagentStop hooks
 *     and the task_* stream messages, joined on `toolUseId`.
 *   • `codex` / `grok` — a CLI the agent drove from its own Bash (agent/delegation.ts). Detected in the Bash
 *     PreToolUse hook, bound to its thread/session id from the command's output.
 *
 * `id` IS THE SPAWNING TOOL CALL'S id — the Agent card's, or the Bash card's for a delegation. It is the one key
 * every source already carries (the SDK's subagent meta, its task_* messages, and the `parentToolUseId` the
 * client nests inner frames under), so nothing has to be correlated: a card links to its subagent with the id it
 * already has, and the subagent points back at the card the same way. The ids the transcripts are actually READ
 * with — the SDK's agent id, a Codex thread, an OpenCode session — stay daemon-side, because no surface asks a
 * question they answer.
 *
 * WHAT A KIND CHANGES, and it is only ever the live view: a subagent has no process of its own to look at, so
 * watching it means reading its transcript. A delegation runs in a tmux window, so it has both — `terminal`
 * names it, and the card keeps its existing "Watch in terminal" beside the transcript door. */
export const SubagentKindSchema = z.enum(["subagent", "codex", "grok"]);
export type SubagentKind = z.infer<typeof SubagentKindSchema>;

// running/pending are live; the rest are terminal. Deliberately the SDK's own task vocabulary
// (SDKTaskUpdatedMessage.patch.status) rather than AgentStatus: this is not a fleet card's lifecycle (no
// draft/landed/conflict), and mapping the two would invent states neither side reports.
export const SubagentStatusSchema = z.enum(["pending", "running", "completed", "failed", "killed", "paused"]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentSessionSchema = z.object({
    id: z.string(),
    kind: SubagentKindSchema,
    // The conversation whose turn spawned this — what the area groups its rows by, and the way back to the chat
    // the card lives in.
    conversationId: z.string(),
    // What it is and what it was asked to do: the subagent type (`Explore`, `general-purpose`) or the delegated
    // provider's model, and the caller's one-line description. The area's row and the card's title read as
    // `Explore · Locate claimIndexer definition`.
    agentType: z.string().optional(),
    description: z.string().optional(),
    model: z.string().optional(),
    // How deep in the spawn tree (1 = spawned by the turn itself). From the SDK's meta.json; a subagent may
    // itself delegate, and a flat list that cannot say so reads as though the turn started all of them.
    spawnDepth: z.number().optional(),
    // Backgrounded: the parent went on working instead of waiting for it. This is the whole reason the list
    // exists — a backgrounded child used to be invisible until its result landed, sometimes minutes later.
    background: z.boolean().optional(),
    status: SubagentStatusSchema,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    activityAt: z.number(),
    // What it has spent and done so far (task_progress). Tokens are the child's own, so a parent's cost line and
    // the sum of its children's are two different true numbers.
    tokens: z.number().optional(),
    toolUses: z.number().optional(),
    lastTool: z.string().optional(),
    // Its report — the last assistant message (SubagentStop) or the task summary. The answer to "what did it
    // conclude?" without opening the transcript, which is the question a finished child is read for.
    summary: z.string().optional(),
    error: z.string().optional(),
    // A delegation's live view: the tmux session its command runs in. Absent for an SDK subagent, which has no
    // process of its own to attach to.
    terminal: z.string().optional(),
});
export type SubagentSession = z.infer<typeof SubagentSessionSchema>;
export const SubagentsListSchema = z.object({ sessions: z.array(SubagentSessionSchema) });
export type SubagentsList = z.infer<typeof SubagentsListSchema>;
export const SubagentIdParamSchema = z.object({ id: z.string() });

// ---- environment: the overlay Dockerfile extending the sandbox image ----
// The approved file is DAEMON-COMPOSED: pinned FROM + capability fragments + the owner-approved custom section.
// The agent drafts one file per thing it needs (.intentic/environment.d/<tool>.Dockerfile — custom-section
// content only, no FROM) with its normal file tools, and the daemon folds those into the single proposal file
// (.intentic/environment.Dockerfile) the owner reads. The owner approves it in the browser, which stores it as
// the custom file and recomposes the approved artifact whose sha256 the rebuild executor pins. Both composed
// files are written only when the composition CHANGES — see writeComposed, and the read loop it exists to end.
// Status is derived, never stored:
// applied = sha256(approved) === appliedHash; pending rebuild = approved present but hashes differ; proposed =
// proposal present with a hash different from custom's.

const environmentFileSchema = z.object({ content: z.string(), hash: z.string() });
export const EnvironmentSchema = z.object({
    proposal: environmentFileSchema.optional(),
    // The owner-approved agent-written custom section (.intentic/environment.custom.Dockerfile).
    custom: environmentFileSchema.optional(),
    approved: environmentFileSchema.optional(),
    // sha256 of the overlay the running container was built from (SANDBOX_ENVIRONMENT_HASH); absent = stock image.
    appliedHash: z.string().optional(),
    // config.sandbox.name — the UI derives the rebuild one-liner's slug from it.
    container: z.string().optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
export const EnvironmentApproveSchema = z.object({ hash: z.string().min(1) });

/* ---- portability: exporting a sandbox's environment and restoring it into a fresh one ----
 *
 * A sandbox is four stores, not one: `/work` (the workspace and the daemon's manifests), `/history` (every
 * repo's real git dir, the fleet registry, the ledgers), the CONTAINER (the built overlay image plus the env
 * the run contract replays) and the AI-provider credential root. A bundle carries the first two, declared entry
 * by entry in WORKSPACE_STATE_FILES / HISTORY_STATE_FILES. It cannot carry the other two, and the honest
 * consequence is that an import ends in a REPORT rather than a claim of equivalence — the container has no
 * docker socket, so only the host can rebuild the image the overlay describes.
 */

// What the bundle says about itself, written as its first tar entry so a reader learns the shape before the
// bytes. `secrets` is the owner's export-time choice; the restorer re-derives every decision from the manifests
// rather than trusting this, and uses it only to explain what is missing.
export const BundleManifestSchema = z.object({
    // Bumped when the layout changes in a way an older daemon would misread. Refused rather than guessed at.
    version: z.literal(1),
    // Where it came from, for the report's first line. Never used to authorize anything.
    sandbox: z.object({ name: z.string() }).optional(),
    createdAt: z.number(),
    secrets: z.boolean(),
    /* The environment the target has to reproduce, carried as FACTS rather than as the composed file (which the
     * target recomposes against its OWN base image on first boot). `customDockerfile` is the owner-approved
     * source section; `capabilities` names what contributed the remaining fragments, so the report can list what
     * to re-add when the configs themselves did not travel. */
    environment: z.object({
        customDockerfile: z.string().optional(),
        baseImage: z.string().optional(),
        approvedHash: z.string().optional(),
        capabilities: z.array(z.object({ id: z.string(), kind: z.string() })),
    }),
    // Every path class the bundle deliberately left out, with the manifest's own note where it has one. This is
    // what turns "the export skipped things" from a silence into a list the owner can act on.
    excluded: z.array(z.object({ path: z.string(), portability: z.string(), note: z.string().optional() })),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

// What a restore actually did. `needsAction` is the part that matters: the environment rebuild command, the
// credentials to re-enter, the logins to redo — each one a thing the target cannot do for itself.
export const ImportReportSchema = z.object({
    restored: z.object({ workspaceFiles: z.number(), historyFiles: z.number(), repos: z.array(z.string()), bytes: z.number() }),
    // Entries the bundle carried that this daemon refused to write (an identity file, an escaping path) — empty
    // for any bundle a matching exporter produced, and a tamper signal when it is not.
    refused: z.array(z.string()),
    needsAction: z.array(z.object({ subject: z.string(), detail: z.string() })),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;

/* One export sitting in the daemon's export directory — the ARTIFACT a bundle is, rather than the request that
 * produced it. Packing takes minutes over a real workspace, so tying it to a response made it a property of one
 * browser tab: a refresh abandoned the work and left nothing to come back to. It is a file now, and every field
 * below is read off that file rather than remembered anywhere.
 *
 * `status` is derived from the extension (.part / .tar.gz / .failed) and `bytes` is the file's own size, which
 * is what makes a live pack's progress free to report. */
export const BundleExportSchema = z.object({
    // The finished bundle's filename, which is the id in every route — and, once downloaded, the name the owner
    // sees on disk. Carries its own timestamp and a `-with-secrets` marker so it stays self-describing there.
    name: z.string(),
    status: z.enum(["packing", "ready", "failed"]),
    // Bytes written so far while packing; the finished size once ready.
    bytes: z.number(),
    // mtime: when packing ended for a finished bundle, when it last made progress for a live one.
    createdAt: z.number(),
    secrets: z.boolean(),
    // Why it stopped, for a failed one. Read from the .failed marker's own contents.
    error: z.string().optional(),
});
export type BundleExport = z.infer<typeof BundleExportSchema>;
export const BundleExportsSchema = z.object({ exports: z.array(BundleExportSchema) });

// ---- secrets: user-supplied env-var secrets the daemon writes to desired-state/.env ----
// The web posts a Cloudflare token / GitHub PAT / another-host SSH key straight to the sandbox daemon (never
// through the platform); `apply` reloads .env each run so a new secret is picked up with NO restart. `list`
// returns KEYS ONLY — the values never leave the sandbox; `reveal` is the one deliberate, owner-only exception.
export const SecretSetSchema = z.object({
    key: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128),
    value: z.string().min(1),
});
export const SecretKeysSchema = z.object({ keys: z.array(z.string()) });
export const SecretKeyParamSchema = z.object({ key: z.string() });
export const SecretRevealSchema = z.object({ value: z.string() });

// One entry per secret the sandbox knows about, across every store: intent env secrets and intentic-generated
// passwords (from the desired-state repo), capability credentials, and AI-provider accounts. Values never ride
// this shape — `revealable` says whether `reveal` can return one (everything but provider accounts).
export const SecretInventoryEntrySchema = z.object({
    // Env-var key for env|generated; `<provider>:<accountId>` for provider entries; capability instance id
    // otherwise. Unique within the inventory — several accounts of one provider each get their own entry.
    key: z.string(),
    kind: z.enum(["env", "generated", "capability", "provider"]),
    // Display name for provider entries: "<ProviderName> · <accountLabel>". Absent on env/generated entries.
    label: z.string().optional(),
    status: z.enum(["missing", "set", "connected"]),
    // The artifact resources referencing this secret ({$secret} refs); [] for capability/provider entries.
    requiredBy: z.array(z.object({ resourceId: z.string(), type: z.string() })),
    // Human-readable provenance, e.g. "desired-state/.env" — the UI's "where does this live" line.
    storedAt: z.string(),
    revealable: z.boolean(),
    // Forgejo Actions replication state, present only after adopt on env|generated entries.
    ci: z.object({ synced: z.boolean(), pushedAt: z.string().optional() }).optional(),
});
export type SecretInventoryEntry = z.infer<typeof SecretInventoryEntrySchema>;
export const SecretInventorySchema = z.object({ entries: z.array(SecretInventoryEntrySchema) });

// ---- system ----

// version: what this daemon runs (baked). latest/updateAvailable: the daemon compares its version to the
// latest published `stable` release so the web can offer a non-blocking update (see system/version-check.ts).
/* Whether an agent runtime can serve a turn right now, probed off the turn path (see the sandbox's
 * agent/adapter-health.ts). "unknown" is a real answer — a probe that could not run must not read as
 * "unavailable" and grey out a provider the user can in fact use — so surfaces treat it as
 * available-but-unverified rather than as a soft no. */
export const AdapterHealthSchema = z.object({
    state: z.enum(["ready", "unavailable", "unknown"]),
    // Why it cannot serve, in the user's terms and naming what to do about it. Absent when ready.
    detail: z.string().optional(),
    checkedAt: z.number(),
});
export type AdapterHealthReport = z.infer<typeof AdapterHealthSchema>;

export const InfoSchema = z.object({
    name: z.string().optional(),
    image: z.string().optional(),
    version: z.string().optional(),
    latest: z.string().optional(),
    updateAvailable: z.boolean().optional(),
    // Keyed by AgentCapabilities.runtime. Absent until the first background sweep lands, which reads the same
    // as every entry being "unknown" — one of the two cannot go stale, so the daemon sends the absence.
    runtimes: z.record(z.string(), AdapterHealthSchema).optional(),
    /* Which release channel this sandbox follows (`stable` unless it was moved), and the base image the last
     * swap replaced — both set on the container by the host script that performed the swap, since neither is
     * knowable from inside afterwards. `previousImage` is what a rollback returns to; absent means there is
     * nothing to go back to and no rollback is offered. */
    channel: z.string().optional(),
    previousImage: z.string().optional(),
});
export type Info = z.infer<typeof InfoSchema>;

// A daemon-minted session (system.session): the steady-state browser credential, exchanged for a verified
// Google ID token so Google UI is a sign-in moment instead of an hourly renewal. `expiresAt` is epoch ms —
// the browser renews ahead of it without parsing the token; `email` is who the daemon verified.
export const DaemonSessionSchema = z.object({ token: z.string(), expiresAt: z.number(), email: z.string() });
export type DaemonSession = z.infer<typeof DaemonSessionSchema>;

// Intentic-provided host SSH tunnel: minting it needs intentic's PLATFORM Cloudflare account, so the daemon
// can't do it directly — it relays to the platform authenticated by the connect token (the announce pattern).
// The panel embeds the returned connector token + hostname in its connect-host one-liner.
export const HostTunnelInputSchema = z.object({ hostName: z.string().min(1) });
export const HostTunnelSchema = z.object({ hostname: z.string(), tunnelToken: z.string() });

// ---- activity: the activity audit log (historyRoot/activity.jsonl) ----
// One provider-agnostic event per agent↔provider interaction, appended by the daemon only (never the agent —
// the log lives under historyRoot, outside /work, so the agent can't read or rewrite its own trail). Discord
// is the first source; other cli providers reuse the same shape.

export const ActivityEventSchema = z.object({
    id: z.string(),
    // Epoch ms; also the paging cursor.
    at: z.number(),
    // "discord", …; absent on provider-less system events (a cron automation.run).
    provider: z.string().optional(),
    // Which provider account handled the turn — the attribution key for per-account usage totals. Absent on
    // provider-less events and turns that ran on the provider's default account.
    account: z.string().optional(),
    direction: z.enum(["in", "out", "system"]),
    // in: message.received | voice_utterance.received | voice_transcript.received
    // out: message.send | reaction.add | messages.read | api.call (unclassified provider endpoint)
    // system: gateway.login_failed | dispatch.failed | voice.session_started | voice.session_ended | automation.run
    //         | turn.started | turn.plan | turn.error | turn.completed (agent turn lifecycle; provider = claude/codex)
    type: z.string(),
    channelId: z.string().optional(),
    // Inbound author display name.
    author: z.string().optional(),
    // Full message text (inbound) or sent payload content (outbound).
    content: z.string().optional(),
    // Outbound HTTP method + endpoint path (tokens ride headers, never URLs).
    method: z.string().optional(),
    endpoint: z.string().optional(),
    // The agent turn that made/handled it — the join key between an inbound wake and its outbound calls.
    sessionId: z.string().optional(),
    /* ONE TURN'S EVENTS, TIED TOGETHER. A turn writes four lifecycle events plus one per outbound provider call,
     * and read as five rows they say one thing five times — so the feed groups on this instead. It cannot be
     * sessionId: the runtime does not mint one until the stream's first frame, which is AFTER turn.started, so
     * the very event carrying the prompt is the one that could never be joined. Minted by the turn itself. */
    turnId: z.string().optional(),
    // The stable conversation the turn belongs to. Outlives sessionId, which a provider/account/harness switch
    // retires mid-conversation — so this, not sessionId, is what "the same agent" means across a feed.
    conversationId: z.string().optional(),
    // The conversation's display title as it stood when the event was written. Denormalised on purpose: the
    // registry entry it came from is prunable and renameable, and an audit row must still read as words years
    // later. Absent on the first event of a fresh conversation — the auto-namer has not run yet.
    title: z.string().optional(),
    // What woke the conversation from outside, when something did (see AgentOriginSchema) — the feed's "who
    // called me" attribution, and how a turn is filed under Discord rather than under the runtime that served it.
    origin: AgentOriginSchema.optional(),
    automationIds: z.array(z.string()).optional(),
    outcome: z.enum(["ok", "error"]).optional(),
    error: z.string().optional(),
    // Source-specific detail: guildId, attachments, transcript path, participants…
    extra: z.record(z.string(), z.unknown()).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityQuerySchema = z.object({
    provider: z.string().optional(),
    limit: z.coerce.number().min(1).max(500).default(100),
    // `at` cursor, exclusive — newest-first paging.
    before: z.coerce.number().optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export const ActivityListSchema = z.object({ events: z.array(ActivityEventSchema) });

// Live connection health, probed per provider capability (not stored): gateway state from the client pool
// (idle = the gateway is up but has no enabled listener automation to connect for — distinct from a
// connection that should be up but isn't), lastError from the newest system-error event in the recent log.
export const ActivityConnectionSchema = z.object({
    capabilityId: z.string(),
    provider: z.string(),
    gateway: z.enum(["ready", "connecting", "disconnected", "idle"]),
    lastError: z.string().optional(),
});
export const ActivityStatusSchema = z.object({
    connections: z.array(ActivityConnectionSchema),
    // The daemon's live voice session, when one is up.
    voice: z.object({ channelId: z.string(), channelName: z.string(), startedAt: z.number(), participants: z.array(z.string()) }).optional(),
});
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

// ---- usage: the durable spend ledger ----
// One row per attributed turn, appended at turn end and NEVER pruned. This exists because the activity log
// can't answer a money question: it prunes to its most recent entries, so a month's spend is unanswerable and
// — worse for a cost readout — the totals SHRINK as newer turns evict older ones. The ledger keeps the raw
// per-turn facts and the rollup projects them on read, so a new grouping (by day, by model, by conversation)
// needs no new storage and no migration.
export const UsageTurnSchema = z.object({
    // Epoch ms at turn end. Kept alongside `day` so a future timezone-aware rollup is a pure change over data
    // already on disk.
    at: z.number(),
    // The UTC calendar day (YYYY-MM-DD) `at` fell in — precomputed so a rollup never re-derives a timezone.
    day: z.string(),
    provider: z.string(),
    // Absent on an env-token turn, which has no account to attribute to (same rule as the activity log).
    account: z.string().optional(),
    // The model the turn ACTUALLY ran, resolved past the client's pick and every provider default. Absent only
    // when the provider's own subscription default served it without the daemon naming one.
    model: z.string().optional(),
    harness: z.string(),
    // The conversation this turn belonged to, so spend can join to a fleet agent. Absent only for an internal
    // one-shot turn that has no conversation identity.
    conversationId: z.string().optional(),
    // The provider's own turn count for the request (a Claude "turn" can be several under the hood), so turns
    // and cost stay comparable across providers. 1 when the provider reported none.
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
    /* Which arm of the terse experiment this turn ran on (settings.terseHoldout) — the only record of it, and
     * the reason the savings report can say what the steer is worth instead of guessing.
     *
     * ABSENT means "not part of the experiment", not "off": a turn under a custom system prompt drops the
     * steer along with everything else the daemon appends, and a turn run with the experiment switched off has
     * no control to be compared against. Pooling those into the off-arm would compare steered turns against a
     * population selected by something other than the coin flip, which is not a control at all. */
    terse: z.boolean().optional(),
    /* Which arm of the pre-injection experiment this turn ran on (settings.iqContextHoldout), on the same terms
     * as `terse` above: absent ⇒ outside the experiment.
     *
     * TRUE means the turn was ASSIGNED the retrieved context, not that a note was necessarily prepended — a
     * treatment turn whose retrieval came back empty or unconfident injects nothing. That is deliberate: the
     * arms have to be the coin flip's populations, and re-labelling a turn by what retrieval happened to find
     * would sort turns by how searchable their question was, which is a property of the question. The control
     * arm contains the same unsearchable questions in the same proportion, so they cancel. */
    iqContext: z.boolean().optional(),
    /* Whether a note was actually PREPENDED on this turn — the companion to `iqContext`, and the answer to the
     * question that field's design deliberately refuses to answer.
     *
     * Keeping the arm on the coin flip is right, and it costs something: the treatment arm contains turns the
     * treatment never reached, so the delta it yields is diluted by however many those are. Measured over one
     * day that was four turns in five, which makes the difference between "this mechanism is worth little" and
     * "this mechanism is worth five times what the number says" — and nothing in the ledger could tell them
     * apart, because a treated turn and an untreated one in the same arm looked identical.
     *
     * So the arm stays intention-to-treat and this records delivery beside it. Together they give both the
     * unbiased estimate and the rate to divide it by; alone, either one misleads. Absent ⇒ outside the
     * experiment, exactly as for the arm. */
    iqContextNote: z.boolean().optional(),
    /* Characters of the model's own PROSE this turn — the `delta` frames only, so no tool-call arguments and no
     * thinking. What the terse steer is judged on, and the reason it can be judged at all.
     *
     * `outputTokens` cannot serve: measured over a day of real turns it is 91.6% tool-call arguments (an Edit's
     * old_string and new_string, a Write's whole file body) and 7.8% prose. The steer moves prose. So a fifth
     * off the model's narration moves the total by 1.6% — against a margin of ±35 points, which is to say the
     * experiment was structurally unable to see its own treatment, and the number it printed instead was
     * whichever arm happened to draw the bigger tasks.
     *
     * CHARACTERS, not tokens, because the provider bills a total and never breaks it down — a token figure here
     * would be chars÷4 wearing a unit it had not earned. For a comparison of two arms the constant cancels
     * anyway, and the honest unit is the one actually counted.
     *
     * Absent ⇒ the turn predates this being measured; `armOf` drops it from the population rather than reading
     * it as a silent turn. */
    proseChars: z.number().optional(),
});
export type UsageTurn = z.infer<typeof UsageTurnSchema>;

// The ledger grouped by day × provider × account × model × harness × conversation — the finest grouping any
// dashboard panel needs, and a handful of rows per active day instead of one per turn, so a year of history is
// well under a MB over the tunnel. Every panel (spend per day, cost by model, cost by agent, cache hit rate) is
// a projection of these.
// The conversation is in the KEY, not merely along for the ride, because cost-by-agent has to answer within the
// same window as every other panel on the screen. The fleet registry also carries a per-agent total, but only a
// cumulative, all-time one — reading it beside a "last 7 days" filter would print an all-time number under a
// windowed heading, which is the shrinking-totals bug wearing a different hat.
export const UsageRollupRowSchema = z.object({
    day: z.string(),
    provider: z.string(),
    account: z.string().optional(),
    model: z.string().optional(),
    harness: z.string(),
    conversationId: z.string().optional(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
});
export type UsageRollupRow = z.infer<typeof UsageRollupRowSchema>;
// Inclusive UTC day bounds (YYYY-MM-DD). Both absent ⇒ the whole ledger. Shared by every windowed read of a
// daemon ledger (spend, savings): one window shape, so a screen that filters two ledgers at once filters them
// with the same calendar.
export const DayWindowQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
});
export type DayWindowQuery = z.infer<typeof DayWindowQuerySchema>;
export const UsageRollupSchema = z.object({ rows: z.array(UsageRollupRowSchema) });

// ---- usage: per-account token/cost totals ----
// The account picker's headroom readout, folded from the ledger above (all-time, not a log window), grouped by
// provider+account. `account` is the attribution key, so env-token turns are excluded rather than pooled under
// a blank id — an unattributed turn belongs to no account's total.
export const UsageAccountSchema = z.object({
    provider: z.string(),
    account: z.string(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
});
export type UsageAccount = z.infer<typeof UsageAccountSchema>;
export const UsageSummarySchema = z.object({ accounts: z.array(UsageAccountSchema) });

// ---- logs: daemon-owned debug logs (historyRoot/logs) ----
// Terminal pipe-pane captures (terminals/), intentic CLI run logs (intentic-runs/), and the daemon's own pino
// file (daemon.log) — written by the daemon/tmux only, under historyRoot so the agent can't rewrite them.

export const LogFileEntrySchema = z.object({
    // Path relative to the logs root, e.g. "terminals/web-1-%0.log" or "daemon.log".
    name: z.string(),
    sizeBytes: z.number(),
    // Epoch ms mtime.
    modifiedAt: z.number(),
});
export type LogFileEntry = z.infer<typeof LogFileEntrySchema>;
export const LogsListSchema = z.object({ files: z.array(LogFileEntrySchema) });

// `name` rides the query (log names contain slashes, which don't fit a path segment); `bytes` is the tail
// size — the newest bytes win when the file is larger.
export const LogReadQuerySchema = z.object({
    name: z.string().min(1),
    bytes: z.coerce.number().min(1).max(1_048_576).default(65_536),
});
export const LogReadSchema = z.object({
    name: z.string(),
    sizeBytes: z.number(),
    // The tail text; truncated when the file holds more than the requested bytes.
    text: z.string(),
    truncated: z.boolean(),
});
export type LogRead = z.infer<typeof LogReadSchema>;

// ---- memory: the agent's persistent memory notes (.intentic/claude/projects/<project>/memory) ----
// The markdown files the agent curates across sessions — MEMORY.md (the index) plus one file per fact. They
// live under the workspace's .intentic/claude control plane (symlinked from ~/.claude/projects), which the
// generic /workspace file API deliberately refuses (session transcripts and provider state share that tree),
// so these purpose-built routes are the only browser surface — scoped to the memory dirs and nothing else.

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

// A tab's self-report of what it is looking at, keyed by its /events connection's clientId. Full replace,
// not a merge — an absent field means "cleared", so a tab leaving a file drops the path with the same report.
export const PresenceReportSchema = z.object({
    clientId: z.string(),
    idle: z.boolean(),
    view: z.string().optional(),
    sessionId: z.string().optional(),
    path: z.string().optional(),
});
export type PresenceReport = z.infer<typeof PresenceReportSchema>;

// ---- push: web-push notifications to the owner's devices ----
// The daemon is the only tier that knows what the agent is doing, so it is the sender. Subscriptions are
// per-BROWSER (the endpoint is minted by that browser's push service — Google's, Mozilla's, Apple's), which
// is why they live here and not on the platform: the platform is off the command path and would have to be
// told about every turn to be useful.

// A browser's PushSubscription, in the exact shape `web-push` consumes — the browser produces it via
// PushManager.subscribe() and the client posts it back verbatim, so the daemon never reshapes it.
export const PushSubscriptionSchema = z.object({
    endpoint: z.url(),
    keys: z.object({
        // The client's public key and auth secret for payload encryption (RFC 8291). Opaque base64url here.
        p256dh: z.string().min(1),
        auth: z.string().min(1),
    }),
});
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

// What the service worker renders. `url` is the in-app route the notification opens (the click handler
// focuses an existing tab there rather than spawning a new one); `tag` collapses repeats — a second
// "waiting on you" for the same conversation REPLACES the first instead of stacking. Push payloads are
// capped by the push services themselves (~4KB after encryption), which is why nothing here carries a
// transcript or a diff — the notification is a pointer back into the workspace, not a delivery mechanism
// for content.
export const PushNotificationSchema = z.object({
    title: z.string().min(1),
    body: z.string(),
    url: z.string().optional(),
    tag: z.string().optional(),
    // Whether the notification stays on screen until dismissed. Set for the "agent is blocked on you" cases,
    // where a notification that auto-dismisses is a request that silently went unanswered.
    requireInteraction: z.boolean().optional(),
});
export type PushNotification = z.infer<typeof PushNotificationSchema>;

// The VAPID public key a browser needs to subscribe, plus whether this browser's endpoint is already known —
// so the settings toggle can render its true state instead of trusting the browser's permission alone (a
// granted permission with no server-side row would notify nothing).
export const PushConfigSchema = z.object({ publicKey: z.string(), subscribed: z.boolean() });
export const PushEndpointSchema = z.object({ endpoint: z.url() });
// The optional `endpoint` says WHICH browser is asking; without it `subscribed` could only speak for the
// sandbox as a whole, which is never the question the settings toggle needs answered.
export const PushConfigQuerySchema = z.object({ endpoint: z.url().optional() });

// What a test send actually achieved. `{ ok: true }` would be a lie the one place it matters most: the button
// exists to prove a chain the user cannot inspect, so "the daemon accepted the request" is not the answer to
// the question being asked. A count separates "your OS swallowed it" from "nothing was sent at all".
export const PushTestSchema = z.object({ delivered: z.number().int().nonnegative() });
export type PushTest = z.infer<typeof PushTestSchema>;

// ---- maintenance: the standing evidence a chore is decided from ----

/* THE DAEMON SERVES FACTS; THE BROWSER DECIDES. Everything below is measurement — what a tool reported, what the
 * manifests say, when a chore last ran. Not one field here says "you should do something", and that is the whole
 * boundary: which chore is DUE is computed by @intentic/sandbox-contract/chores, which both the Maintenance view and its rail
 * badge run, so the number on the tile and the reason in the panel can never disagree. Put the verdict on the wire
 * instead and a daemon one image behind would be quietly arguing with the browser about what needs doing.
 *
 * The split inside the evidence is by COST, not by subject:
 *   probes   subprocesses (pnpm outdated, pnpm audit, knip, jscpd) — minutes, so they are cached on disk with a
 *            TTL and refreshed by a background runner. A route hit never waits on one.
 *   signals  things the daemon already knows — the resident iq index's health ranking, the package manifests it
 *            reads for the dependency graph, its own node version. Recomputed per request; all of it is cheap. */

export const PROBE_IDS = ["outdated", "audit", "knip", "jscpd", "ui", "bundle"] as const;
export const ProbeIdSchema = z.enum(PROBE_IDS);
export type ProbeId = z.infer<typeof ProbeIdSchema>;

// One dependency the registry has moved past. `kind` is the SEMVER distance, which is the whole reason this is
// not one number: forty patch releases behind is a morning's work and one major is a project.
export const OutdatedPackageSchema = z.object({
    name: z.string(),
    current: z.string(),
    latest: z.string(),
    kind: z.enum(["major", "minor", "patch"]),
    // "dependencies" / "devDependencies" / "optionalDependencies" — a dev-only major is a different risk.
    section: z.string(),
});
export type OutdatedPackage = z.infer<typeof OutdatedPackageSchema>;

// One advisory, reduced to what a decision needs. No CVSS vector and no reference list: those are for reading on
// the advisory page, and carrying them would put a kilobyte of prose per finding on every poll of this route.
export const AdvisorySchema = z.object({
    name: z.string(),
    severity: z.enum(["critical", "high", "moderate", "low", "info"]),
    title: z.string(),
    // The range that fixes it, when the advisory names one. Absent ⇒ no patch published yet, which is the case
    // where a chore must NOT offer to bump and say so instead.
    patched: z.string().optional(),
    // Whether it reaches a production dependency path. A build-time-only tool's transitive CVE is a different
    // problem, and the chore's prompt says so rather than treating every advisory alike.
    dev: z.boolean(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

// knip's counts, by the kind of thing it found unreachable. Counts plus a sample rather than the full list: the
// agent re-runs knip itself against the live tree (a list from a probe hours old would send it at files that are
// already gone), so what travels here only has to be enough to decide whether the turn is worth starting.
export const DeadCodeSchema = z.object({
    files: z.number().int().nonnegative(),
    exports: z.number().int().nonnegative(),
    types: z.number().int().nonnegative(),
    dependencies: z.number().int().nonnegative(),
    devDependencies: z.number().int().nonnegative(),
    // A handful of the unreferenced files, for the panel to show instead of asking the reader to take "31" on faith.
    sample: z.array(z.string()),
});
export type DeadCode = z.infer<typeof DeadCodeSchema>;

// jscpd's headline plus the biggest clones. `percentage` is of scanned lines, which is the figure a threshold is
// worth setting against — a clone COUNT grows with the repo and would mean something different every quarter.
export const DuplicationSchema = z.object({
    percentage: z.number(),
    clones: z.number().int().nonnegative(),
    top: z.array(z.object({ lines: z.number().int().nonnegative(), first: z.string(), second: z.string() })),
});
export type Duplication = z.infer<typeof DuplicationSchema>;

/* ONE SWEEP OF THE UI SOURCE, serving three chores. Component files, Tailwind classes that hard-code a value, and
 * files still on a replaced framework idiom are three questions about the same tree, and asking them in three
 * probes would walk it three times for nothing.
 *
 * Counts per FILE rather than the matched text. A reader deciding whether to open something is served better by
 * "Checkout.vue · 11 hard-coded values" than by eleven class attributes, and a file path is an identity a digest
 * can be built from while a class string is not. */
export const UiScanSchema = z.object({
    // Framework-shaped source files — tests, stories and generated output excluded. The inventory that makes a
    // duplication finding a COMPONENT duplication finding rather than a generic one.
    components: z.array(z.string()),
    // Where the design system was routed around, and how often in each file.
    bypasses: z.array(z.object({ path: z.string(), count: z.number().int().positive() })),
    // Files still on an idiom their framework has replaced, grouped by which one. `id` is looked up in the stack
    // table rather than enumerated here: the rules are a product decision that ships with the browser, and a
    // daemon an image behind must be able to report one this schema has never heard of.
    idioms: z.array(z.object({ id: z.string(), files: z.array(z.string()) })),
});
export type UiScan = z.infer<typeof UiScanSchema>;

/* WHAT THE LAST BUILD ACTUALLY PRODUCED. Measured from the build output already on disk, never by running the
 * build: a maintenance probe that mutates the owner's working tree — and `dist/` appearing in their `git status`
 * is exactly that — is a worse surprise than a measurement that is sometimes a commit behind. It also means this
 * never needs the env vars, secrets or network a real production build would.
 *
 * Gzip alongside raw because gzip is what crosses the wire, and the ratio between them is the difference between
 * "this chunk is big" and "this chunk is big and incompressible", which are different problems. */
export const BundleSchema = z.object({
    // Which directory was measured, so the panel can say what it is talking about rather than implying it built.
    dir: z.string(),
    totalBytes: z.number().int().nonnegative(),
    totalGzip: z.number().int().nonnegative(),
    assets: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), gzip: z.number().int().nonnegative() })),
});
export type Bundle = z.infer<typeof BundleSchema>;

/* One probe's cached result. The three states are deliberately distinct, because a panel that collapses them
 * lies about the most important case:
 *   ok           the tool ran and reported. `facts` carries its findings — including "nothing found", which is
 *                a real answer and the one that keeps a chore quiet.
 *   unavailable  the tool is not part of this repo (knip is not a devDependency, there is no lockfile to audit).
 *                Not a failure and not evidence of health: the chore renders as unmeasured, and can never badge.
 *   failed       the tool ran and broke — a network-less audit, a jscpd that ran out of memory. Says so, with
 *                the tail of what it printed, rather than reading as "clean".
 * Merging `unavailable` into `ok`-with-zeros is how a maintenance surface ends up reporting a green repository
 * it has never actually measured. */
export const ProbeStateSchema = z.enum(["ok", "unavailable", "failed"]);
export type ProbeState = z.infer<typeof ProbeStateSchema>;

// The findings, discriminated by which probe produced them. Absent while the probe has never completed, and on
// `unavailable`/`failed` — a reader must go through `state` to reach facts, so there is no shape in which a
// missing measurement can be mistaken for a zero.
export const ProbeFactsSchema = z.discriminatedUnion("id", [
    z.object({ id: z.literal("outdated"), packages: z.array(OutdatedPackageSchema) }),
    z.object({ id: z.literal("audit"), advisories: z.array(AdvisorySchema) }),
    z.object({ id: z.literal("knip"), deadCode: DeadCodeSchema }),
    z.object({ id: z.literal("jscpd"), duplication: DuplicationSchema }),
    z.object({ id: z.literal("ui"), scan: UiScanSchema }),
    z.object({ id: z.literal("bundle"), bundle: BundleSchema }),
]);
export type ProbeFacts = z.infer<typeof ProbeFactsSchema>;

export const ProbeResultSchema = z.object({
    id: ProbeIdSchema,
    state: ProbeStateSchema,
    // When the probe last COMPLETED — the age the panel shows, and what the runner's TTL is measured from.
    ranAt: z.number(),
    // How long it took. Shown because a seven-minute jscpd is why the tier-2 refresh is weekly, and a reader
    // deciding whether to force a refresh deserves to know what they are asking for.
    tookMs: z.number().int().nonnegative(),
    facts: ProbeFactsSchema.optional(),
    // On `failed`, how it broke — a bounded quote of the tool's own output, never a summary of it. On
    // `unavailable`, what is missing, in the probe spec's own words ("no lockfile"): there is no tool output to
    // quote when the tool never ran, and the alternative — a sentence built from the probe's name — would have an
    // unmeasured probe claiming there is nothing to measure.
    reason: z.string().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

// One workspace package as its manifest declares it — what the daemon already reads to build the dependency
// graph, carried through so chores can reason about the repo's own shape without a probe. `documented` is the
// one derived field: whether docs/architecture/<dir>/doc.md exists, a stat per package.
export const ChorePackageSchema = z.object({
    dir: z.string(),
    name: z.string(),
    // The manifest's `engines` map, verbatim — the runtime chore compares it against what the daemon is running.
    engines: z.record(z.string(), z.string()).optional(),
    dependencies: z.array(z.string()),
    devDependencies: z.array(z.string()),
    documented: z.boolean(),
});
export type ChorePackage = z.infer<typeof ChorePackageSchema>;

/* The cheap half of the evidence: what the daemon knows without starting anything. `hotspots` and `keyModules`
 * are the same rankings GET /workspace/health serves, capped tighter — a chore only ever asks whether a file has
 * ENTERED the top of the ranking, so a leaderboard is enough and a full report per repo per poll is not. */
/* WHAT THIS REPOSITORY IS MADE OF — the facts that decide whether a chore is a QUESTION worth asking of it at
 * all, as opposed to whether the answer happens to be yes.
 *
 * The distinction is the difference between a maintenance surface that reads as attentive and one that reads as
 * generic. "Re-read the documentation against the code" in a repository with no documentation is not a chore
 * that is currently clear — it is a chore that will never make sense here, and showing it teaches the owner that
 * this list was written by someone who had not looked. Same for a Docker chore with no Dockerfile, or a CI chore
 * with no pipeline.
 *
 * These are all paths, deliberately: presence of a FILE is checkable, cheap, and cannot be argued with, which is
 * the same evidence-over-identity rule the extension activation facts follow. Every field is a list rather than a
 * boolean where the paths themselves are worth showing — a chore that says "not applicable: no Dockerfile" is
 * useful, and one that says "3 Dockerfiles: ./Dockerfile, _apps/web/Dockerfile, …" is more so. */
export const ChoreShapeSchema = z.object({
    // Architecture documents that actually exist (docs/architecture/**/doc.md), capped — the count is what
    // matters, and the drift survey needs to know there is something to re-read.
    docs: z.array(z.string()),
    dockerfiles: z.array(z.string()),
    // CI pipeline definitions: .github/workflows/*.yml, .gitlab-ci.yml, and the other single-file conventions.
    ci: z.array(z.string()),
    // Whether dependencies are resolved to a lockfile — what makes an audit mean anything.
    lockfile: z.boolean(),
    // A package.json at the repo root. The gate for every chore whose subject is the JavaScript dependency tree:
    // a Rust or Go repository has no majors to be behind on and no engines field to be pinned by, and offering it
    // those chores would be this surface guessing at what it is looking at.
    packageManifest: z.boolean(),
    /* EVERY DEPENDENCY NAME DECLARED ANYWHERE IN THE REPO — the root manifest's blocks unioned with every
     * workspace package's, sorted and deduplicated.
     *
     * It is here rather than derived from `packages` because `packages` is EMPTY for a repository that is not a
     * pnpm workspace, and the repositories these names exist to recognise — a Vite app, a Next app, an Angular
     * CLI project — are overwhelmingly single-package. A framework gate built on `packages` would be dark in
     * exactly the repositories it was written for, silently, which is the worst way for a gate to be wrong.
     *
     * NAMES, not a `framework: "react"` verdict. Which names amount to "this is a React app" is a product
     * decision, and product decisions live in the chore book that ships with the browser — a daemon baked into an
     * image months ago must not be the thing that decides Svelte is not a UI framework. */
    deps: z.array(z.string()),
});
export type ChoreShape = z.infer<typeof ChoreShapeSchema>;

export const ChoreSignalsSchema = z.object({
    packages: z.array(ChorePackageSchema),
    shape: ChoreShapeSchema,
    hotspots: z.array(WorkspaceHotspotSchema),
    keyModules: z.array(WorkspaceKeyModuleSchema),
    totals: z.object({ files: z.number(), symbols: z.number(), complexity: z.number(), hotspots: z.number() }),
    // Whether the index these rankings came from is current. A chore must not fire on a half-built index, and
    // this is how the browser knows to hold its verdict rather than act on a partial ranking.
    indexed: z.boolean(),
});
export type ChoreSignals = z.infer<typeof ChoreSignalsSchema>;

// What a finished chore turn left behind — written by the agent, read back to decide whether the chore is still
// due. `clean` is the load-bearing one: an agent that looked and found the tool's findings to be false positives
// must be able to say so, or the next poll starts the same turn again forever.
export const ChoreOutcomeSchema = z.enum(["acted", "reported", "clean"]);
export type ChoreOutcome = z.infer<typeof ChoreOutcomeSchema>;

/* One chore's history in one repo. The DIGEST is what makes this a debounce rather than a suppression: it is a
 * hash of the evidence that was standing when the turn ran, so a chore whose evidence has since changed is due
 * again on its own merits while one whose evidence is unchanged stays quiet — with the run still visible in the
 * panel, saying when it ran and what it concluded. Nothing here can hide a chore from the view; it only decides
 * whether the rail is allowed to speak. */
export const ChoreLedgerEntrySchema = z.object({
    repo: z.string(),
    chore: z.string(),
    ranAt: z.number(),
    runId: z.string(),
    outcome: ChoreOutcomeSchema,
    digest: z.string(),
    // Set by the owner from the panel — the chore stays visible and stays out of the badge until this passes.
    // Distinct from opting out, which is the absence of the chore from `enabled` in the sandbox's settings.
    snoozedUntil: z.number().optional(),
});
export type ChoreLedgerEntry = z.infer<typeof ChoreLedgerEntrySchema>;

// GET /chores — every discovered repo's standing evidence, plus the ledger, in one read. One route rather than
// one per repo because the rail badge scans ALL of them on a timer, and N requests a minute to answer "is
// anything due" is the kind of poll that shows up in a battery graph.
export const ChoresReportSchema = z.object({
    repos: z.array(z.object({ repo: z.string(), probes: z.array(ProbeResultSchema), signals: ChoreSignalsSchema })),
    ledger: z.array(ChoreLedgerEntrySchema),
    // The daemon's own runtime, for the chore that asks whether this sandbox is running something end-of-life.
    // Read off the process rather than a manifest: what is INSTALLED is the fact that matters, and an `engines`
    // range is a wish.
    node: z.string(),
});
export type ChoresReport = z.infer<typeof ChoresReportSchema>;

// POST /chores/probe — force one probe to re-run now, ahead of its TTL. Returns immediately; the runner does the
// work and the next GET /chores carries the result, the same shape the panel already polls.
export const ChoreProbeRequestSchema = z.object({ repo: z.string().min(1), id: ProbeIdSchema });
// POST /chores/ledger — record a run, or snooze. Written daemon-side rather than by the browser so a chore turn
// started from anywhere (the panel, an automation, the agent itself) lands in one ledger.
export const ChoreLedgerWriteSchema = ChoreLedgerEntrySchema;
