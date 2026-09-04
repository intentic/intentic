import { z } from "zod";
import { TRANSLATOR_PROVIDERS, type TranslatorProvider } from "../provider-specs.js";
import { AgentHarnessSchema, AgentProviderSchema, EditorContextSchema } from "./agent.js";
// Declared ABOVE both account shapes because both carry it: headroom is one idea in this product, not a Claude
// idea that other providers imitate. A native account (OauthAccount) and a routed subscription
// (TranslatorAccount) differ in who holds the credential and how the reading is taken, never in what a
// reading IS, so every surface that draws a percentage reads this one type and no other.

/* WHICH MODELS A POOL GATES, said by the reader that parsed it and carried on the wire, so every surface and
 * every picker answers "does this pool stand between me and THIS model" from one fact instead of six rules.
 *
 * A plan is not one allowance. Google meters Gemini separately from the Claude and GPT models it serves off the
 * same sign-in; a Claude plan carries a per-model weekly slice ("Opus", "Fable") beside its all-models pools;
 * ChatGPT publishes a code-review limit that no chat turn spends. Before this field the relation lived in six
 * places that disagreed (a static Google table, a Claude kind list, a max-over-everything ranking, a fullest-
 * window reset, and two client-side matchers), so a Google account with its Gemini pool spent drew a red ring
 * over Claude Opus, and a Claude account with its Opus slice spent was ranked "spent" for a Haiku call.
 *
 *   "all"      every model on this plan spends it: the 5-hour and weekly pools, Kimi's throttles.
 *   "none"     nothing a turn here runs spends it: a code-review limit, a surface-scoped pool for another
 *              product. Still shown, never binding.
 *   { models } a slice scoped to the models the names match. Names are matched as runs of whole words against
 *              the model id AND its label ("opus" is in "claude-opus-4-6" and in "Claude Opus 4.6"; "gemini"
 *              is in "gemini-3-pro"), see plan-pools.ts, because the plan names a pool by the vendor's word for
 *              the tier and nothing else connects the two.
 *
 * Decided by the READER, never inferred later: the payload is the only place the grouping is known, and it is
 * the plan's to change, so the fact travels with the reading it describes. */
export const WindowGatesSchema = z.union([z.literal("all"), z.literal("none"), z.object({ models: z.array(z.string().min(1)).min(1) })]);
export type WindowGates = z.infer<typeof WindowGatesSchema>;

