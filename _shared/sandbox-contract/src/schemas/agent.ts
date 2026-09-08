import { z } from "zod";
import { CONVERSATION_ID } from "../ids/conversation-ids.js";
import { ModelRoleSchema } from "../models/model-roles.js";
import { NATIVE_PROVIDERS } from "../models/provider-specs.js";
import { AgentPlacementSchema } from "../protocol/runner-protocol.js";
import { entryId } from "./internal.js";
// Agent runtimes the daemon can serve: native providers have dedicated adapters, `endpoint/<id>` names an installed
// endpoint capability, anything else is an ACP agent capability id. A bare string, not an enum, so an unknown id is a
// clean error, not a contract change.
export const AgentProviderSchema = z.string().min(1);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
// Provider naming a catalog in providers.contract.ts; an enum, not the open string above, since only native providers
// have a daemon-held catalog to look up. An unknown id is a 400 here, not an empty list.
export const NativeProviderParamSchema = z.object({ provider: z.enum(NATIVE_PROVIDERS) });
// The harness (agentic loop) a turn runs on, orthogonal to the provider.
export const AgentHarnessSchema = z.enum(["native", "claude-code"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
// One repo at one immutable commit; used both as the checkout instruction and as handoffs' comparison base, so a
// multi-repo run has one provenance record instead of a hard-coded branch name.
export const RepoBaseSchema = z.object({ repo: z.string(), base: z.string().min(1) });
export type RepoBase = z.infer<typeof RepoBaseSchema>;
// What the user has open in the editor, attached only when they opt in (composer chip, off by default); folded into the
// prompt so deictic prompts ("fix this") resolve.
export const EditorContextSchema = z.object({
    file: z.string().min(1).describe("The file open in the editor, as a workspace path."),
    startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("First line of the selection, counting from one. Leave both out when the whole file is the context."),
    endLine: z.number().int().min(1).optional().describe("Last line of the selection, counting from one."),
    // Truncated client-side to the cap before it's sent.
    selection: z
        .string()
        .max(20_000)
        .optional()
        .describe("The selected text itself. Cut it down before sending if it is long: this is context, not an upload."),
});
export type EditorContext = z.infer<typeof EditorContextSchema>;
// Client-minted stable conversation id; the regex is an injection guard, since isolated conversations also use it in
// branch names and filesystem paths.
export const ConversationIdSchema = z.string().regex(CONVERSATION_ID);
// Where a conversation came from when nobody typed it into the browser: an automation wake carrying an outside message.
// Set daemon-side by the receiving dispatcher; the browser never sends one.
export const AgentOriginSchema = z.object({
    // The automation whose configured prompt opened the conversation.
    automationId: z.string(),
    // Listener provider that received the message, or "webhook" for an event trigger; open string, sources are
    // extension-declared.
    provider: z.string(),
    // External thread it arrived on (Discord channel id, widget conversation id); absent for webhooks.
    channelId: z.string().optional(),
    // Who sent it, as the source names them.
    author: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;
// The class of thing asking to start a session, the admission policy's key space; derived daemon-side, never sent by a
// client. Chat and loops are absent since both begin with the owner's own click.
export const WakeSourceSchema = z.enum(["schedule", "event", "listener", "webchat", "issues", "workspace", "workflow"]);
export type WakeSource = z.infer<typeof WakeSourceSchema>;
// One admission verdict the owner can configure: let it run, hold it for approval, or refuse it outright.
export const AdmissionRuleSchema = z.enum(["allow", "hold", "deny"]);
export type AdmissionRule = z.infer<typeof AdmissionRuleSchema>;
// Where a command would run; the same string means different things on each machine (rm -rf /usr is recoverable here,
// fatal on a laptop). Read with a locus (command-classes.ts CommandContext); callers must state one rather than
// default.
export const CommandLocusSchema = z.enum([
    // This sandbox's own shell: a disposable container, /work a git worktree, /history every other agent's.
    "sandbox",
    // One of the owner's own computers, reached through the machine agent. Nothing here is disposable.
    "device",
]);
export type CommandLocus = z.infer<typeof CommandLocusSchema>;
// What kind of thing a shell command is, the command gate's key space under the admission floor; gates one command
// inside an already-running session. Six classes, chosen because each is hard or impossible to undo somewhere.
export const CommandClassSchema = z.enum([
    // Rewrites or discards committed work: force-push, hard reset, force-delete a branch, clean -f, filter-branch.
    "git.destructive",
    // Recursive-force deletion (`rm -rf`), and its spelling in a script (`fs.rm(p, { recursive: true })`).
    "files.destructive",
    // State nothing recovers at this locus; which roots count (/, /history in the sandbox) depends on the locus.
    "system.destructive",
    // A container volume or its data; the sandbox's blast radius (nested engine) differs sharply from a device's.
    "container.state",
    // Reads credential material: a secret reference, or a file confirmed to actually hold one.
    "secrets.access",
    // Publishes outward and irreversibly: npm/pnpm/yarn/cargo publish, gh release create, docker push.
    "package.publish",
    // curl/wget to a non-local address, the general exfiltration channel under the per-provider actionRules.
    "network.outbound",
]);
export type CommandClass = z.infer<typeof CommandClassSchema>;
// Workspace-wide admission floor per wake source, consulted on every outside-driven wake; composes with per-automation
// overrides most-restrictive-wins. `workflow` is allow|deny only, since a hold there is indistinguishable from a CI
// runner's timeout.
export const AdmissionPolicySchema = z.object({
    schedule: AdmissionRuleSchema.default("allow"),
    event: AdmissionRuleSchema.default("allow"),
    listener: AdmissionRuleSchema.default("allow"),
    webchat: AdmissionRuleSchema.default("allow"),
    // Defaults to hold, unlike the others: a bug-report wake has full repo powers and a stranger's stack trace as its
    // brief.
    issues: AdmissionRuleSchema.default("hold"),
    workspace: AdmissionRuleSchema.default("allow"),
    workflow: z.enum(["allow", "deny"]).default("allow"),
});
export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;
// How tool calls are gated, the Claude Agent SDK's PermissionMode narrowed to the four the composer offers. Both a turn
// input and the payload of the `mode` frame, since the agent can move itself between them mid-turn.
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
// Where a conversation was cut from, the durable half of a fork, carried on the registry entry. `index` is the message
// the cut sat above in the source, so its transcript can put the mark back.
export const ForkedFromSchema = z.object({
    conversationId: ConversationIdSchema,
    index: z.number().int().nonnegative(),
    // Which files this fork opened on; kept so the fork can still say it later, not only right after the click.
    files: z.enum(["then", "now"]),
});
export type ForkedFrom = z.infer<typeof ForkedFromSchema>;
export const AgentTurnSchema = z
    .object({
        prompt: z.string().describe("What to say to the agent. May be empty if you are only attaching files."),
        // Seeds a fresh registry entry's title; an existing entry's title always wins over this.
        title: z
            .string()
            .max(80)
            .optional()
            .describe("A title for a conversation this turn is opening. Ignored for a conversation that already has one."),
        // Already uploaded via /workspace/upload; Claude reads them via Read, Codex gets images as native input.
        attachments: z
            .array(z.string().min(1))
            .max(20)
            .optional()
            .describe("Files to hand the agent along with the prompt, as workspace paths. Upload them first."),
        // Which provider serves the turn, absent = claude; a sessionId resumes only on the provider that minted it.
        agent: AgentProviderSchema.optional().describe("Which model provider serves this turn. Leave it out for Claude."),
        // Which agentic loop runs the turn, absent = provider's own; "claude-code" forces the SDK loop for any
        // provider.
        harness: AgentHarnessSchema.optional().describe("Which agentic loop runs the turn. Leave it out to use each provider's own."),
        // Which connected account of that provider serves the turn; absent = the provider's first account.
        account: z.string().optional().describe("Which of that provider's connected accounts pays for the turn. Leave it out for the first one."),
        // Distinct from `account` (who pays): whose name the turn posts as; absent means something different for each
        // mode.
        actsAs: entryId.optional().describe("Which persona the turn speaks as out in the world. Not the same as which account pays for it."),
        sessionId: z.string().optional().describe("Resume this provider session instead of starting a fresh one."),
        // Stable id surviving provider/account/harness switches; keys the registry entry, the turn run, and the
        // worktree when isolated.
        conversationId: ConversationIdSchema.optional().describe(
            "The conversation this turn belongs to. You choose it, it survives model switches, and it is how you address the conversation later. Naming one that does not exist opens it.",
        ),
        // Runs in the conversation's own git worktree (created lazily) instead of shared /work; requires
        // conversationId.
        isolated: z
            .boolean()
            .optional()
            .describe(
                "Work in this conversation's own private copy of the repos rather than the shared tree, so several agents can work at once. Needs a conversation id.",
            ),
        // Decided like `isolated`: the request's choice on the first turn, the registry's after. `runner` implies
        // isolation; absent means local.
        placement: AgentPlacementSchema.optional().describe(
            "Where this conversation runs: this sandbox (leave it out), or a paired runner by id. Decided on the first turn; later turns follow the conversation.",
        ),
        // Pins a new isolated conversation's worktree to these commits; a workflow step's candidates share one snapshot
        // and skip the ordinary rebase.
        worktreeBase: z
            .array(RepoBaseSchema)
            .min(1)
            .max(50)
            .optional()
            .describe(
                "Pin a new private copy to these exact commits instead of today's workspace. Used when several agents must start from identical files.",
            ),
        // Overrides landing for this turn only; a workflow step sets false so candidates can't leak in before synthesis
        // compares them.
        autoLand: z
            .boolean()
            .optional()
            .describe(
                "Whether this turn's work merges into the workspace when it finishes. Overrides the conversation's own setting for this turn only.",
            ),
        // Which per-job model list answers when nobody named a model or provider (turn-resume.ts); names the job, not a
        // tier, and never overrides an explicit pick.
        runRole: ModelRoleSchema.optional().describe(
            "What started this turn, when it was not a person typing: which of the sandbox's per-job model lists answers for it. Only used when the turn names no model of its own.",
        ),
        // Set only by the daemon's own dispatchers, never a client; requires conversationId to record it on.
        origin: AgentOriginSchema.optional().describe(
            "Set by the sandbox alone: this turn opened a conversation on behalf of a message from outside rather than a person.",
        ),
        // No `history` field: a provider/account/harness switch carries no transcript over the wire; the daemon seeds
        // the new session from its own conversationId-keyed record.
        // Where a fork was cut from, on its first turn only; requires conversationId, and files:"then" implies
        // isolated.
        forkOf: z
            .object({
                conversationId: ConversationIdSchema.describe("The conversation this one was cut from."),
                keep: z.number().int().nonnegative().describe("How many of that conversation's messages to copy in before this turn runs."),
                files: z
                    .enum(["then", "now"])
                    .describe(
                        'Which files the fork opens on: "now" is the workspace as it stands, "then" is the files as they were at the cut, which needs a private copy.',
                    ),
            })
            .optional()
            .describe("Where this conversation was cut from, on its first turn only. Only the client knows this, so only the client can say it."),
        // The browser sends the chosen model per turn; the provider token is the sandbox's own stored credential.
        model: z.string().optional().describe("Which model to use. Leave it out for the provider's default."),
        // True when a surface started the turn, not a person; the sandbox then fills the model from the owner's role
        // list for unwatched work.
        unattended: z
            .boolean()
            .optional()
            .describe(
                "Nobody chose a model for this turn because a screen started it rather than a person. The sandbox then fills in the model its owner picked for unwatched work.",
            ),
        // Outside content caused this turn, naming the source; distinct from `unattended` (whether anyone is watching).
        outsideWake: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Content from outside caused this turn, and what to call the source. It is what makes the sandbox treat the turn as carrying somebody else's words.",
            ),
        // How tool calls are gated for this turn (the SDK's permissionMode, verbatim):
        // plan: propose → approve → execute
        // default: prompts per tool on the permission side channel
        // acceptEdits: auto-accepts file edits
        // bypassPermissions: runs everything
        // The agent can move itself between modes mid-turn, riding back as a `mode` frame.
        permissionMode: PermissionModeSchema.optional().describe(
            "How tool calls are gated: ask each time, accept file edits, propose a plan first, or run everything. The agent can move itself between these mid-turn.",
        ),
        // Narrows the turn to these tool names (the SDK option, not the daemon's MCP `tools`/servers); absent means
        // everything the runtime has.
        allowedTools: z
            .array(z.string().min(1))
            .optional()
            .describe(
                "Narrow the turn to these tools. Leave it out for everything the runtime has. For a turn driven by an outside message this list is the real boundary, because prompt wording is only advice.",
            ),
        effort: z.string().optional().describe("How hard the model should think, where the provider offers a choice."),
        thinking: z.boolean().optional().describe("Whether to show the model's reasoning as it works."),
        // Requests the harness serve this turn faster at a higher price; a request, not a promise, the `fast_mode`
        // frame reports what happened.
        fast: z
            .boolean()
            .optional()
            .describe(
                "Ask for the same work at a higher rate for a higher price. A request rather than a promise: the answer says what actually happened.",
            ),
        // Vetoes automatic tier selection for this turn; the judge still runs and records its verdict, but nothing is
        // substituted.
        tierHold: z
            .boolean()
            .optional()
            .describe(
                "Run exactly the model that was picked, even when the turn looks simple enough for a cheaper one. The judgement is still recorded; nothing is substituted.",
            ),
        // The opt-in editor context chip: what the user is looking at, folded into the prompt daemon-side.
        editorContext: EditorContextSchema.optional().describe(
            'What the user has open in their editor, folded into the prompt so that pointing words like "this" resolve.',
        ),
    })
    // An attachment-only send (no text) is legal; an entirely empty turn is not.
    .refine((turn) => turn.prompt.trim().length > 0 || (turn.attachments?.length ?? 0) > 0, {
        message: "prompt or attachments required",
    })
    .refine((turn) => turn.isolated !== true || turn.conversationId !== undefined, {
        message: "isolated requires conversationId",
    })
    .refine((turn) => turn.worktreeBase === undefined || (turn.isolated === true && turn.conversationId !== undefined), {
        message: "worktreeBase requires an isolated conversationId",
    })
    .refine((turn) => turn.origin === undefined || turn.conversationId !== undefined, {
        message: "origin requires conversationId",
    })
    .refine((turn) => turn.forkOf === undefined || turn.conversationId !== undefined, {
        message: "forkOf requires conversationId",
    })
    // "then" needs a checkout of its own; rolling back the shared tree under everyone else is what it must never mean.
    .refine((turn) => turn.forkOf?.files !== "then" || turn.isolated === true, {
        message: 'forkOf.files "then" requires isolated',
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;
/* A MODEL CHOSEN FOR ONE SURFACE-STARTED RUN, what the caret on the shared run button (<AgentRunButton>) sends
 * along with the click that starts it.
 *
 * Shared rather than re-declared per route because every surface that starts an agent for the user now carries
 * that caret, and they must all mean the same thing by it: the pair rides onto the turn as `agent`/`model`, and
 * the daemon's own fill step then leaves it alone (turn-resume.ts fills only what is absent). ABSENT is the
 * ordinary case and the one to keep cheap, nobody touched the caret, so the turn's `runRole` list answers.
 *
 * Both halves or neither, because a model id is only meaningful to the provider that vends it: half a pick
 * would send a Codex model id to Claude. Routes that accept this pass it through verbatim; a model this build
 * has never heard of is a supported pick, since the picker offers a custom-id escape hatch.
 *
 * AND EVERYTHING ELSE THE PANEL CAN SET, which is the half this schema used to drop on the floor. A pinned entry
 * carries its own account, harness, effort, thinking and speed (ModelPinSchema), the daemon applies a pin's
 * knobs ONLY to a turn that named no model (turn-resume.ts), and the picker the caret opens offers every one of
 * them — so a pick that carried the pair alone moved each override onto the provider's own defaults for the
 * rest. That is worst exactly where the caret gets reached for: the one moment somebody opens it is the failure
 * that just beat the standing order, and a run re-pointed at a frontier model but not at the tier, the loop or
 * the account that model was pinned under is not the run they configured.
 *
 * The fields are AgentTurn's own (it carries all five already), so a route that accepts this spreads it onto
 * the turn verbatim. Every one is optional and absent means absent: the turn goes out without the field and the
 * model's own default answers. `thinking: false` is therefore a different statement from no thinking at all,
 * which is the distinction Claude's own refusal of `max` beside disabled thinking turns on. */
export const AgentRunPickSchema = z
    .object({
        agent: z.string().min(1).describe("Which provider."),
        model: z
            .string()
            .min(1)
            .describe("Which of its models. Both or neither, because a model name only means anything to the provider that serves it."),
        account: z
            .string()
            .optional()
            .describe("Which connected account of that provider pays, by its daemon-minted id. Leave it out for whichever has headroom."),
        harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it. Leave it out to use the provider's own."),
        effort: z
            .string()
            .optional()
            .describe("How hard that model should think, where it offers a choice. Leave it out to take the model's own default."),
        thinking: z.boolean().optional().describe("Whether this model reasons before it answers, where that is a choice it offers."),
        fast: z.boolean().optional().describe("Ask for this model's work at a higher rate for a higher price. A request rather than a promise."),
    })
    .optional();
export type AgentRunPick = z.infer<typeof AgentRunPickSchema>;
/* THE PICK A RUN BUTTON HOLDS, AS THE WIRE SPELLS IT. The picker answers in the shell's own vocabulary
 * (`provider`, the kit's AgentRunChoice) and a turn calls the same field `agent`, so every surface that starts
 * an agent had this translation written out by hand — seven of them, each re-deciding which fields to carry,
 * which is exactly how the tier came to travel from four of them and the account from none.
 *
 * ABSENT STAYS ABSENT, field by field: `undefined` means the turn goes out without it and the model's own
 * default answers, which is not the same as any value this could invent. */
export const runPickOf = (choice: {
    readonly provider: string;
    readonly model: string;
    readonly account?: string | undefined;
    readonly harness?: string | undefined;
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}): NonNullable<AgentRunPick> => ({
    agent: choice.provider,
    model: choice.model,
    ...(choice.account === undefined ? {} : { account: choice.account }),
    ...(choice.harness === undefined ? {} : { harness: choice.harness as AgentHarness }),
    ...(choice.effort === undefined ? {} : { effort: choice.effort }),
    ...(choice.thinking === undefined ? {} : { thinking: choice.thinking }),
    ...(choice.fast === undefined ? {} : { fast: choice.fast }),
});
/* ONE ENTRY OF ONE ROLE'S MODEL LIST (settings.modelRoles): the standing version of the pick above, and not
 * merely which model but HOW it is to be run.
 *
 * THE KNOBS RIDE THE ENTRY RATHER THAN THE LIST, which is the whole reason this is an object rather than a
 * `${provider}:${model}` string. The reasoning effort was once a single field beside a list, so one tier
 * answered for every model in it — and the entries of such a list are deliberately NOT interchangeable: it is a
 * frontier pin with the cheap account underneath that catches it when the first is spent. A tier scale is a
 * property of the MODEL as well ('max' is off Kimi's scale entirely, and off Claude's own the moment thinking
 * is switched off), so a shared effort was either off-scale for half the list or the lowest common rung for all
 * of it. Each entry carries what the composer's picker configures for the turn in front of you.
 *
 * THE SAME SHAPE FOR EVERY ROLE, one-shot helpers included, and that is a deliberate widening. A commit
 * message or a session title used to be pinnable by model alone, on the argument that the daemon runs those
 * with reasoning off and no effort, so a control for either would be a switch with nothing behind it. True of
 * the machinery, and it made the machinery the argument: an owner who pins a reasoning model to their commit
 * subjects was paying that model's price to have its distinguishing feature suppressed. The knobs now travel
 * through the one-shot path too, so an entry means the same thing wherever it is written.
 *
 * EVERY FIELD BUT THE PAIR IS OPTIONAL, AND ABSENT MEANS ABSENT: the work goes out without the field and the
 * provider's own default answers, exactly as an unconfigured pin always did. Nothing here invents a "low".
 *
 * NO TIER HOLD, and its absence is the rule rather than an omission: automatic tier selection gates on
 * `unattended` (prompt-complexity.ts), so a role-started run is never downgraded in the first place and a veto
 * over it would be a control whose state can make no difference to anything.
 *
 * The pair is BOTH HALVES for the reason the pick above is: a model id is only meaningful to the provider that
 * vends it, so half a pin would send a Codex id to Claude. Taken verbatim, never validated against a catalog:
 * the picker offers a custom-id escape hatch, so a model this build has never heard of is a supported pin. */
export const ModelPinSchema = z.object({
    provider: AgentProviderSchema.describe("Which provider serves this work."),
    model: z.string().min(1).describe("Which of its models. Both halves, because a model name only means anything to the provider that serves it."),
    effort: z
        .string()
        .optional()
        .describe("How hard this model should think, where it offers a choice. Leave it out to take the model's own default."),
    thinking: z.boolean().optional().describe("Whether this model reasons before it answers, where that is a choice it offers."),
    fast: z.boolean().optional().describe("Ask for this model's work at a higher rate for a higher price. A request rather than a promise."),
    harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it. Leave it out to use the provider's own."),
});
export type ModelPin = z.infer<typeof ModelPinSchema>;
// POST /agent's ack: the daemon-minted id of the detached run it started. The turn runs daemon-side regardless of any
// client connection; every window renders it via /agent/attach.
export const StartedTurnSchema = z.object({
    run: z.string().describe("The id of the run that just started. Hand it back when you attach, so the stream resumes rather than replaying."),
});
export type StartedTurn = z.infer<typeof StartedTurnSchema>;
// Attaches to a conversation's run (live, or finished within retention); no cursor to resume from, the head carries all
// rows. `run` names what the client was watching, so a newer run's head id tells it to catch up.
export const AttachTurnSchema = z.object({
    conversationId: ConversationIdSchema.describe("Which conversation to watch."),
    run: z
        .string()
        .optional()
        .describe("The run you were watching. If a newer turn has started since, the head names that one instead, and its rows are that turn's."),
});
export type AttachTurn = z.infer<typeof AttachTurnSchema>;
