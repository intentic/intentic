// automations: scheduled agent wake-ups (.intentic/config/automations.json)
import { z } from "zod";
import { AgentHarnessSchema, AgentOriginSchema, AgentProviderSchema } from "./agent.js";
import { AgentSummarySchema } from "./agents.js";
import { entryId } from "./internal.js";
import { IssuesConfigSchema } from "./issues.js";
// An automation wakes the agent autonomously: the daemon's scheduler fires each enabled automation on its
// trigger, runs the optional guard command (a shell command in the workspace; non-zero exit skips the wake),
// then runs one agent turn with the prompt. The manifest is user config; run history is daemon-recorded.

// `schedule` fires on its cron; `event` fires when an external system POSTs /automations/{id}/fire?token=…
// (a plain Hono route, webhook bodies are arbitrary). The token is the webhook's own auth (senders can't do
// Google ID tokens): optional on input, the daemon generates one on upsert, and always present in stored and
// listed automations, so the owner's UI can render the copyable URL.
// `listener` fires from a realtime source's connection to the provider (an extension's gateway process holds
// it, e.g. Discord), no cron, no token, never reachable via /fire. channelId narrows to one channel; absent ⇒
// every channel the bot can read. eventType narrows to one kind of event (a Discord message, a live voice
// utterance batch, or a finished voice transcript); absent ⇒ all event kinds the source emits. mentioned
// narrows message events to those that @mention one of the workspace's bots or reply to a bot's message;
// absent ⇒ all messages. `provider` and `eventType` are open strings, a realtime source is now extension-
// declared (contributes.listener), so the daemon validates a listener trigger at upsert against `webchat` ∪ the
// installed extensions' declared providers/events rather than a hardcoded enum here.
// `webchat` is the exception: it has no gateway. An embeddable widget POSTs a visitor's message to
// /webchat/<id>/message and the agent's reply streams back over SSE. Its address is the public automation id, so
// allowedOrigins (the widget's embed sites) + a per-conversation rate limit are its abuse boundary, no secret
// token can live in a browser.
// `ci` is the other gateway-less source: the daemon's own pipeline receiver (ci/events.ts) dispatches it from a
// provider webhook, or from the REST poller on a sandbox whose hooks could not be registered. Its channelId is
// the workspace repo, and `branch` is its SECOND narrowing axis, a fleet pushes a branch per agent, so a
// pipeline trigger that can only say "this repo" says "every agent's every failure".
// `workspace` fires from the sandbox's OWN codebase instead of the outside world, see WorkspaceEventKindSchema.

