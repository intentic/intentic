import { z } from "zod";
import { ChildRunSchema } from "../../events/requests.js";
import { TRANSLATOR_PROVIDERS, type TranslatorProvider } from "../../models/provider-specs.js";
import { AgentHarnessSchema, AgentProviderSchema, EditorContextSchema } from "../agent.js";
import { MENTION_LIMIT } from "../../text/mentions.js";
// Headroom is one shape shared by every provider, not a Claude idea others imitate: a native account and a routed
// subscription differ in who holds the credential, never in what a reading is. Every surface that draws a percentage
// reads this one type.

// Which models a pool gates, decided once by the reader that parsed it, so every picker answers from one fact instead
// of re-deriving it.
// all: every model on this plan spends it.
// none: nothing spends it; still shown, never binding.
// { models }: scoped to models matching these names (whole-word match against id and label).
export const WindowGatesSchema = z.union([z.literal("all"), z.literal("none"), z.object({ models: z.array(z.string().min(1)).min(1) })]);
export type WindowGates = z.infer<typeof WindowGatesSchema>;

// `kind` is the provider's own key (a string, not an enum): an unrecognised pool shows under its raw key rather than
// folding into a neighbour. `label` wins over anything inferred; `resetsAt` is epoch seconds.
export const UsageWindowSchema = z.object({
    kind: z.string(),
    label: z.string().optional(),
    utilization: z.number(), // 0-100
    resetsAt: z.number().optional(),
    gates: WindowGatesSchema,
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
// A failed re-read, whatever the cause: a 429 park, a 403 asking for verification, a 5xx, a timeout. Recorded as the fact
// "the last attempt failed", never inferred from a list of known failure kinds, so a surface that dates readings by
// age can leave out every reading that cannot move, including one whose failure nobody has seen before.
export const UsageUnreadSchema = z.object({
    since: z.number().describe("When re-reading this account first failed, in milliseconds. It has failed on every attempt since."),
    reason: z
        .string()
        .describe("Why, in the provider's own words where it gave some (\"Verify your account to continue.\"). Short enough to print; never a pasted response body."),
});
export type UsageUnread = z.infer<typeof UsageUnreadSchema>;
// Every window kept, not just the binding one, since which pool binds changes between turns. Utilization only climbs
// within a window, so a stale reading is still a valid floor. `measuredAt` is epoch ms — windows are seconds.
export const AccountUsageSchema = z.object({
    windows: z.array(UsageWindowSchema),
    measuredAt: z.number(),
    unread: UsageUnreadSchema.optional().describe(
        "Present while re-reading this account keeps failing: these windows are the last reading that succeeded, and `measuredAt` will not move until a read succeeds again.",
    ),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;
// Who has to act for a blocked account, which is the only thing a surface chooses its instruction by: the reason is the
// words for a person, never a key.
export const AccountFixSchema = z.enum(["reconnect", "admin", "wait"]);
export type AccountFix = z.infer<typeof AccountFixSchema>;
// Whether an account can serve a turn, decided once by the daemon (models/plan-pools.ts `serviceState`) from every fact
// it holds about it: a revoked sign-in, a lost seat, a translator bench, a refusal still standing, and its plan limits.
// Every picker (an unnamed turn, a limit move, a keep-warm refresh) and every surface reads this one verdict.
export const AccountStateSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("ready"),
        room: z
            .number()
            .describe("How much of the fullest pool that gates the turn is left, in percent (above 0, up to 100). Pickers take the most room."),
    }),
    z.object({
        kind: z.literal("spent"),
        reopensAt: z
            .number()
            .optional()
            .describe("When every full pool has reopened, in epoch seconds, where the plan publishes it. Absent means unknown, never now."),
    }),
    z.object({
        kind: z.literal("blocked"),
        fix: AccountFixSchema.describe(
            "Who can make it serve again: `reconnect` (sign in again on this sandbox), `admin` (an organisation admin hands the seat back), or `wait` (it lifts by itself, at `until` where known).",
        ),
        reason: z.string().describe("Why, in words a person can act on: the provider's own sentence where it gave one."),
        until: z.number().optional().describe("When waiting lifts it, in epoch seconds, for `wait` only."),
    }),
    z.object({ kind: z.literal("unknown").describe("Nothing blocks it and nothing has been measured: usable, never read as room.") }),
]);
export type AccountState = z.infer<typeof AccountStateSchema>;
// Anthropic's once-a-week reset of the session window only; the weekly allowance is untouched. The answer is entirely
// the provider's — never infer `available` from a 100% window. `reason` is its own word, carried verbatim.
export const LimitResetStatusSchema = z.object({
    available: z
        .boolean()
        .describe("Whether the provider will reopen this account's session window right now. The only thing a button may be drawn from."),
    reason: z
        .string()
        .optional()
        .describe("Why not, in the provider's own word, when it gave one. Absent when it is available, or when the provider said nothing."),
    // Epoch seconds, like every reset instant on this wire.
    nextAvailableAt: z
        .number()
        .optional()
        .describe("When the next reset may be claimed, in epoch seconds, where the provider publishes it. Absent means unknown, never 'now'."),
    weeklyResetsAt: z.number().optional().describe("When the weekly allowance itself reopens, in epoch seconds, where the provider publishes it."),
});
export type LimitResetStatus = z.infer<typeof LimitResetStatusSchema>;
// Only `reset` changed anything; the rest are all "nothing happened" but kept apart since each is owed a different next
// step (wait, retry, this account never had it). Never throws: a failed claim leaves the account as it was.
export const LimitResetClaimSchema = z.object({
    result: z
        .enum(["reset", "already_used", "not_limited", "ineligible", "unavailable", "error"])
        .describe("What the provider did. Only `reset` reopened the window; every other value means nothing changed."),
    nextAvailableAt: z.number().optional().describe("When another reset may be claimed, in epoch seconds, where the provider published it."),
    detail: z.string().optional().describe("What went wrong, in words, for the two outcomes that are this sandbox's fault rather than the plan's."),
});
export type LimitResetClaim = z.infer<typeof LimitResetClaimSchema>;
// Observed and exact, unlike a polled usage snapshot that can be stale; keyed by provider, not account, since a routed
// turn doesn't know which served it. `kind` is read off what the provider said, not the frame code.
export const ProviderRefusalSchema = z.object({
    // Read side by side with `AccountUsage.measuredAt` (also ms).
    at: z.number().describe("When it refused, in milliseconds."),
    // Only a turn that actually runs settles an entitlement refusal — nothing else can.
    kind: z
        .enum(["limit", "auth", "entitlement"])
        .describe(
            "Three different noes, kept apart because what fixes each is different. A spent allowance is answered by waiting; a refused credential by signing in again; and an entitlement refusal, where somebody has switched this off for your seat, by neither of those. That last one authenticates fine and reports healthy limits the whole time it refuses everything.",
        ),
    message: z.string().describe("The provider's own words, verbatim. The only part that says which limit or which credential."),
    // Known for native turns only; a routed turn doesn't say which account served it.
    account: z.string().optional().describe("Which account was serving, where that is known."),
    // Lets a `limit` refusal be read against the pool that model spends (`UsageWindow.gates`), not the account's
    // fullest pool.
    model: z.string().optional().describe("Which model the refused turn was on, where that is known."),
});
export type ProviderRefusal = z.infer<typeof ProviderRefusalSchema>;
export const ProviderRefusalsSchema = z.object({
    refusals: z
        .record(z.string(), ProviderRefusalSchema)
        .describe(
            "The most recent refusal per provider. Read alongside an account's usage: that says how full it was when last checked, this says whether it has since started saying no.",
        ),
});
export type ProviderRefusals = z.infer<typeof ProviderRefusalsSchema>;
// `name` is CLIProxyAPI's auth-file name, the stable key a disconnect addresses; `label` is the reported sign-in
// identity (email, else the file name).
export const TranslatorAccountSchema = z.object({
    name: z.string(),
    label: z.string(),
    // Same shape as `OauthAccount`'s, so account rows are one list. Absent for a provider this sandbox can't read quota
    // from (Grok) — still renders, as a dot not a ring.
    usage: AccountUsageSchema.optional(),
    // The one live fact a quota read can't produce: CLIProxyAPI benches an auth file the instant upstream refuses it
    // (quota, expired token) and routes around it until `until`. Absent means the proxy is routing to it.
    cooling: z
        .object({
            // Epoch seconds, like every reset on this wire. Absent means no wait lifts this one, which is what
            // separates a rate-limited credential from one a person has to fix (a Google account with no Antigravity
            // project); every headroom surface reads it that way.
            until: z.number().optional(),
            // Why, in the words of what is missing: the proxy's own sentence where it gave one short enough to print,
            // else this sandbox's. Never a pasted upstream body.
            reason: z.string().optional(),
        })
        .optional(),
    state: AccountStateSchema.optional().describe(
        "Whether it can serve a turn now, judged from everything above plus the provider's last refusal. Absent from a daemon older than this field.",
    ),
});
export type TranslatorAccount = z.infer<typeof TranslatorAccountSchema>;
// A list per provider, not a flag: CLIProxyAPI holds several auth files per provider and balances across them. Built
// from the same derived list as `KeyedProviderSchema`, so the two can't drift apart.
export const TranslatorAccountsSchema = z.object(
    Object.fromEntries(TRANSLATOR_PROVIDERS.map((provider) => [provider, z.array(TranslatorAccountSchema)] as const)) as Record<
        TranslatorProvider,
        z.ZodArray<typeof TranslatorAccountSchema>
    >,
);
export type TranslatorAccounts = z.infer<typeof TranslatorAccountsSchema>;
// Un-parks a turn waiting on the user; every interactive card parks on one registry keyed by `requestId`, so one route
// resolves all of them, and `kind` says which card answered.
export const AgentReplySchema = z.discriminatedUnion("kind", [
    // Approving sets `bypassPermissions` on the SDK session; the container, not per-tool prompts, is the isolation
    // boundary on both sides of this card, since planning asks nothing either.
    z.object({
        kind: z.literal("plan").describe("Answering a plan the agent proposed."),
        requestId: z.string().min(1).describe("Which card you are answering, from the frame that raised it."),
        approve: z
            .boolean()
            .describe(
                "Whether to go ahead. Approving means the plan then runs without a prompt per tool, because being asked whether a plan you just approved may run its first command is not a question worth having.",
            ),
        feedback: z.string().optional().describe("Why not, which goes back to the model as the reason."),
    }),
    // Keyed by question text, valued by chosen option label(s), including free-text "Other".
    z.object({
        kind: z.literal("question").describe("Answering a question the agent asked."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        answers: z
            .record(z.string(), z.array(z.string()))
            .optional()
            .describe("What you chose, keyed by the question, with the chosen labels or your own words."),
        cancelled: z
            .boolean()
            .optional()
            .describe("Dismissing it instead, which tells the agent to carry on using sensible defaults rather than leaving it waiting."),
    }),
    // "always" may be narrowed further by the SDK's own suggestions.
    z.object({
        kind: z.literal("permission").describe("Answering a request to use a tool."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        decision: z
            .enum(["once", "always", "deny"])
            .describe("Once allows this call alone; always allows that whole tool for the rest of the conversation; no blocks it."),
        feedback: z.string().optional().describe("Why not, which goes back to the model as the reason."),
        // Whole, not a patch: effort or an account named for one model means nothing on another.
        child: ChildRunSchema.optional().describe(
            "For a request to start a child agent: what to start it on instead of what the agent asked for. It replaces the whole run (model, account, effort and the rest), not only the fields it names. Ignored with a no, and on any other request.",
        ),
    }),
    z.object({
        kind: z
            .literal("browser_help")
            .describe("Answering a request for help in the agent's browser: a captcha, a password it does not hold, a check on your phone."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        helped: z
            .boolean()
            .describe(
                "Whether you cleared it. Yes means the turn carries on from the page as you left it; no tells the agent so, and it moves on rather than waiting for ever.",
            ),
        note: z.string().optional().describe("Anything the agent should know, which goes back to it either way."),
    }),
    z.object({
        kind: z
            .literal("terminal_help")
            .describe("Answering a request for help at a terminal: a code to type, a confirmation only a person can give."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        helped: z
            .boolean()
            .describe(
                "Whether you did it. Yes also hands the agent what the terminal now says, because a person answering a prompt is exactly the moment the agent cannot see.",
            ),
        note: z.string().optional().describe("Anything the agent should know, which goes back to it either way."),
    }),
    z.object({
        kind: z.literal("capability_offer").describe("Answering a request to connect something the agent needs."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        connect: z
            .boolean()
            .describe(
                "Yes keeps the agent waiting while you set it up, and it carries on the moment the connection comes alive. No tells it to continue without. The reply itself connects nothing: setting it up is still your own doing.",
            ),
    }),
    z.object({
        kind: z.literal("payment_offer").describe("Answering a request to pay for something."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        approve: z
            .boolean()
            .describe("Yes releases exactly one payment. Anything else spends nothing. This click is the only way the money can move."),
    }),
    // The one reply whose sender is checked: the daemon verifies identity against the card's named list and refuses
    // anyone else, including a `no` — otherwise a stranger could deny-of-service the approver.
    z.object({
        kind: z.literal("credential_offer").describe("Releasing a credential the agent may only use once a named person says so."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        approve: z
            .boolean()
            .describe(
                "Yes releases it, as far as the card says (this one use, or the rest of the conversation). Only the people the card names can answer at all, yes or no.",
            ),
    }),
]);
export type AgentReply = z.infer<typeof AgentReplySchema>;
// Every card a turn can park on its person with, one per reply kind, so a new card reaches every park reader at once.
export type ParkKind = AgentReply["kind"];
export const PARK_KINDS: readonly ParkKind[] = AgentReplySchema.options.map((option) => option.shape.kind.value);
const PARKING = new Set<string>(PARK_KINDS);
export const isParkKind = (kind: string): kind is ParkKind => PARKING.has(kind);
// A message injected into a running turn between tool calls; NOT_FOUND when none is steerable, and the client queues it
// as the next turn instead. Carries everything a fresh prompt can (files, editor context).
export const SteerSchema = z
    .object({
        conversationId: z.string().min(1).describe("Which running conversation to interrupt."),
        text: z.string().max(20_000).describe("What to say to it. It arrives mid-turn without stopping the turn."),
        messageId: z
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe(
                "Your id for this message. Sending again under an id the sandbox already took is answered with what it did with it the first time, never a second delivery. Leave it out and the sandbox names the message itself.",
            ),
        attachments: z
            .array(z.string().min(1))
            .max(20)
            .optional()
            .describe("Files to send with it, as workspace paths. A screenshot dropped in mid-turn with no words is a legitimate thing to send."),
        // Same split as a turn's: a guessed path is dropped, only a chosen attachment can refuse the steer.
        mentions: z
            .array(z.string().min(1))
            .max(MENTION_LIMIT)
            .optional()
            .describe(
                "Workspace paths the message mentions with `@`. Unlike attachments, one that escapes the workspace or names no file is ignored rather than refused.",
            ),
        editorContext: EditorContextSchema.optional().describe("What you have open, folded in so that pointing words resolve."),
    })
    // An attachment-only steer (a screenshot dropped in mid-turn) is legal; an entirely empty one is not.
    .refine((steer) => steer.text.trim().length > 0 || (steer.attachments?.length ?? 0) > 0, {
        message: "text or attachments required",
    });
// True cancel, aborted daemon-side; unlike closing the /agent fetch, which sends no cancel frame. A stop names the run
// it means, so one arriving after that run settled cannot cancel whatever the conversation started next.
export const StopTurnSchema = z.union([
    z.object({
        conversationId: z.string().min(1).describe("Which conversation's running turn to cancel."),
        run: z
            .string()
            .min(1)
            .describe(
                "The run you mean to cancel, as starting or attaching to it named it. If another turn has started since, nothing is cancelled and the answer names the one running instead.",
            ),
    }),
    // A send not yet answered has no run to name, only the id it gave its message.
    z.object({
        conversationId: z.string().min(1).describe("Which conversation's running turn to cancel."),
        messageId: z
            .string()
            .min(1)
            .describe(
                "The message you sent, while its run is not named yet: cancels the turn it is in. If none is, nothing is cancelled: the message has not become a turn, or its turn has already ended.",
            ),
    }),
    // Only for a turn nobody can name: one the sandbox runs with no run to attach to (a scheduled automation's).
    z.object({
        conversationId: z.string().min(1).describe("Which conversation's running turn to cancel."),
        live: z
            .literal(true)
            .describe("Cancel whatever turn is running now, whichever that is. Only for a turn you cannot name: one that has no run to attach to."),
    }),
]);
export type StopTurn = z.infer<typeof StopTurnSchema>;
export const StopResultSchema = z.object({
    stopped: z.boolean().describe("Whether a turn was cancelled."),
    running: z.string().optional().describe("The run that is live instead of the one you named, left running. Absent when nothing else runs."),
});
export type StopResult = z.infer<typeof StopResultSchema>;
// The press carries WHO serves the re-run; the daemon keeps WHAT the turn is (prompt, attachments, worktree) from its
// own record, since re-deriving from a stripped client transcript would replay a different turn.
export const ResumeRoutingSchema = z.object({
    agent: AgentProviderSchema.describe("Which provider serves the re-run."),
    harness: AgentHarnessSchema.describe("Which agentic loop runs it."),
    account: z
        .string()
        .optional()
        .describe(
            "Which of that provider's accounts pays for it. Leave it out to keep the account the conversation runs on, or, on another provider, to take whichever of its accounts can serve with the most room. Moving to another account of the same provider is `switchAccount`'s job; naming one here still works.",
        ),
    // A client whose catalog hasn't loaded has nothing to send; the turn's own model is the better fallback.
    model: z.string().optional().describe("Which model. Leave it out to keep the one the refused turn named."),
    // A session is a file the daemon keeps; a credential is an env var. That's what lets a same-provider account switch
    // resume the existing session instead of opening a fresh one.
    carry: z
        .boolean()
        .optional()
        .describe(
            "When the account changes, keep the provider session (the model keeps everything, and re-reads all of it once on the other account) rather than opening a fresh one seeded from the record. Ignored when the provider changes, or when nothing changes.",
        ),
});
export type ResumeRouting = z.infer<typeof ResumeRoutingSchema>;
// Returns an ordinary `StartedTurn`; the caller attaches to it like any turn someone else started. A resume note on the
// prompt tells an attaching window to reuse the existing bubble, not redraw it.
export const ResumeTurnSchema = z.object({
    conversationId: z.string().min(1).describe("Which conversation's held turn to run again."),
    routing: ResumeRoutingSchema.optional().describe(
        "Who serves the re-run, when the conversation has been re-pointed since it was refused. Leave it out to run it on whatever the turn carried.",
    ),
});
// Names one queued message as it was read, so a change made against an older copy is refused rather than written over
// somebody else's.
export const QueuedMessageRefSchema = z.object({
    conversationId: z.string().min(1).describe("Whose queue."),
    id: z.string().min(1).describe("Which waiting message."),
    revision: z
        .number()
        .int()
        .nonnegative()
        .describe("The message's revision as you read it. If it has been changed since, from this window or another, nothing happens."),
});
export type QueuedMessageRef = z.infer<typeof QueuedMessageRefSchema>;
export const QueueEditSchema = QueuedMessageRefSchema.extend({
    text: z.string().describe("What the message should say instead. It keeps its place in the queue."),
});
export type QueueEdit = z.infer<typeof QueueEditSchema>;
export const QueueResumeSchema = z.object({
    conversationId: z.string().min(1).describe("Whose queue to let go."),
    routing: ResumeRoutingSchema.optional().describe(
        "Who serves the turn the waiting messages start, when the conversation has been re-pointed since they were queued: the usual answer to a refusal that held them. Leave it out to send them as they were queued.",
    ),
});
export type QueueResume = z.infer<typeof QueueResumeSchema>;
// Moves a conversation to another account of the provider it runs on: the one command that changes who pays, so the
// account a conversation runs on is always the daemon's record and never a window's guess.
export const SwitchAccountSchema = z.object({
    conversationId: z.string().min(1).describe("Which conversation to move."),
    account: z.string().min(1).describe("Which of the conversation's provider's connected accounts pays for its turns from now on."),
    carry: z
        .boolean()
        .optional()
        .describe(
            "Keep the provider session across the move (the model keeps everything, and re-reads all of it once on the other account) rather than opening a fresh one seeded from the record.",
        ),
});
export type SwitchAccount = z.infer<typeof SwitchAccountSchema>;
export const AccountSwitchedSchema = z.object({
    run: z
        .string()
        .optional()
        .describe("The run that re-ran a held turn on the new account, when one was waiting: attach to it. Absent when nothing was held."),
});
export type AccountSwitched = z.infer<typeof AccountSwitchedSchema>;
