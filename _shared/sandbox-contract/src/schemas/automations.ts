// automations: scheduled agent wake-ups (.intentic/config/automations.json)
import { z } from "zod";
import { AgentOriginSchema, ModelPinSchema } from "./agent.js";
import { AgentSummarySchema } from "./agents.js";
import { entryId } from "./internal.js";
import { IssuesConfigSchema } from "./issues.js";
// An automation wakes the agent: the daemon fires each enabled one on its trigger, runs the optional guard command
// (non-zero exit skips the wake), then runs one turn with the prompt. The manifest is user config; run history is
// daemon-recorded.

// schedule: fires on its cron
// event: fires when an external system POSTs /automations/{id}/fire; its auth token lives outside the manifest
// (.intentic/secrets/doors.json), never in this versioned, widely-readable file
// listener: fires from a realtime source's own connection (an extension's gateway), no cron, no token, never reachable
// via /fire. `channelId`/`eventType`/`mentioned` narrow it; absent means unfiltered. `provider`/`eventType` are open
// strings validated at upsert against installed extensions' declared vocabulary
// webchat: the exception with no gateway; a widget POSTs to /webchat/<id>/message, and its abuse boundary is
// allowedOrigins plus a rate limit, since no secret can live in a browser
// ci: the daemon's own pipeline receiver; `channelId` is the workspace repo, `branch` narrows further since a fleet
// pushes one branch per agent
// workspace: fires from the sandbox's own codebase (WorkspaceEventKindSchema)