// One plan-limit pool. `kind` is the provider's own key ('five_hour' | 'seven_day' | 'seven_day_opus' |
// 'seven_day_sonnet' | 'model:Fable' | …) rather than an enum we'd have to keep in step with the provider: an
// unrecognised pool is shown under its raw key, which is far better than being silently folded into a
// neighbour. `label` is the provider's OWN display name where it supplies one (the per-model buckets do), it
// wins over anything we'd infer, because the model names in a plan's limits are the provider's to rename.
// `resetsAt` is epoch SECONDS (matching the SDK's frame). `gates` says which models the pool stands in the way
// of, see WindowGatesSchema.
export const UsageWindowSchema = z.object({
    kind: z.string(),
    label: z.string().optional(),
    utilization: z.number(), // 0-100
    resetsAt: z.number().optional(),
    gates: WindowGatesSchema,
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
// (matching connectedAt), deliberately a different unit from the windows' seconds.
export const AccountUsageSchema = z.object({
    windows: z.array(UsageWindowSchema),
    measuredAt: z.number(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;
/* THE LAST TIME A PROVIDER ACTUALLY REFUSED A TURN, the other half of "can I run on this", and the half no
 * meter can supply.
 *
 * A snapshot above is POLLED and therefore always a floor: read at turn end (Claude) or on a five-minute sweep
 * (the routed subscriptions), and account-wide, so every other client on the plan spends the same pools without
 * this sandbox hearing about it. A refusal is the opposite kind of fact, observed, exact, and timestamped by
 * the only event that proves the plan said no. Between them they answer a question neither can alone: a green
 * meter beside "refused a turn 4 minutes ago" means the reading is stale, not that the account has room.
 *
 * Keyed by PROVIDER rather than by account, because that is the resolution the daemon honestly has. A native
 * Claude turn knows which account served it and names it; a routed turn does not. CLIProxyAPI picks the auth
 * file itself and only refuses once every credential it holds is cooling down, which makes the refusal a fact
 * about the provider in the first place.
 *
 * `kind` is read off what the provider SAID, not off the frame code the harness filed it under, because those
 * two disagree: Kimi answers a spent plan with `403 You've reached your usage limit for this billing cycle`,
 * which the CLI prints under "Failed to authenticate" and the stream codes as a refused credential. Sending
 * someone to reconnect a perfectly good account is the cost of believing the code over the sentence. */
export const ProviderRefusalSchema = z.object({
    // Epoch MS, matching AccountUsage.measuredAt, the two are read side by side.
    at: z.number().describe("When it refused, in milliseconds."),
    /* Three ways a plan says no, kept apart because WHAT ANSWERS EACH is different and a screen that conflates
     * them tells the user to do the wrong thing. A spent allowance is answered by a later reading with room in
     * it; a refused credential by the account being read at all through it; and an entitlement refusal, an
     * organization that has turned Claude Code off for this seat, by NOTHING either of those can produce. Its
     * token authenticates and its usage endpoint answers with real pools the whole time it cannot run a turn,
     * so filing it as `auth` let the very next quota sweep dismiss it and leave a full green ring over an
     * account that refused everything asked of it. Only a turn that actually runs settles this one. */
    kind: z
        .enum(["limit", "auth", "entitlement"])
        .describe(
            "Three different noes, kept apart because what fixes each is different. A spent allowance is answered by waiting; a refused credential by signing in again; and an entitlement refusal, where somebody has switched this off for your seat, by neither of those. That last one authenticates fine and reports healthy limits the whole time it refuses everything.",
        ),
    // The provider's own sentence, verbatim. It is the only part that says WHICH pool or WHICH credential.
    message: z.string().describe("The provider's own words, verbatim. The only part that says which limit or which credential."),
    // The account that was serving, when the daemon knows it (native turns only, see above).
    account: z.string().optional().describe("Which account was serving, where that is known."),
    // The model the refused turn ran, so a `limit` refusal can be read against the POOL that model spends
    // (UsageWindow.gates) rather than against the account's fullest pool, which on a plan that meters models
    // separately is routinely a different allowance from the one that said no.
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
// One connected subscription in the translator. `name` is CLIProxyAPI's auth-file name, the stable store key a
// disconnect addresses, and `label` the sign-in identity it reported (the account email, else the file name).
export const TranslatorAccountSchema = z.object({
    name: z.string(),
    label: z.string(),
    // The same headroom an OauthAccount carries, on the same field, for the same reason: the account rows are
    // one list to the reader. Optional because a provider whose quota this sandbox cannot read (Grok),
    // or one that did not answer, must still render as the connected account it is, with a dot instead of a
    // ring.
    usage: AccountUsageSchema.optional(),
    /* THE TRANSLATOR'S OWN VERDICT ON THE CREDENTIAL, the one live fact no quota read can produce. CLIProxyAPI
     * benches an auth file the moment upstream refuses it (a quota 429, an expired token) and routes around it
     * until `until`; a reading taken five minutes ago cannot know that, and a green ring over a benched file is
     * exactly the gap a refusal used to be the only way to see. Absent ⇒ the proxy is routing to it. */
    cooling: z
        .object({
            // Epoch SECONDS, like every reset on this wire. Absent when the proxy named no retry instant.
            until: z.number().optional(),
            // The proxy's own sentence, when it gave one.
            reason: z.string().optional(),
        })
        .optional(),
});
export type TranslatorAccount = z.infer<typeof TranslatorAccountSchema>;
/* Which routed-provider subscriptions are connected in the translator, per provider, a LIST per provider, not
 * a flag: CLIProxyAPI holds any number of auth files per provider side by side and balances requests across
 * them, so connecting a second ChatGPT or Google account is more headroom, and each is disconnectable on its
 * own. Drives the account rows in Sandbox ▸ Agent.
 *
 * ONE KEY PER TRANSLATOR PROVIDER, built over the derived list rather than typed out, because this object and
 * the enum beside it (KeyedProviderSchema) are the same fact twice and the browser reads a provider's slot
 * without checking it exists: a provider present in the enum and missing here is `undefined.length`, at the
 * exact moment somebody is asking whether they can send. */
export const TranslatorAccountsSchema = z.object(
    Object.fromEntries(TRANSLATOR_PROVIDERS.map((provider) => [provider, z.array(TranslatorAccountSchema)] as const)) as Record<
        TranslatorProvider,
        z.ZodArray<typeof TranslatorAccountSchema>
    >,
);
export type TranslatorAccounts = z.infer<typeof TranslatorAccountsSchema>;
// The side-channel body that un-parks a turn waiting on the user. Every interactive card, plan approval,
// clarifying questions, a per-tool permission prompt, parks on the SAME registry keyed by `requestId`, so
// one route resolves all three; the `kind` says which card answered and carries its payload.
export const AgentReplySchema = z.discriminatedUnion("kind", [
    // ExitPlanMode approval. Approving carries NO posture: an approved plan executes under bypassPermissions,
    // set on the SDK session by the gate that raised the card. The container is the isolation boundary, so a
    // plan the user has read and approved is exactly the point where per-tool prompts stop earning their
    // interruption, landing anywhere else means approving a plan to run `git log` and then being asked whether
    // `git log` may run. Rejection feedback loops back into the model as the denial reason.
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
    // AskUserQuestion picks: question text → chosen option label(s) (+ any free-text "Other"). `cancelled`
    // is the dismissal, which tells the model to proceed on sensible defaults rather than leaving it parked.
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
    // A per-tool permission prompt. 'once' allows this call only; 'always' allows the whole TOOL for the rest
    // of the session (plus the SDK's own narrower suggestions), which is what the card's label promises;
    // 'deny' blocks it and feeds `feedback` back as the reason.
    z.object({
        kind: z.literal("permission").describe("Answering a request to use a tool."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        decision: z
            .enum(["once", "always", "deny"])
            .describe("Once allows this call alone; always allows that whole tool for the rest of the conversation; no blocks it."),
        feedback: z.string().optional().describe("Why not, which goes back to the model as the reason."),
    }),
    // A browser help request (the agent parked mid-sign-in on something only a person can clear, a captcha, a
    // password it does not hold). `helped: true` is "done, hand back": the user took control of the agent's
    // browser, fixed the step, and the turn continues from the page as they left it. `helped: false` is "can't
    // help now", the agent is told so and moves on rather than waiting forever. `note` rides back to the model
    // either way ("typed the password, don't touch the remember-me box").
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
    // A terminal help request, the same two answers as the browser's, for a command parked at a prompt only a
    // person can answer. `helped: true` is "typed it, carry on"; false is "can't right now". `note` rides back
    // either way, and on `helped` the daemon adds what the pane SAYS to the tool result: the user answering the
    // prompt is exactly the moment the agent cannot see, and it would otherwise have to ask them how it went.
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
    // A premium service run's yes or no. The click is the ONLY way the spend can happen, the daemon holds the
    // agent's run request parked until this settles it (platform/service-offer.ts), so `approve` carries no
    // qualifiers: one true releases exactly one run, and anything else charges nothing.
    z.object({
        kind: z.literal("service_offer").describe("Answering a request to spend on a paid service."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        approve: z
            .boolean()
            .describe("Yes releases exactly one run. Anything else charges nothing. This click is the only way the spend can happen."),
    }),
    // A missing-capability ask's yes or no. `connect: true` is "I'll set it up", it opens the card's setup
    // and keeps the agent's request parked while the daemon watches for the connection to come live
    // (capabilities/capability-offer.ts); false tells the agent to continue without it. The click decides
    // only the WATCHING: nothing is connected by the reply itself, the setup is the owner's own flow.
    z.object({
        kind: z.literal("capability_offer").describe("Answering a request to connect something the agent needs."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        connect: z
            .boolean()
            .describe(
                "Yes keeps the agent waiting while you set it up, and it carries on the moment the connection comes alive. No tells it to continue without. The reply itself connects nothing: setting it up is still your own doing.",
            ),
    }),
    // A USDC payment's yes or no. The click is the ONLY way the money can move, the daemon holds the agent's
    // `wallet fetch` parked until this settles it (wallet/payment-offer.ts), so `approve` carries no
    // qualifiers: one true releases exactly one payment, and anything else spends nothing.
    z.object({
        kind: z.literal("payment_offer").describe("Answering a request to pay for something."),
        requestId: z.string().min(1).describe("Which card you are answering."),
        approve: z
            .boolean()
            .describe("Yes releases exactly one payment. Anything else spends nothing. This click is the only way the money can move."),
    }),
]);
export type AgentReply = z.infer<typeof AgentReplySchema>;
// Steering: a user message delivered INTO the running turn (injected between tool calls, Claude Code style),
// keyed by the conversation whose turn is in flight. NOT_FOUND when no steerable turn is running, the client
// then holds the message in its queue and sends it as the next turn instead. Carries everything a turn's own
// prompt can carry (files, the editor-context chip), because "add more while it works" is worth nothing if it
// only takes bare text: the daemon folds the same notes into the injected message that a fresh turn gets.
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
// True cancel for the conversation's in-flight turn, aborts the agent daemon-side, unlike closing the
// /agent fetch (which sends no cancel frame).
export const StopTurnSchema = z.object({ conversationId: z.string().min(1).describe("Which conversation's running turn to cancel.") });
/* WHO SERVES THE RE-RUN, the one part of a held turn a press is allowed to move, and the field that exists
 * because leaving it out made the press useless in exactly the case it was built for.
 *
 * A spent allowance is a refusal by an ACCOUNT, and the fix a person reaches for is the account switcher in the
 * composer: switch to one with headroom, press Continue. Replaying the turn with everything it carried replayed
 * the refused account too, so the press bounced off the same limit, reported it in the same words, and the user's
 * only way through was to type "Continue" by hand — a send, which reads the composer's current selection, which
 * is the very thing the press was ignoring.
 *
 * So the press carries WHO, and the daemon keeps WHAT. Everything that makes the turn the turn (the prompt, the
 * attachments, the effort, the mode, the worktree, the session holding whatever it managed to do) stays on the
 * daemon's own copy, because a client re-deriving those from its transcript would be re-deriving them from the
 * STRIPPED copy it renders, which is how a re-send comes to run a different turn from the one it claims to
 * repeat. Routing is the exception, and it is the exception on purpose: it is not a property of the request, it
 * is the answer to "who pays for it", and the whole reason the user is pressing is that they have changed it. */
export const ResumeRoutingSchema = z.object({
    agent: AgentProviderSchema.describe("Which provider serves the re-run."),
    harness: AgentHarnessSchema.describe("Which agentic loop runs it."),
    account: z.string().optional().describe("Which of that provider's accounts pays for it. Leave it out for the first one."),
    // Omitted rather than guessed: a client whose catalog hasn't loaded has no pick to send, and the turn's own
    // model is a better answer than a blank one.
    model: z.string().optional().describe("Which model. Leave it out to keep the one the refused turn named."),
});
export type ResumeRouting = z.infer<typeof ResumeRoutingSchema>;
/* RUN THE HELD TURN AGAIN: which conversation, and who serves it now.
 *
 * What comes back is an ordinary StartedTurn, and the caller then attaches to it exactly as it would to a turn
 * somebody else started (the resume note on the prompt is what tells an attaching window to reuse the bubble that
 * is already there instead of drawing the same message twice). */
export const ResumeTurnSchema = z.object({
    conversationId: z.string().min(1).describe("Which conversation's held turn to run again."),
    routing: ResumeRoutingSchema.optional().describe(
        "Who serves the re-run, when the conversation has been re-pointed since it was refused. Leave it out to run it on whatever the turn carried.",
    ),
});
