import { z } from "zod";
import { TRANSLATOR_PROVIDERS, type TranslatorProvider } from "../models/provider-specs.js";
import { AgentHarnessSchema, AgentProviderSchema, EditorContextSchema } from "./agent.js";
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
// Every window kept, not just the binding one, since which pool binds changes between turns. Utilization only climbs
// within a window, so a stale reading is still a valid floor. `measuredAt` is epoch ms — windows are seconds.
export const AccountUsageSchema = z.object({
    windows: z.array(UsageWindowSchema),
    measuredAt: z.number(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;
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
            // Epoch seconds, like every reset on this wire; absent when the proxy named no retry instant.
            until: z.number().optional(),
            // The proxy's own sentence, when it gave one.
            reason: z.string().optional(),
        })
        .optional(),
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
    // boundary from here on.
    z.object({
        kind: z.literal("plan").describe("Answering a plan the agent proposed."),
        requestId: z.string().min(1).describe("Which card you are answering, from the frame that raised it."),
        approve: z
            .boolean()
            .describe(
                "Whether to go ahead. Approving means the plan then runs without asking again per tool, because being asked whether a plan you just approved may run its first command is not a question worth having.",
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
// A message injected into a running turn between tool calls; NOT_FOUND when none is steerable, and the client queues it
// as the next turn instead. Carries everything a fresh prompt can (files, editor context).
export const SteerSchema = z
    .object({
        conversationId: z.string().min(1).describe("Which running conversation to interrupt."),
        text: z.string().max(20_000).describe("What to say to it. It arrives mid-turn without stopping the turn."),
        attachments: z
            .array(z.string().min(1))
            .max(20)
            .optional()
            .describe("Files to send with it, as workspace paths. A screenshot dropped in mid-turn with no words is a legitimate thing to send."),
        editorContext: EditorContextSchema.optional().describe("What you have open, folded in so that pointing words resolve."),
    })
    // An attachment-only steer (a screenshot dropped in mid-turn) is legal; an entirely empty one is not.
    .refine((steer) => steer.text.trim().length > 0 || (steer.attachments?.length ?? 0) > 0, {
        message: "text or attachments required",
    });
// True cancel, aborted daemon-side; unlike closing the /agent fetch, which sends no cancel frame.
export const StopTurnSchema = z.object({ conversationId: z.string().min(1).describe("Which conversation's running turn to cancel.") });
// The press carries WHO serves the re-run; the daemon keeps WHAT the turn is (prompt, attachments, worktree) from its
// own record, since re-deriving from a stripped client transcript would replay a different turn.
export const ResumeRoutingSchema = z.object({
    agent: AgentProviderSchema.describe("Which provider serves the re-run."),
    harness: AgentHarnessSchema.describe("Which agentic loop runs it."),
    account: z.string().optional().describe("Which of that provider's accounts pays for it. Leave it out for the first one."),
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