// What the daemon emits as the fleet works, for a code chore to react to; no token or route, since only the daemon
// reads these.
// turn.settled: fires once per isolated turn regardless of outcome, while the diff is still on screen
// agent.landed: fires only once work reaches the main tree, including a later manual Land
// deps.broken/deps.fixed: edges from the dependency verifier around a landed change, not standing states, so a chore
// wakes on the transition, never on a tree that stays red
export const WorkspaceEventKindSchema = z.enum(["turn.settled", "agent.landed", "deps.broken", "deps.fixed"]);
export type WorkspaceEventKind = z.infer<typeof WorkspaceEventKindSchema>;
// Payload of a workspace-triggered wake, delivered as JSON in $AUTOMATION_PAYLOAD and appended to the prompt.
// `repos[].from` is each repo's state before the turn; the span runs to the working tree, not a commit, so an errored
// turn's uncommitted work still shows.
export const WorkspaceEventSchema = z.object({
    event: WorkspaceEventKindSchema,
    agentId: z.string(),
    title: z.string().optional(),
    branch: z.string(),
    // `ready` is a clean turn held on the branch (auto-land off): the moment right before a deliberate Land, when a
    // pre-land review wants to run.
    outcome: z.enum(["landed", "conflict", "ready", "idle", "error"]),
    repos: z.array(z.object({ repo: z.string(), from: z.string(), dir: z.string() })),
    // Present only for `deps.*` events: which project broke, the command and exit code, a bounded log tail, and
    // `attempt` counting consecutive reds since the last green.
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
        // Fires only once at least this many other sessions have started since this automation's last wake; a due run
        // short of that is recorded as skipped.
        afterSessions: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Fire only once at least this many new sessions have been run since the last wake. A due run short of that is skipped, and says how far off it is."),
    }),
    z.object({
        kind: z.literal("event").describe("When something calls its webhook."),
        // Calls per UTC day across every caller; absent falls back to FIRE_DAILY_MAX_DEFAULT, never uncapped.
        dailyMax: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("How many webhook calls a day may wake the agent, across every caller. Absent is a modest default rather than unlimited."),
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
        // Shared by webchat and issues, the two gateway-less browser sources; one field since both ask the same
        // question of the same header.
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
// The Front Desk widget's settings, present only on `webchat` listener automations. Split into what the widget itself
// may read (public by construction) and what only the daemon may (turnstileSecret); GET /webchat/<id>/config serves the
// first group by naming it, never by omitting the second.
export const WebchatConfigSchema = z.object({
    // `public` admits anyone; `google` requires a verifiable Google ID token. Absent means public.
    access: z
        .enum(["public", "google"])
        .optional()
        .describe("Who may write to it. Absent means anyone, which is the anonymous support box it looks like."),
    // Cosmetic: the typed name reaches the model as untrusted `displayName`, never as identity.
    requireName: z
        .boolean()
        .optional()
        .describe(
            "Ask a visitor for a name first. Cosmetic: the name is typed, so it reaches the model as something a stranger said, never as identity.",
        ),
    // `turnstile` needs Cloudflare's own keys; `pow` is a hashcash puzzle the daemon issues itself. Absent leaves the
    // origin allowlist and rate limit as the whole boundary.
    antiBot: z
        .enum(["turnstile", "pow"])
        .optional()
        .describe(
            "How to keep bots out: a third-party check that needs the site's own keys, or a puzzle the sandbox sets and the widget solves, so a site with no such account still has something. Absent leaves the site allowlist and the rate limit as the whole boundary.",
        ),
    turnstileSiteKey: z.string().optional().describe("The public half of those keys, which ships to the visitor's browser."),
    turnstileSecret: z.string().optional().describe("The private half, which the sandbox keeps and the widget never sees."),
    // The site's own client id, not ours: Google only issues a token to an authorized origin, and no client can list
    // every customer's domain.
    googleClientId: z
        .string()
        .optional()
        .describe(
            "The site's own sign-in client id. It cannot be ours: a sign-in is only issued to an approved origin, and no single client can list every customer's domain.",
        ),
    // Widget chrome; `accent` must be a hex colour, not any CSS colour, since the widget derives a scheme, a button
    // wash and a focus ring from its channels, and an unreadable value would leave half the accent missing.
    title: z.string().max(80).optional(),
    greeting: z.string().max(500).optional(),
    accent: z
        .string()
        .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "accent must be a hex colour, e.g. #e47100")
        .optional(),
    position: z.enum(["top-right", "top-left", "bottom-right", "bottom-left"]).optional(),
    // Two ceilings beyond the route's per-minute window, since a public endpoint's real exposure is cost, not rate:
    // `dailyMessageMax` (absent falls back to WEBCHAT_DAILY_MAX_DEFAULT) caps the automation per UTC day,
    // `conversationMessageMax` caps one visitor thread and stays uncapped by default.
    dailyMessageMax: z.number().int().positive().optional(),
    conversationMessageMax: z.number().int().positive().optional(),
    // How long a visitor thread resumes the same conversation before a new message starts a fresh one; absent uses the
    // daemon's own default.
    sessionTtlMinutes: z.number().int().positive().optional(),
});
export type WebchatConfig = z.infer<typeof WebchatConfigSchema>;
// Default daily agent-turn ceiling for an unconfigured Front Desk; high enough for real traffic, low enough to blunt a
// script.
export const WEBCHAT_DAILY_MAX_DEFAULT = 200;
// The widget wire: the shapes GET /webchat/<id>/config, GET .../challenge and POST .../message speak, living beside the
// config they derive from since the widget is a second client of this daemon. Imported as types only, so zod never
// reaches a visitor's browser.

// What the widget is told about itself, fully resolved daemon-side so it carries no fallback logic. Everything here is
// public by construction: it ships to any browser reaching the endpoint from an allowed origin.
export const WebchatPublicConfigSchema = z.object({
    automationId: z.string(),
    title: z.string(),
    greeting: z.string(),
    accent: z.string(),
    position: z.enum(["top-right", "top-left", "bottom-right", "bottom-left"]),
    access: z.enum(["public", "google"]),
    requireName: z.boolean(),
    // "off" is spelled out, not left absent, so a serialization bug can't silently read as "no challenge".
    antiBot: z.enum(["turnstile", "pow", "off"]),
    turnstileSiteKey: z.string().optional(),
    googleClientId: z.string().optional(),
});
export type WebchatPublicConfig = z.infer<typeof WebchatPublicConfigSchema>;
// A proof-of-work challenge: find a nonce whose SHA-256 of `${salt}:${nonce}` starts with `difficulty` zero bits. One
// shape for every public door (Front Desk, bug intake), and one matching solver, embed.ts.
export const PowChallengeSchema = z.object({ salt: z.string(), difficulty: z.number().int().positive() });
export type PowChallenge = z.infer<typeof PowChallengeSchema>;
// One visitor message; `conversationId` is the widget's own localStorage id, a thread key rather than a secret — the
// origin allowlist, challenge and rate limit are the gate.
export const WebchatMessageSchema = z.object({
    conversationId: z.string().min(1).max(200),
    content: z.string().min(1),
    // What the visitor typed as a name; never identity, tagged unverified for the model.
    displayName: z.string().max(200).optional(),
    // A Google ID token from the site's own client id, verified daemon-side against Google's JWKS.
    idToken: z.string().optional(),
    // The anti-bot answer, whichever kind the config asked for. Checked once per conversation, not per message.
    turnstileToken: z.string().optional(),
    powNonce: z.string().optional(),
    // Sent only on a thread's first message; after that the sandbox's own conversation carries context.
    history: z
        .array(z.object({ author: z.string().optional(), content: z.string() }))
        .max(50)
        .optional(),
});
export type WebchatMessage = z.infer<typeof WebchatMessageSchema>;
export const AutomationSchema = z.object({
    id: entryId.describe("The automation's id."),
    trigger: TriggerSchema.describe("What sets it off: a schedule, an event in the workspace, a message arriving from outside, or a webhook."),
    // Runs in the workspace root before waking; exit 0 wakes, non-zero is recorded as "skipped". Sees
    // `AUTOMATION_PAYLOAD` when the trigger carried one.
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
    // Bug intake settings, `issues` triggers only; its own field rather than a shared bag, since a chat's and an
    // intake's fields mostly don't overlap.
    issues: IssuesConfigSchema.optional().describe(
        "Settings for the bug reporter, for an automation that takes crash reports from your own sites and apps.",
    ),
    // Narrows this job's toolbox further than its persona allows; the composer enforces that it can only remove, never
    // restore, a shelf the persona switched off.
    allowedTools: z
        .array(z.string().min(1))
        .optional()
        .describe(
            "Narrow the woken turn to these tools. For one driven by an outside message this list is the real boundary, because prompt wording is only advice and an empty toolbox is not.",
        ),
    // Required ordered ladder (replaces separate agent/harness/model fields): an automation spends real money
    // unwatched, so it must name what it spends rather than inherit a chat's default. Walked in order at fire time to
    // the first rung that can start; each rung is a whole pin (provider+model+effort+harness together).
    models: z
        .array(ModelPinSchema)
        .min(1)
        .max(10)
        .describe(
            "Which models this automation may run on, best first. Required, and nothing is chosen for you: work that fires while nobody is watching spends a real allowance, so it names the models it spends rather than inheriting one. Tried in order, so a spent account does not silently stop the job.",
        ),
    // Absent means the provider's first account; pinning matters more here than for a chat, since nobody is watching to
    // notice a stuck one.
    account: z.string().optional().describe("Which account pays for it."),
    // Absent means the wake reaches no logged-in account at all, the strictest default here, since nobody is at the
    // composer when it fires.
    actsAs: entryId.optional().describe("Which persona it speaks as. An unwatched turn naming none reaches no signed-in account at all."),
    // Held in the approvals queue rather than run; only a person releases it.
    requireApproval: z.boolean().optional().describe("Hold every fire for a person instead of running it. Only a person can release one of those."),
    // Held visibly in the approvals queue and run by the daemon itself once the hold elapses with no live turn;
    // `requireApproval`, if also set, always wins.
    holdForSeconds: z.number().optional().describe("Hold each fire this long before running it anyway, which is a delay rather than a decision."),
    // Pure classification: the trigger alone can't tell a code chore from an ordinary schedule, so this is stored
    // rather than derived.
    chore: z
        .boolean()
        .optional()
        .describe("This automation is a maintenance job, which is what files it under chores rather than among ordinary automations."),
    enabled: z.boolean().describe("Whether it fires at all."),
});
export type Automation = z.infer<typeof AutomationSchema>;
// A wake held for owner approval (.intentic/records/approvals/<id>.json); snapshots the trigger payload so an approved
// run replays exactly what fired, even across a daemon restart.
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
    // Snapshotted alongside the payload so an approved wake surfaces on the fleet exactly as an automatic one would.
    origin: AgentOriginSchema.optional().describe(
        "Where the message came from, kept alongside the payload so an approved wake appears on the board exactly as an automatic one would have.",
    ),
    title: z.string().optional().describe("What the conversation would be called."),
    // The thread this wake belongs to, so approving continues it rather than minting a fresh conversation per approved
    // message.
    conversationId: z
        .string()
        .optional()
        .describe(
            "The thread this belongs to, when it has one, so approving continues that conversation rather than opening a new one. Without it, one visitor's chat becomes a card per approved message and an agent that meets them again every turn.",
        ),
    sessionId: z.string().optional().describe("The provider session that thread last ran on."),
    createdAt: z.number().describe("When it started waiting, in milliseconds."),
    // When the daemon may run this itself, for a `holdForSeconds` hold; absent for a `requireApproval` hold, which only
    // the owner releases.
    autoRunAt: z
        .number()
        .optional()
        .describe(
            "When it goes ahead on its own, in milliseconds, for a hold that is only a delay. Absent for one that genuinely waits on a person.",
        ),
});
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;
// `rev` is the registry revision this roster was read at: fleet snapshots are last-frame-wins, so the browser drops any
// roster older than the newest it applied and holds a pending change until a roster past `rev` arrives. `held` is the
// approvals queue projected onto the board, defaulted for an older daemon's roster.
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
    // skipped: the guard said no
    // error: the guard passed but the turn errored
    // interrupted: the daemon died mid-wake; without this value an interrupted fire vanishes from history and reads as
    // never having fired
    outcome: z.enum(["completed", "skipped", "error", "interrupted"]),
    detail: z.string().optional(),
    // Absent only for a run skipped before a conversation was needed.
    conversationId: z.string().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