// What the daemon emits as the fleet works, and what a `workspace` trigger names. These are the events a code
// CHORE runs on (continuous review, post-land checks): the daemon is both producer and consumer, so unlike
// `event` there is no token and no route, nothing outside the sandbox can reach them.
//
// The two OVERLAP on the common path: a clean turn auto-lands, firing both. A chore should name exactly one.
// `turn.settled` fires once per isolated turn whatever its outcome, so it also covers the errored and
// conflicted turns most worth a second pair of eyes, and it fires while the user is still looking at the diff,
// before they decide to land. `agent.landed` fires only when work actually reached the main tree, including an
// explicit Land from the review panel long after the turn ended.
//
// The `deps.*` pair fires from the dependency verifier (workspace/verify-deps.ts) rather than a turn: after a
// land drifts dependencies, the daemon installs them and runs the tree's own checks, and these are that chain's
// EDGES, `deps.broken` when the checks go red after a landed change, `deps.fixed` when a later land turns them
// green again. Edges, not states, on the ci-events precedent (pipeline_broken): a tree that is red and stays
// red emits nothing, so a fix chore is woken by the breakage, never by the standing colour.
export const WorkspaceEventKindSchema = z.enum(["turn.settled", "agent.landed", "deps.broken", "deps.fixed"]);
export type WorkspaceEventKind = z.infer<typeof WorkspaceEventKindSchema>;
// The payload a workspace-triggered wake carries: one JSON object, in $AUTOMATION_PAYLOAD for the guard and
// appended to the prompt for the turn.
//
// `repos` names the change to look at as an OPEN span, `git -C <dir> diff <from>`, with no upper bound. Each
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
    // `ready` is a clean turn whose delta was HELD on the branch (auto-land off), for a chore, the moment
    // before the user's deliberate Land, which is exactly when a pre-land review wants to run.
    outcome: z.enum(["landed", "conflict", "ready", "idle", "error"]),
    repos: z.array(z.object({ repo: z.string(), from: z.string(), dir: z.string() })),
    /* The `deps.*` events' own facts, absent on every turn-borne event. What a fix chore needs to start
     * without rediscovering it: which project broke, the exact command that judged it, how it exited, and the
     * tail of its output, bounded, because the payload rides a prompt and a guard's environment, and the full
     * log is one attach away in the project's `--verify` terminal panel. `attempt` counts consecutive red
     * verifies since the last green, so a guard can cap retries in one visible line of shell. */
    deps: z
        .object({
            project: z.string(),
            command: z.string(),
            exitCode: z.number(),
            attempt: z.number(),
            logTail: z.string(),
        })
        .optional(),
});
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;
export const TriggerSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("schedule").describe("On a clock."),
        cron: z.string().min(1).describe("When, in cron notation."),
    }),
    z.object({
        kind: z.literal("event").describe("When something calls its webhook."),
        token: z
            .string()
            .min(1)
            .optional()
            .describe("The credential a caller presents. It is the only one in the exchange, because an outside sender has no identity here."),
    }),
    z.object({
        kind: z.literal("listener").describe("When a message arrives from somewhere outside."),
        provider: z.string().min(1).describe("Which service to listen to."),
        channelId: z.string().min(1).optional().describe("Narrow it to one channel or thread."),
        eventType: z.string().min(1).optional().describe("Narrow it to one kind of event."),
        mentioned: z.boolean().optional().describe("Only when the agent is actually addressed, rather than on everything said in earshot."),
        // ci only: the git ref the pipeline ran on. Absent ⇒ every branch of the matched repos.
        branch: z
            .string()
            .min(1)
            .optional()
            .describe("Narrow it to one branch, for the sources that have branches. Absent means every branch of the repositories it matches."),
        /* The two gateway-less browser sources, `webchat` and `issues`: the website origins allowed to POST to
         * the public endpoint. Absent/empty ⇒ none admitted, on both. One field rather than one per source,
         * because it is the same question asked of the same header by the same kind of caller, and an intake
         * whose allowlist lived somewhere else would be a second gate to keep in step with the first. */
        allowedOrigins: z
            .array(z.string())
            .optional()
            .describe("Which websites may reach the public endpoint, the chat widget's or the bug reporter's. Absent or empty admits nobody."),
    }),
    // `repo` narrows to events whose span touches one workspace repo ("root" or a repo id); absent ⇒ any.
    z.object({
        kind: z.literal("workspace").describe("When something happens to the files or the repositories."),
        event: WorkspaceEventKindSchema.describe("Which happening."),
        repo: z.string().min(1).optional().describe("Narrow it to one repository. Absent means any of them."),
    }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;
/* The Front Desk widget's settings, everything about the embeddable chat that isn't the automation's prompt.
 * Present only on `webchat` listener automations; the trigger keeps `allowedOrigins` because that one is the
 * admission gate the message route reads, not a rendering choice.
 *
 * Split deliberately into what the WIDGET may read (title/greeting/accent/position/access/googleClientId/
 * turnstileSiteKey, all public by construction, they ship to a stranger's browser) and what only the daemon
 * may read (turnstileSecret). GET /webchat/<id>/config serves the first group by naming it, never by omitting
 * the second: a field added here is invisible to the widget until it is listed there. */
export const WebchatConfigSchema = z.object({
    // `public` admits anyone; `google` refuses a message that carries no verifiable Google ID token. Absent ⇒
    // public, a Front Desk with no access setting is the anonymous support box it looks like.
    access: z
        .enum(["public", "google"])
        .optional()
        .describe("Who may write to it. Absent means anyone, which is the anonymous support box it looks like."),
    // Ask an anonymous visitor for a display name before the first message. Cosmetic: the name is typed, so it
    // reaches the model as untrusted `displayName`, never as identity.
    requireName: z
        .boolean()
        .optional()
        .describe(
            "Ask a visitor for a name first. Cosmetic: the name is typed, so it reaches the model as something a stranger said, never as identity.",
        ),
    /* The bot ceiling. `turnstile` is Cloudflare's (invisible, needs the site's own keys); `pow` is a
     * hashcash-style challenge the daemon issues and the widget solves in a worker, so a site with no
     * Cloudflare account still has something. Absent ⇒ off: the origin allowlist and the rate limit are then
     * the whole boundary, which is the right default for an internal or invite-only page. */
    antiBot: z
        .enum(["turnstile", "pow"])
        .optional()
        .describe(
            "How to keep bots out: a third-party check that needs the site's own keys, or a puzzle the sandbox sets and the widget solves, so a site with no such account still has something. Absent leaves the site allowlist and the rate limit as the whole boundary.",
        ),
    turnstileSiteKey: z.string().optional().describe("The public half of those keys, which ships to the visitor's browser."),
    turnstileSecret: z.string().optional().describe("The private half, which the sandbox keeps and the widget never sees."),
    // The site's OWN Google OAuth web client id. It cannot be intentic's: Google Identity Services only issues
    // a token to an authorized JavaScript origin, and intentic's client can't list every customer domain.
    googleClientId: z
        .string()
        .optional()
        .describe(
            "The site's own sign-in client id. It cannot be ours: a sign-in is only issued to an approved origin, and no single client can list every customer's domain.",
        ),
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
     * billed to the owner, and the per-minute window bounds the RATE without bounding the DAY, twenty a minute,
     * sustained, is tens of thousands of turns before anyone notices. A Front Desk nobody configured should not be
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
/* The daily agent-turn ceiling a Front Desk gets when its owner sets none. Lives here rather than beside the
 * route that enforces it because both ends need the number: the daemon to apply it, and the automation editor
 * to show the owner what they are already protected by (an invisible limit is one people hit and file as a bug).
 *
 * 200 is chosen to be irrelevant to real support traffic and decisive against a script. A Front Desk answering
 * two hundred questions in one UTC day is a busy one; a scripted flood reaches that in ten seconds and then
 * stops costing anything. */
export const WEBCHAT_DAILY_MAX_DEFAULT = 200;
/* ---- the widget wire: three shapes GET /webchat/<id>/config, GET …/challenge and POST …/message speak ----
 *
 * They live here, beside the stored config they derive from, because the Front Desk widget is a SECOND client of
 * this daemon, a bundle running on a stranger's page, and the reason this package exists is that both ends of
 * a wire read one definition. The widget imports these as types only (`import type`), so zod never reaches a
 * visitor's browser. */

// What the widget is told about itself. Fully RESOLVED, every default is applied daemon-side, so the widget
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
// One visitor message. `conversationId` is the widget's own localStorage id, it threads the visitor's messages
// into ONE sandbox conversation, so it is the thread key, not a secret (anyone can mint one; the origin
// allowlist, the challenge and the rate limit are the gate).
export const WebchatMessageSchema = z.object({
    conversationId: z.string().min(1).max(200),
    content: z.string().min(1),
    // What the visitor TYPED as their name. Never identity, it reaches the model tagged as unverified, and a
    // signed-in visitor's verified name comes from the ID token instead.
    displayName: z.string().max(200).optional(),
    // A Google ID token from the site's own client id, verified daemon-side against Google's JWKS.
    idToken: z.string().optional(),
    // The anti-bot answer, whichever kind the config asked for. Checked once per conversation, not per message.
    turnstileToken: z.string().optional(),
    powNonce: z.string().optional(),
    // The widget's own transcript, sent ONLY on the first message of a thread, after that the sandbox
    // conversation resumes and carries its own context.
    history: z
        .array(z.object({ author: z.string().optional(), content: z.string() }))
        .max(50)
        .optional(),
});
export type WebchatMessage = z.infer<typeof WebchatMessageSchema>;
export const AutomationSchema = z.object({
    id: entryId.describe("The automation's id."),
    trigger: TriggerSchema.describe("What sets it off: a schedule, an event in the workspace, a message arriving from outside, or a webhook."),
    // Shell command run in the workspace root before waking; exit 0 ⇒ wake, non-zero ⇒ the run is "skipped".
    guard: z
        .string()
        .min(1)
        .optional()
        .describe(
            "A command run before the wake that decides whether there is anything to do. Skipped by the guard is often the most useful thing an automation can report.",
        ),
    prompt: z.string().min(1).describe("What the woken agent is told."),
    // The Front Desk widget's settings, `webchat` listener automations only, ignored on every other trigger.
    webchat: WebchatConfigSchema.optional().describe("Settings for the public chat widget, for an automation that answers visitors."),
    // The bug intake's settings, `issues` listener automations only, ignored on every other trigger. Its own
    // field rather than a shared "public endpoint" bag: the two sources answer different questions (a chat's
    // greeting and access model, an intake's dedup ceiling and ingest key) and a union of both would be a
    // schema where most fields are wrong for whichever source is reading it.
    issues: IssuesConfigSchema.optional().describe("Settings for the bug reporter, for an automation that takes crash reports from your own sites and apps."),
    /* NARROW THIS ONE JOB FURTHER than the persona it runs as, raw tool names, and the escape hatch under the
     * shelves rather than the way anyone is expected to answer this question.
     *
     * The persona (`actsAs` below) is where a session's toolbox is decided now, because the answer is worth
     * reusing: the same bounds apply to the chat, the workflow and the Front Desk that name the same card. This
     * stays for the job that needs LESS than its persona allows, and only less, which is a rule the composer
     * enforces rather than a convention: an edit here can never hand back a shelf the persona switched off. */
    allowedTools: z
        .array(z.string().min(1))
        .optional()
        .describe(
            "Narrow the woken turn to these tools. For one driven by an outside message this list is the real boundary, because prompt wording is only advice and an empty toolbox is not.",
        ),
    // Which provider adapter serves the wake; absent ⇒ claude. Same dispatch as a chat turn (AgentTurnSchema.agent).
    agent: AgentProviderSchema.optional().describe("Which provider serves the wake."),
    /* Which connected account of that provider serves the wake; absent ⇒ the provider's first account, exactly
     * as for a chat turn (AgentTurnSchema.account).
     *
     * An automation needs this more than a chat does, and for a reason a chat never meets: nobody is watching.
     * A sandbox holds several accounts side by side, and when the first one is out of headroom, or belongs to
     * an organization that has disabled the plan, every fire of every automation errors against it until a
     * human happens to read the row. Pinning the wake to an account that can actually run is the difference
     * between "my nightly sweep is quiet" and a Front Desk that turns visitors away all day. */
    account: z.string().optional().describe("Which account pays for it."),
    /* WHICH FACE THE WAKE SHOWS THE OUTSIDE WORLD (AgentTurnSchema.actsAs, read its note for why this is not
     * spelled `account`, which is the field directly above and means who PAYS).
     *
     * Absent ⇒ the wake reaches NO logged-in account at all. That is the one place this whole layer stops being
     * a convenience and becomes a boundary, and it is deliberately the strictest default in the schema: an
     * automation fires with nobody at the composer, on a prompt that, for a Front Desk, a stranger helped write.
     * `allowedTools` above already carries this exact reasoning for tools; an unrepeatable public post deserves
     * it at least as much. An automation that genuinely means "post as us" says so, once, in a field a reviewer
     * can see. */
    actsAs: entryId.optional().describe("Which persona it speaks as. An unwatched turn naming none reaches no signed-in account at all."),
    // Which harness (agentic loop) runs the wake; absent ⇒ native. Same semantics as AgentTurnSchema.harness.
    harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it."),
    // Which model the wake runs on (see agent-catalog.ts modelsFor); absent ⇒ the provider's default.
    model: z.string().optional().describe("Which model runs it."),
    // When true, a fire doesn't wake the agent, it's held in the approvals queue until the owner approves.
    requireApproval: z.boolean().optional().describe("Hold every fire for a person instead of running it. Only a person can release one of those."),
    /* The middle ground between firing instantly and requiring a click: the fire is held in the same approvals
     * queue, visibly, and the daemon runs it ITSELF once the hold has elapsed AND no agent turn is live, the
     * owner's window to cancel or start it early, with silence as consent. What a fix chore wants: time to see
     * "checks broke, a fix is about to start" without a standing decision to make. `requireApproval` wins when
     * both are set, an explicit "ask me" must never quietly become "unless I'm slow". */
    holdForSeconds: z.number().optional().describe("Hold each fire this long before running it anyway, which is a delay rather than a decision."),
    // A code CHORE: maintenance of THIS codebase rather than a reaction to the outside world. Purely a
    // classification, the daemon fires a chore exactly like any other automation, but it cannot be derived
    // from the trigger, which is why it is stored: a nightly `pnpm audit` sweep and a nightly Stripe poll are
    // both `schedule`, and belong on different shelves. Absent ⇒ an ordinary automation.
    chore: z
        .boolean()
        .optional()
        .describe("This automation is a maintenance job, which is what files it under chores rather than among ordinary automations."),
    enabled: z.boolean().describe("Whether it fires at all."),
});
export type Automation = z.infer<typeof AutomationSchema>;
// A wake held for owner approval (.intentic/records/approvals/<id>.json, one file per held wake). It snapshots the
// trigger payload so an approved run replays exactly what fired, even across a daemon restart. The id is minted
// by the daemon (an entryId-safe filename).
export const AutomationApprovalSchema = z.object({
    id: entryId.describe("This waiting item's own id, which approving and rejecting take."),
    automationId: z.string().describe("Which automation it came from."),
    // The event/listener payload the wake would have carried; absent for schedule triggers.
    payload: z
        .string()
        .optional()
        .describe(
            "What set it off, kept whole so an approved wake carries the same thing it would have had. Absent for one on a schedule, which carries nothing.",
        ),
    // The provenance + title the held wake would have opened its conversation with, snapshotted alongside the
    // payload so an approved external wake surfaces on the fleet exactly as an auto one would have.
    origin: AgentOriginSchema.optional().describe(
        "Where the message came from, kept alongside the payload so an approved wake appears on the board exactly as an automatic one would have.",
    ),
    title: z.string().optional().describe("What the conversation would be called."),
    /* The CONTINUING THREAD this wake belonged to, when it had one, the conversation the dispatcher had
     * already opened for it and the provider session that conversation last ran on.
     *
     * Snapshotted for the same reason the payload is, and it is the half that was missing: without it an
     * approved wake fell through to minting a fresh conversation, so a Front Desk visitor's chat became one card
     * per approved message instead of the single thread the dispatcher had opened for them, a second worktree
     * each time, and an agent that met the visitor again on every turn. Absent for a schedule or a webhook,
     * which own no thread. */
    conversationId: z
        .string()
        .optional()
        .describe(
            "The thread this belongs to, when it has one, so approving continues that conversation rather than opening a new one. Without it, one visitor's chat becomes a card per approved message and an agent that meets them again every turn.",
        ),
    sessionId: z.string().optional().describe("The provider session that thread last ran on."),
    createdAt: z.number().describe("When it started waiting, in milliseconds."),
    /* Epoch ms after which the daemon may run this wake itself (a `holdForSeconds` hold), the countdown the
     * row renders, and the deadline the scheduler's tick checks against. Absent on a `requireApproval` hold,
     * which only the owner may release. */
    autoRunAt: z
        .number()
        .optional()
        .describe(
            "When it goes ahead on its own, in milliseconds, for a hold that is only a delay. Absent for one that genuinely waits on a person.",
        ),
});
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;
// `rev` is the registry revision this roster was read at, a counter the daemon bumps on every registry change.
// It is what makes the browser's optimistic writes safe: the fleet is published as full snapshots (last frame
// wins), so without an ordering stamp a roster READ before a mutation but delivered after it silently puts the
// mutated agents back. The browser drops any roster older than the newest it has applied, and holds its own
// pending change until a roster at or past the revision that applied it arrives. See useAgents.ts.
// `held` is the approvals queue projected onto the board, the wakes waiting at the door, so "needs you" sits
// beside "running" instead of in a page nobody opens. Defaulted so an older daemon's roster still parses.
export const AgentsListSchema = z.object({
    agents: z.array(AgentSummarySchema).describe("The conversations."),
    rev: z
        .number()
        .describe(
            "Which version of the fleet this is. The fleet is published as whole snapshots, so without a version a list read before a change but delivered after it would silently undo that change. Drop any list older than the newest you have already applied.",
        ),
    held: z
        .array(AutomationApprovalSchema)
        .default([])
        .describe(
            "Automations waiting at the door for a yes, put alongside the running conversations so needs-you sits beside working rather than on a page nobody opens.",
        ),
});
export type AgentsList = z.infer<typeof AgentsListSchema>;
export const AutomationApprovalsListSchema = z.object({ approvals: z.array(AutomationApprovalSchema).describe("Everything waiting for a yes.") });
export const AutomationApprovalIdParamSchema = z.object({ id: z.string().describe("Which waiting item.") });
export const AutomationRunSchema = z.object({
    at: z.number(),
    // skipped = the guard said no; error = the guard passed but the agent turn surfaced an error; interrupted =
    // the daemon died mid-wake, so the run reached no outcome of its own (see agent/turn-journal.ts). Without
    // that last one an interrupted fire records NOTHING and simply vanishes from the row's history, which reads
    // as "it never fired", the one reading a 3 a.m. automation must not be given.
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
export const AutomationEnabledInputSchema = z.object({ id: z.string(), enabled: z.boolean() });
/* ---- the automation catalogue: everything that can wake an agent here, and what to start from ----
 *
 * ONE ANSWER TO ONE QUESTION, and that is the whole reason it exists. The composer used to carry a hand-written
 * list of every source and every template. CI, Komodo, Sentry, Stripe, email, the website widget, the chore
 * book, while the daemon's upsert carried a SECOND hand-written list of the providers it would accept. Two
 * lists, edited in different packages, disagreeing was a matter of time; and every area that gained something
 * worth waking on had to edit the automations surface to say so, which is the dependency pointing backwards.
 *
 * Now the daemon merges what IT emits with what every installed extension declares, and serves the result. The
 * composer draws whatever comes back and knows the name of nothing; `upsert` validates against the same merge.
 * An area gains a trigger by declaring it, and the surface it appears on does not change.
 *
 * WHERE A SOURCE IS DECLARED IS WHERE ITS EVENTS COME FROM, `webchat` and `ci` are the daemon's own (it holds
 * the widget endpoint and the pipeline webhook receiver), every other one belongs to the extension whose
 * gateway or backend dispatches it.
 *
 * A TEMPLATE SITS BESIDE THE SOURCE IT FIRES ON, because the source's starter and the template's prompt
 * describe the same payload, and one payload described in two packages is two descriptions to keep in step. A
 * template on the generic `event` webhook has no source to sit beside, so it goes with the pack carrying the
 * capability card it names, which is the same pack the user connected to make it work at all. */

// A source's per-source narrowing field, as the generic editor draws it. Absent ⇒ the editor offers no such
// filter rather than inventing one the provider has no meaning for.
const TriggerFieldSchema = z.object({ label: z.string().min(1), placeholder: z.string().min(1), hint: z.string().min(1).optional() });
export const TriggerSourceSchema = z.object({
    // The slug a listener trigger fires on (Trigger.provider).
    provider: z.string().min(1),
    label: z.string().min(1),
    // Simple-icons slug, or an app glyph, the same logo/icon split a capability card and an extension mark draw.
    logo: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    events: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })),
    channel: TriggerFieldSchema,
    // A SECOND narrowing axis, for sources whose events carry one, `ci` narrows by git ref as well as by repo.
    branchField: TriggerFieldSchema.optional(),
    // Only sources whose `message` events distinguish addressed messages set this; absent ⇒ no mention-only filter.
    mentionLabel: z.string().min(1).optional(),
    // The provider owns the payload vocabulary, so it owns the first prompt that explains that payload.
    starterPrompt: z.string().min(1).optional(),
    /* Capability providers that make this source WORK, any one of them connected is enough (a CI trigger rides
     * github or gitlab). Empty ⇒ nothing to connect, the source is usable as it stands. Availability is computed
     * in the browser rather than served, because the browser's capability facts are pushed live and a served
     * boolean would be stale between polls. */
    requires: z.array(z.string().min(1)).default([]),
    /* Whether the extension declaring this is switched ON. Disabled ones are still listed, and that is the
     * point: a stored automation must stay readable and editable while the pack that supplied its provider is
     * off, showing the real label instead of degrading to a bare slug. */
    enabled: z.boolean(),
});
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;
/* HOW A TEMPLATE IS OFFERED. Absent ⇒ it lives in the create dialog's gallery, where you go once you know what
 * you want. The two named forms are for what a user would never think to go looking for:
 *   create   , a shelf card on the page that makes the automation in one click, switched off, ready to read.
 *               The chores are all of these: upkeep nobody opens an automations page hunting for.
 *   configure, a shelf card that opens the dialog PREFILLED, for a template that cannot work unconfigured (a
 *               Front Desk with no allowed sites admits nobody, and a row that silently does nothing is worse
 *               than a form). */
export const TemplateOfferSchema = z.enum(["create", "configure"]);
export const AutomationTemplateSchema = z.object({
    // Prefills the automation name, so it is also what "does one of these already exist" is asked by.
    id: z.string().min(1),
    title: z.string().min(1),
    logo: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    // Same rule as a source's: any one connected is enough, empty ⇒ always offered.
    requires: z.array(z.string().min(1)).default([]),
    trigger: TriggerSchema,
    // Prefills the guard command (a shell one-liner; non-zero exit skips the wake).
    guard: z.string().min(1).optional(),
    // Prefills the countdown hold: each fire waits this long, visibly and cancellably, before starting itself.
    holdForSeconds: z.number().int().positive().optional(),
    prompt: z.string().min(1),
    // The card's disclosure under the title, "instant", "checks every 5 min", "skips changes under 20 lines".
    note: z.string().min(1).optional(),
    // Post-save instructions: where to paste the webhook URL this automation just minted.
    setup: z.string().min(1).optional(),
    // What the shelf card says under the title. Only offered templates need one; a gallery entry has its
    // trigger beside it for context.
    description: z.string().min(1).optional(),
    offer: TemplateOfferSchema.optional(),
    /* WHETHER THE AUTOMATION THIS MAKES WATCHES THIS CODEBASE, the flag the created record stores, which is
     * what puts its row on the chores shelf rather than among the integrations.
     *
     * Carried rather than inferred from the trigger, because a nightly dependency sweep and a nightly Stripe
     * poll are both `schedule` and only one of them is about your code. */
    chore: z.boolean().optional(),
});
export type AutomationTemplate = z.infer<typeof AutomationTemplateSchema>;
export const AutomationCatalogSchema = z.object({
    sources: z.array(TriggerSourceSchema),
    templates: z.array(AutomationTemplateSchema),
});
export type AutomationCatalog = z.infer<typeof AutomationCatalogSchema>;