// The list row: the stored automation plus its recent runs and next scheduled fire (absent when disabled). Default
// daily ceiling for an event trigger naming none: generous for a busy monitor, small enough that a leak is a bad day,
// not a bad month.
export const FIRE_DAILY_MAX_DEFAULT = 200;
export const AutomationSummarySchema = AutomationSchema.extend({
    runs: z.array(AutomationRunSchema),
    nextRun: z.number().optional(),
    // Door credentials, attached for a maintainer or owner only, never a viewer or a control-token program; kept in the
    // secrets store, not the manifest.
    webhookToken: z
        .string()
        .optional()
        .describe("What a caller presents at /automations/{id}/fire, for an event automation. Shown to a maintainer or the owner only."),
    ingestKey: z
        .string()
        .optional()
        .describe("What a client with no website origin presents to a bug intake. Shown to a maintainer or the owner only."),
});
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export const AutomationsListSchema = z.object({ automations: z.array(AutomationSummarySchema) });
export const AutomationIdParamSchema = z.object({ id: z.string() });
export const AutomationEnabledInputSchema = z.object({ id: z.string(), enabled: z.boolean() });
// The automation catalogue: everything that can wake an agent, and what to start from. The daemon merges what it emits
// with what every installed extension declares, so an area gains a trigger by declaring it rather than editing this
// surface. `webchat`/`ci` are the daemon's own sources; a template sits beside the source whose payload it describes,
// or beside its capability's pack if it fires on the generic `event` webhook.

// Absent means the editor offers no such filter, rather than inventing one meaningless to the provider.
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
    // Any one connected capability is enough; computed client-side, since capability facts are pushed live and a served
    // boolean would go stale between polls.
    requires: z.array(z.string().min(1)).default([]),
    // Whether the declaring extension is on; disabled ones stay listed so a stored automation using it stays readable
    // and editable.
    enabled: z.boolean(),
});
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;
// Absent means it lives in the create dialog's gallery. The two named forms are for what a user wouldn't think to look
// for:
// create: a shelf card that makes the automation in one click, switched off, ready to read (every chore is this)
// configure: a shelf card that opens the dialog prefilled, for a template that can't work unconfigured
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
    // Whether the created automation watches this codebase, carried since the trigger alone can't distinguish a chore
    // from an ordinary schedule.
    chore: z.boolean().optional(),
});
export type AutomationTemplate = z.infer<typeof AutomationTemplateSchema>;
export const AutomationCatalogSchema = z.object({
    sources: z.array(TriggerSourceSchema),
    templates: z.array(AutomationTemplateSchema),
});
export type AutomationCatalog = z.infer<typeof AutomationCatalogSchema>;
