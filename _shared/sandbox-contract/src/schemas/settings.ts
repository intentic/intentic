// settings: per-sandbox agent settings (.intentic/config/settings.json), plus the checks a repository declares for
// itself, which those settings adopt.
import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";
import { CommandJudgeModeSchema } from "../policy/safety-policy.js";
import { ModelRoleSchema } from "../models/model-roles.js";
import { AdmissionPolicySchema, AdmissionRuleSchema, ModelPinSchema } from "./agent.js";
import { LimitPolicySchema, RetryPolicySchema } from "./turn-break.js";
import { ZoneSchema } from "../time/zone.js";
// Which prompt base the agent runs before this turn composes anything on top: Intentic's own (default), Claude Code's
// preset, or the owner's text. Declared out here since both the daemon and the browser branch on it.
export const SystemPromptModeSchema = z.enum(["intentic", "claude", "custom"]);
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>;
// Excludes "custom": there is nothing to fetch, it's whatever the owner already typed into the settings field.
export const BuiltinPromptSchema = z.object({ base: z.enum(["intentic", "claude"]) });
// Rules: "at this moment, if this is true, do this". The owner's rules decide (land, hold, version); every command a
// moment runs is a repository's own check (`<repo>/.intentic/checks.json`), compiled into this same table by the daemon,
// so no command lives in settings. Nothing verifies inside a turn: the whole-tree check runs after work lands and never
// holds anything (schemas/workspace/mainline.ts).
export const RuleMomentSchema = z.enum([
    // A command here runs on the just-written file (`{file}` is its path); the cheapest moment to catch a defect.
    "file.edited",
    // Retired: the assistant stopping. Nothing runs here any more and nothing sends a turn back to work; the value stays
    // so settings written before it went still read, and a rule standing here is inert.
    "turn.ending",
    // An agent's turn is over and its delta is sitting on its branch. A rule here decides whether it lands.
    "agent.finished",
    // An agent's delta has just reached the main tree. A rule here decides what becomes of it there.
    "agent.landed",
]);
export type RuleMoment = z.infer<typeof RuleMomentSchema>;
// command: a repository's check; its exit code is the verdict.
// verdict: allows or holds what is about to happen.
// builtin: a daemon behaviour that reads a record only the daemon keeps.
// verify-ui-edits: retired with `turn.ending`, read only so older settings parse; whether a turn looked at the surfaces it
// changed is recorded on its card instead (AgentSummary.proof), never asked of the model.
// version-landed: commits what a land brought, in the main tree, under the subject drafted for it, and the tree's own
// remainder before the next isolated turn starts; the only way a person who never commits keeps every agent seeing
// the latest tree, since worktrees are cut from HEAD.
export const RuleBuiltinSchema = z.enum(["verify-ui-edits", "version-landed"]);
export type RuleBuiltin = z.infer<typeof RuleBuiltinSchema>;
export const RuleActionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("command"),
        command: z.string().max(500),
        // Past this, the process group is killed and the run is `failed`, never a silent pass.
        timeoutMs: z.number().min(60_000).max(3_600_000).default(900_000),
    }),
    z.object({ kind: z.literal("verdict"), verdict: z.enum(["allow", "hold"]) }),
    z.object({ kind: z.literal("builtin"), name: RuleBuiltinSchema }),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;
// `checks-failed` was a clean turn whose `turn.ending` check went red. Nothing produces it now that no check runs inside a
// turn, and a check never holds work; it stays so older rules naming it still read.
export const RuleOutcomeSchema = z.enum(["clean", "error", "conflict", "checks-failed"]);
export type RuleOutcome = z.infer<typeof RuleOutcomeSchema>;
// Every key absent means the rule always matches.
export const RuleConditionSchema = z.object({
    // A workspace repo id, or "root". Absent ⇒ any.
    repo: z.string().min(1).optional(),
    // Globs the change has to touch for the rule to fire. Absent/empty ⇒ any.
    paths: z.array(z.string().min(1)).max(20).optional(),
    // How the turn ended. Absent/empty ⇒ any.
    outcome: z.array(RuleOutcomeSchema).optional(),
    // The fraction of occasions a rule fires on, at a moment that draws one; absent ⇒ every occasion. No moment draws
    // now that `turn.ending` is retired, so a sampled rule fires every time.
    sample: z.number().gt(0).lt(1).optional(),
});
export type RuleCondition = z.infer<typeof RuleConditionSchema>;
// `id` is stable and owner-visible, so a rename doesn't orphan the firing history. Which actions fit which moment is
// validated here, not left to the consumer — the alternative is a rule that saves cleanly and silently does nothing.
const MOMENT_ACTIONS: Record<RuleMoment, readonly RuleAction["kind"][]> = {
    "file.edited": ["command"],
    "turn.ending": ["builtin", "command"],
    "agent.finished": ["verdict"],
    "agent.landed": ["builtin"],
};
// A built-in reads a record only one moment keeps, so it stands at that moment alone.
const MOMENT_BUILTINS: Partial<Record<RuleMoment, readonly RuleBuiltin[]>> = {
    "turn.ending": ["verify-ui-edits"],
    "agent.landed": ["version-landed"],
};
export const RuleSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        label: z.string().min(1).max(80),
        moment: RuleMomentSchema,
        when: RuleConditionSchema.optional(),
        action: RuleActionSchema,
        enabled: z.boolean().default(true),
    })
    .refine((rule) => MOMENT_ACTIONS[rule.moment].includes(rule.action.kind), {
        message: "that action cannot stand at that moment",
        path: ["action"],
    })
    .refine((rule) => rule.action.kind !== "builtin" || (MOMENT_BUILTINS[rule.moment] ?? []).includes(rule.action.name), {
        message: "that built-in cannot stand at that moment",
        path: ["action"],
    });
export type Rule = z.infer<typeof RuleSchema>;
// A rule at a retired moment or with a retired built-in: read, so an older file parses, but never written again.
export const isRetiredMomentRule = (rule: Pick<Rule, "moment" | "action">): boolean =>
    rule.moment === "turn.ending" || (rule.action.kind === "builtin" && rule.action.name === "verify-ui-edits");
// Kept out of the settings object on purpose: a firing is not an edit, and writing config on every push would make
// every run a settings save.
export const RuleFiringsSchema = z.record(z.string(), z.number());
export type RuleFirings = z.infer<typeof RuleFiringsSchema>;
// Where a skill came from, the fact that decides everything else about its row.
// builtin: this image ships it.
// own: the owner wrote it (.intentic/config/skills/); on while its loaded copy exists; only these are editable here.
// capability: something connected brought it (a CLI tool, a machine, a browser account, a VPN).
// extension: an installed extension ships it inside its checkout.
// plugin: a plugin capability cloned a repo that holds it.
// persona: one card's own kit carries it; only turns wearing that card see it.
// dropped: sitting in the loaded folder by hand or by the agent, claimed by nothing else.
// Not a capability kind: a capability can be broken and wants a status light, a skill either exists or it doesn't.
export const SkillOriginSchema = z.enum(["builtin", "own", "capability", "extension", "plugin", "persona", "dropped"]);
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;
// Same slug shape the SDK's loader accepts, checked here so a bad name is a refused save, not a skill that silently
// never loads.
export const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a skill name is lowercase letters, digits and dashes");
export const SkillSummarySchema = z.object({
    // Qualified as `<origin>:<owner>:<name>` for anything not `own`/`builtin`.
    id: z
        .string()
        .describe(
            "Its handle, which reading and deleting take. A skill of your own is simply its name; one belonging to something else is qualified, because two packages may each ship a review.",
        ),
    name: z.string().describe("Its name."),
    description: z
        .string()
        .describe(
            "What it is for, which is the line the agent reads to decide whether to reach for it. Empty when the skill declares none, which is worth showing as the blank it is: a skill with no description is rarely picked.",
        ),
    origin: SkillOriginSchema.describe("Where it came from."),
    // e.g. an extension's title, a plugin capability's id, a setting's name.
    owner: z.string().optional().describe("Who ships it, as the row would name them."),
    enabled: z.boolean().describe("Whether the agent can reach it."),
    // True for a baked tool (switched through the settings `skills` list) and the owner's own (through `skills.switch`).
    switchable: z
        .boolean()
        .describe(
            "Whether this surface can switch it. Everything else is on because its extension or its plugin is, and a switch here that silently did nothing would be worse than none, so the row names its owner instead.",
        ),
    editable: z
        .boolean()
        .describe(
            "Whether it can be rewritten here. Your own only: editing somebody else's in place would be undone the next time the thing that ships it catches up.",
        ),
    // Wider than `editable` by one case: a dropped skill isn't the owner's to edit, but is theirs to remove, with no
    // other way to short of the file tree.
    removable: z.boolean(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export const SkillsListSchema = z.array(SkillSummarySchema);
// Its own route, not a field on the summary: bodies run to thousands of words, too costly to include in a list of
// one-line rows.
export const SkillBodySchema = z.object({
    id: z.string().describe("The skill's id, which can carry the owner it came from."),
    name: z.string().describe("Its name."),
    // Everything after the frontmatter.
    body: z.string().describe("The instructions themselves, as written."),
});
export type SkillBody = z.infer<typeof SkillBodySchema>;
export const SkillIdSchema = z.object({
    id: z
        .string()
        .min(1)
        .describe(
            "Which skill. It travels in the query rather than the address, because an id can name the owner it came from and that will not fit in a path.",
        ),
});
// Three fields because a skill is three things: name, when to reach for it, what to do. The daemon assembles
// frontmatter from the first two, so a saved skill can never be one the loader skips.
export const SkillDraftSchema = z.object({
    name: SkillNameSchema.describe("What to call it. Saving over an existing name rewrites it, which is also how one is renamed."),
    description: z.string().min(1).max(1024).describe("What it is for, which is what the agent reads to decide whether to reach for it."),
    body: z.string().min(1).describe("The skill itself."),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;
export const SkillRemoveSchema = z.object({
    name: SkillNameSchema.describe("Which skill to delete. The stored text and the agent's copy go together, so nothing is left half done."),
});
export const SkillSwitchSchema = z.object({
    name: SkillNameSchema.describe("Which skill of your own to switch."),
    on: z.boolean().describe("On writes the agent's copy from the stored text; off removes that copy and keeps the text."),
});
export type SkillSwitch = z.infer<typeof SkillSwitchSchema>;
// Opt-in settings the /settings routes edit and streamAgent reads, defaulting off so each can be A/B tested (`skills`
// defaults on for the baked tools worth having, since a skill file is the only thing that tells the agent a baked
// binary exists). Every default lives in the schema, so an older settings file still parses and keeps the owner's other
// picks rather than failing whole. A setting removed or reshaped here gets its conversion in settings-history.ts, which
// also names every retired setting, none of whose names may come back.

export const SandboxSettingsSchema = z.object({
    // The zone every WALL-CLOCK RULE in this sandbox is meant in — an automation's cron, and anything else that says
    // "at 09:00" instead of naming an instant. It is not a display preference: nothing formats through it, and an
    // instant on screen is still drawn in the reader's own clock.
    // Empty means nobody has said, and the container's clock (UTC) answers. That is harmless for a sandbox where
    // nothing is scheduled and wrong the moment something is, which is why the editor offers its own zone on first
    // load and the automations screen names this one beside every schedule.
    // An IANA id rather than an offset, because an offset cannot express the summer-time rule that moves "09:00" twice
    // a year, and a chore set in March should still be right in November.
    timezone: z
        .union([z.literal(""), ZoneSchema])
        .default("")
        .describe(
            "Which clock this sandbox's schedules are set by, as a zone name like Europe/Warsaw. Automations that repeat on a clock fire by this, not by the machine's own time. Leave it empty and they fire by UTC, which is almost certainly not what you meant when you typed a time.",
        ),
    stableSystemPrompt: z
        .boolean()
        .default(false)
        .describe(
            "Keep the instructions identical between turns so the provider can cache them, moving anything that varies into the message instead. Cheaper, at the cost of some flexibility.",
        ),
    skills: z.array(z.string()).default(["lsp", "fileq"]).describe("Which built-in tools are switched on. A skill of your own is not listed here: it is on while the agent's copy of it exists."),
    // One half of the reading a new chat gets between send and its first turn (chat-router.ts): with this on, the
    // message and one line per card are put to the same model that chooses what the chat runs on, in the same call.
    // Never asked of a draft: only a sent message is a finished one. Attended chats only: routing onto a card would
    // grant an unwatched wake accounts nobody named for it.
    personaRouting: z
        .boolean()
        .default(true)
        .describe(
            "Whether a new chat is matched to one of your personas from its first message. It is read once the message is sent, in the same single call that chooses what the chat runs on (the New chat routing job under Models), and the chat says in its own transcript which persona it landed on. Never applies to unwatched runs, which name their persona themselves.",
        ),
    hashlineEdits: z
        .boolean()
        .default(false)
        .describe(
            "Have the agent edit files by line number rather than by quoting the text it wants replaced. Cheaper on large files, and less forgiving of a stale read.",
        ),
    // intentic: Claude Code's preset, read the same way, with what this harness does not want cut out (intentic-prompt.ts).
    // Default.
    // claude: Claude Code's preset, read live from the installed CLI, not a stored copy — tracks whatever prompt ships
    // with it.
    // custom: `systemPrompt` below, and nothing else.
    systemPromptMode: SystemPromptModeSchema.default("intentic").describe(
        "Which instructions the agent starts from: intentic's own, the ones the installed Claude Code carries, or your own. The first two both get this product's own guidance added on top; your own gets nothing added, which is the point of it.",
    ),
    // The delegation note still survives (it lives in the user-message preamble, not here). Cap is roomy but finite —
    // every turn pays for it.
    systemPrompt: z
        .string()
        .max(20000)
        .default("")
        .describe(
            "Your own instructions, used only when the mode above says custom. Then it is the whole of them: both built-in bases go, and so does everything this product would otherwise add, including the guidance the chat's own cards are driven by. That is the price of total control.",
        ),
    // Measured by the `guidance` experiment against the full set; the full set stays the default until that says otherwise.
    leanGuidance: z
        .boolean()
        .default(false)
        .describe(
            "Send this product's own guidance in its short form: only what the agent cannot find out by looking, instead of a paragraph for every habit it was once caught in. Off by default, because the long form is the one the product was tuned on.",
        ),
    leanGuidanceHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
            "What share of conversations to keep on the long form, so the two can be compared. Whole conversations rather than individual turns, because the guidance sits in the prompt for the whole session.",
        ),
    iqSearch: z
        .boolean()
        .default(false)
        .describe("Teach the agent how to use this workspace's own search tool, rather than leaving it to grep around."),
    iqSearchHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
            "What share of conversations to run without that teaching, so the two can be compared. Whole conversations rather than individual turns, because once the teaching is in a session, withholding it from the next request does not make the model forget it.",
        ),
    // Rooted at the run's own starting folder (a persona's, an isolated conversation's worktree), not the workspace
    // root — it maps the project containing that folder.
    workspaceMap: z
        .boolean()
        .default(false)
        .describe(
            "Open every conversation with a map of the project it starts in: what is in it, what each part is for, and where the agent is standing. Worked out fresh each time rather than written down anywhere, because a written layout is wrong within a fortnight. Off by default, since it spends tokens on the first message of every conversation.",
        ),
    // Judged on the opening turn's own directory listings, not averaged across the conversation, or a twelve-turn
    // conversation would divide the effect by twelve.
    workspaceMapHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
            "What share of conversations to open without the map, so the two can be compared. Whole conversations rather than individual turns, because the map is sent once and stays in the conversation's history afterwards.",
        ),
    // The one composed piece that is WRITTEN rather than derived: a monthly automation rewrites it off the session
    // corpus, so it carries what no scan of the tree can (which commands really work here, what the box can take, how
    // the owner asks for things) and the map keeps carrying what a scan can.
    fieldNotes: z
        .boolean()
        .default(false)
        .describe(
            "Open every turn with a brief on how work actually goes in this sandbox: the traps that cost past sessions calls, the commands that really verify, what the machine can take. Written once a month by an automation that reads back the sessions run here, rather than worked out per turn, because it is drawn from history rather than from the tree. Off by default, since it rides every turn of every conversation.",
        ),
    // Characters, not sections: the file's own ranking decides WHICH sections, this decides HOW MANY fit. Same unit as
    // the project map's ceiling so the two costs read on one scale.
    fieldNotesBudget: z
        .number()
        .int()
        .min(500)
        .max(20000)
        .default(4000)
        .describe(
            "How much of that brief to send. Its sections are ranked, most costly-to-not-know first, and they are taken whole in that order until this runs out — so raising it buys more of the tail, never a fuller version of the same thing.",
        ),
    fieldNotesHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
            "What share of conversations to run without the brief, so the two can be compared. Whole conversations rather than individual turns, because the brief sits in the prompt for the whole session and withholding it from one turn would not take it back.",
        ),
    // Only the eager background pass; the `fileq` CLI itself is always on PATH regardless, gated only by its own skill.
    sidecars: z
        .boolean()
        .default(false)
        .describe(
            "Keep an up-to-date markdown rendering of every document, image and audio file in the workspace, made in the background as files land, so the agent reads a pre-derived text instead of paying to parse the file mid-task. Costs background CPU on a document-heavy workspace, so it is a switch rather than a default.",
        ),
    outputCleaners: z
        .string()
        .default("")
        .describe("Which command outputs to trim before the agent reads them, cutting the noise a build tool prints without cutting what it said."),
    outputHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe("What share of commands to leave untrimmed, so the saving can be measured against a real comparison rather than estimated."),
    // One key, not one field per role: a role catalog entry (`model-roles.ts`) makes a new job configurable without a
    // schema change here.
    // `partialRecord`, not `record`: an exhaustive one would force every settings file to list every role, and adding
    // one would invalidate them all. Absent IS "no list".
    modelRoles: z
        .partialRecord(ModelRoleSchema, z.array(ModelPinSchema).max(10))
        .default({})
        .describe(
            "Which models do which job, one ordered list per job: commit messages, session titles, the safety judge, pipeline fixes, and every other place this sandbox picks a model for you. Tried in order, so one spent account does not take a job down. Nothing is chosen for you: a one-shot job with no list does not run, and a whole session with no list opens on whatever your own chat is set to.",
        ),
    // Folded into the router's prompt (agent/prompt/chat-router.ts), never into a turn's own. Capped small on
    // purpose: the reading runs under a 5s deadline, and this text is paid for on every chat that opens on Auto.
    autoModelGuidance: z
        .string()
        .max(2000)
        .default("")
        .describe(
            "What you would tell somebody choosing the model for a new chat on your behalf: which model you want the cheap work on, which account to leave alone, when to reach for the strongest one. Read once per chat, alongside the models and allowances this sandbox can actually run, and it overrides the product's own advice where the two disagree. It cannot invent a model: the answer is still a choice from that list.",
        ),
    // Named by repo id ("root" or discoverRepos's dir); a commit spanning repos gets the trailer only where one was
    // asked for.
    changelogRepos: z
        .array(z.string())
        .max(50)
        .default([])
        .describe(
            "Which repositories keep a changelog, and so get a user-facing note written alongside each merge. A list rather than a switch, and empty by default, because the commit writer's standing rule is to copy the house style rather than impose one, and a repository that has never written such a note gives it nothing to copy.",
        ),
    agentRetentionDays: z
        .number()
        .min(0)
        .max(365)
        .default(3)
        .describe(
            "How many days a finished conversation stays on the board before being put away. Zero means never. The one setting here that defaults on, because each card left behind is a real working copy on disk, not just a row.",
        ),
    // One answer per ending, never a set of switches over the same event: the chat's own question and these rows are
    // the same question at two scopes. Every ending defaults to `wait`, because a re-run spends the reader's allowance
    // on a turn they sent once.
    limitPolicy: LimitPolicySchema.default("wait").describe(
        "What happens to a turn a spent usage limit refused. `wait` holds it for a press. `resend` sends it again by itself once the allowance reopens, which needs a provider that publishes a reset (Grok and Cursor publish none). `move` also tries another connected account of the same provider that still has room, as soon as the refusal lands, and keeps the reset as its fallback. The sandbox-wide default; any one conversation can say otherwise.",
    ),
    // Off still records the failure, so the per-conversation offer arms normally; nothing is lost, just not automatic.
    outagePolicy: RetryPolicySchema.default("wait").describe(
        "What happens to a turn the model provider's own failure killed. `wait` holds it for a press. `retry` re-runs it on the shared per-provider breaker, backing off between attempts. The sandbox-wide default; any one conversation can say otherwise. Worth `retry` for a sandbox whose work mostly happens with nobody in the room.",
    ),
    // The posture that used to live only in a browser tab; moving it here is what lets it fire with nothing open.
    stopPolicy: RetryPolicySchema.default("wait").describe(
        "What happens to a turn that stopped short with nothing to repair — a hung runtime, a crashed harness. `wait` holds it for a press. `retry` re-runs the held turn on a short ladder, standing down after three tries that got nowhere rather than looping forever.",
    ),
    limitMoveCarryUnder: z
        .number()
        .int()
        .min(0)
        .default(100_000)
        .describe(
            "When a spent usage limit moves a turn to another account, carry the provider session (the model keeps everything, and re-reads all of it once on the other account) while the conversation's context is under this many tokens; at or above it, start a fresh session with the sandbox's measured brief instead. Zero always starts fresh.",
        ),
    // Off by default: every refresh spends the account's own allowance on a conversation nobody is using yet.
    keepWarm: z
        .boolean()
        .default(false)
        .describe(
            "Keep a Claude conversation's prompt cache warm after each turn a person asked for, so coming back to it hours later costs a cache read instead of re-sending everything. Each refresh re-reads the cached context at the cache price and adds nothing to the conversation. Any one conversation can be kept warm or let cool by hand either way.",
        ),
    keepWarmHours: z
        .number()
        .min(1)
        .max(8)
        .default(4)
        .describe(
            "How long an idle conversation is kept warm after its last turn, in hours. Shortened where refreshing would cost more than the cold resume it saves, and at midnight where the agent runs, when the date in its prompt changes.",
        ),
    keepWarmMinTokens: z
        .number()
        .int()
        .min(0)
        .default(100_000)
        .describe("Only conversations at least this large, in tokens, are kept warm by themselves: a small one is cheap to re-read anyway."),
    keepWarmReserve: z
        .number()
        .int()
        .min(0)
        .max(90)
        .default(15)
        .describe(
            "How much of an account's usage limit, in percent, keeping conversations warm must leave untouched for real work. Refreshing stops once any limit that account's model spends is fuller than that.",
        ),
    // Worth it since the container is recreated on every update or environment approval — otherwise approving a
    // Dockerfile change costs the run that asked for it.
    // What happens to breakage found after the work that caused it has left the turn. A land that turns the main tree's own
    // check red waits for the lands queued behind it to be checked too, then goes back to the conversation that landed it
    // while that one still has it in mind, or to a fresh conversation when nobody can be named or the one named has gone
    // cold; main's CI staying red on one failure gets a fix agent once pushes go quiet, with a fleet failure re-run instead.
    // Off, all of it is only reported.
    autoRepair: z
        .boolean()
        .default(true)
        .describe(
            "Whether breakage found after the work left its turn is repaired without asking. A land that turns the main tree's check red is repaired once the work queued behind it has been checked too: by the conversation that landed it while it still has the work in mind, otherwise by a fresh conversation handed the failures and the suspects' changes. Main's CI staying red on the same failure gets a fix agent once pushes go quiet, and a failure on the CI fleet itself is re-run once instead. Off, all of it is only reported.",
        ),
    // Where heavy work runs: a runner (the same image, on one of the owner's machines) instead of this sandbox. Keyed by
    // the heavy-command rule an agent's command matched (platform/resources/heavy-commands.ts), and one entry for the
    // check after landing, each naming a runner id. A runner that is offline, outdated or full hands the work back here,
    // which the command's output says. Never pushed to a runner itself (portability/definition.ts), which must not pass
    // work on again.
    offload: z
        .object({
            commands: z.record(z.string().min(1), z.string().min(1)).default({}),
            landCheck: z.string().min(1).optional(),
        })
        .default({ commands: {} })
        .describe(
            "Which heavy work runs on a runner on one of your machines instead of this sandbox: agents' commands by the kind the heavy-command rules sort them into (tests, typechecks, verify…), and the check after landing. The code travels as it stands, uncommitted work included; the output streams back, and any file the command changed comes back with it. A machine that is offline, outdated or busy hands the work back to this sandbox, and the output says so.",
        ),
    autoResumeOnRestart: z
        .boolean()
        .default(false)
        .describe(
            "Whether a turn killed by the sandbox restarting is re-run once it comes back. A switch rather than one of the policies above, because a restart is the one ending with nobody watching it, so there is no in-chat question to answer. Off to begin with: it would spend your allowance on work you are not watching and edit files while you are still waiting for the sandbox to return. Either way the interruption is recorded rather than silently lost.",
        ),
    // Which repositories' own declarations (`<repo>/.intentic/checks.json`) the owner has switched on, each against the
    // fingerprint of what was declared when they did. A declaration that has since changed no longer matches its
    // fingerprint and is held rather than run, which is what makes adoption a decision about a command rather than a
    // permanent permission on a folder. Keyed by repo id, so `/` in the key is ordinary.
    adoptedChecks: z
        .record(z.string(), z.string())
        .default({})
        .describe(
            "Which repositories may run the checks they declare for themselves, and exactly which version of those checks you agreed to. A repository's declaration does nothing until it appears here, the same rule git keeps for hooks, which are never cloned; and a declaration that changes afterwards is held until you look at it again.",
        ),
    // The owner's alone, since a rule can hold work. A command is refused here: it belongs to the repository it checks,
    // in that repository's `.intentic/checks.json`, never in settings.
    rules: z
        .array(RuleSchema)
        .max(50)
        .default([])
        .refine((rules) => rules.every((rule) => rule.action.kind !== "command"), {
            message: "a command belongs in the repository's own .intentic/checks.json, not in settings",
        })
        .describe(
            "Standing decisions about the sandbox's own work: land or hold finished work, save a version of what landed. Empty is the default and is exactly the behaviour of a fresh sandbox, because each of those defaults is what no rule matched means at its own moment. A command to run is a repository's own check, declared in its .intentic/checks.json.",
        ),
    automationFailureLimit: z
        .number()
        .min(0)
        .max(20)
        .default(0)
        .describe(
            "How many failures in a row before an automation switches itself off. Zero means never, which is the default, because the failure is not always the automation's fault and a job disabled at three in the morning is one nobody re-enables. Only real errors count: a guard deciding there was nothing to do, or the sandbox dying mid-run, say nothing about the automation.",
        ),
    // Defaults all-allow, so a fresh sandbox behaves as it did before this floor existed.
    admission: AdmissionPolicySchema.prefault({}).describe(
        "Whether work started from outside may run, per kind of trigger: let it, hold it for approval, or refuse it. Composes with each automation's own setting, and the stricter of the two wins, so holding every visitor's message needs no edit to each automation.",
    ),
    // Keyed by `<provider>.<type>` ("discord.message.send"), or `<provider>.*` as a wildcard — exact key wins;
    // unconfigured is allowed. "hold" can't park a live call: it refuses and points to the approvals queue. The
    // child-agent surface (`agents.spawn`/`agents.spawn.<provider>`) reads the same book, plus its own taint floor for
    // spawns from tainted turns.
    actionRules: z
        .record(z.string(), AdmissionRuleSchema)
        .default({})
        .describe("What an agent may do out in the world, per kind of action: go ahead, ask first, or never."),
    // Command policy itself lives at .intentic/config/safety.md (edited by the Safety page), not here; this only says
    // whether the judge runs at all. Which model judges is the `safety-judge` role in `modelRoles`, not a field here.
    commandJudge: CommandJudgeModeSchema.default("on").describe(
        "Whether a model reads your safety policy before a flagged command runs. Off judges nothing and asks about nothing; Watch judges everything and records it without ever interrupting you, which is how you find out what your policy actually does before you let it stop anything; On lets the verdict decide. Wiping a disk or deleting under /history asks at every setting — that rule is typed rather than judged, and cannot be turned off.",
    ),
    // Three separate ceilings since they stop different things: width (parallel fan-out), lifetime (per conversation),
    // depth (how far a child may delegate) — raising width alone just hits the lifetime cap sooner. Defaults mirror the
    // CLI's own unset behavior; hitting one stops the agent rather than retrying.
    subagentsAtOnce: z.number().min(1).max(200).default(20).describe("How many subagents may work at the same time."),
    subagentsPerTurn: z.number().min(1).max(2000).default(200).describe("How many a single turn may start in total."),
    // Depth 1 means an agent may delegate but its children may not; unlike the other two, a runaway here is
    // multiplicative, not merely wide.
    subagentDepth: z
        .number()
        .min(1)
        .max(10)
        .default(3)
        .describe("How many levels deep the delegation may go, since a subagent can start subagents of its own."),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;
// What a save takes: the settings as read, less what is only read. `turn.ending` (and its `verify-ui-edits` built-in) is
// retired; a file written before still parses (and its conversion drops such rules), but no save may stand a new one.
export const SandboxSettingsWriteSchema = SandboxSettingsSchema.refine((settings) => !settings.rules.some(isRetiredMomentRule), {
    message: "turn.ending is retired: nothing runs when a turn ends any more, so a rule cannot stand there",
    path: ["rules"],
});

// A browser telling the sandbox which clock IT is on. An offer, not an instruction: see `adoptTimezone`.
export const TimezoneOfferSchema = z.object({
    timezone: ZoneSchema.describe("The zone the offering machine is in, as an IANA name like Europe/Warsaw."),
});
export type TimezoneOffer = z.infer<typeof TimezoneOfferSchema>;

// What the sandbox's clock is after the offer, and whether the offer is what set it. `adopted: false` with a zone
// back means somebody had already chosen, which is the normal answer for every browser after the first.
export const TimezoneStateSchema = z.object({
    timezone: z.string().describe("The zone this sandbox's schedules are now read in. Empty only if none could be resolved."),
    adopted: z.boolean().describe("Whether this call is what set it. False means it was already answered and the stored zone stands."),
});
export type TimezoneState = z.infer<typeof TimezoneStateSchema>;
// Read live from the installed CLI (preset-prompt.ts), not a stored transcription. `version` is the CLI build it came
// from, so a fork from an older build reads as a snapshot.
export const BuiltinPromptTextSchema = z.object({ text: z.string(), version: z.string() });
export type BuiltinPromptText = z.infer<typeof BuiltinPromptTextSchema>;
// What each token-reduction mechanism actually saved. Input-side: both sides of the comparison come off the same
// command (raw in, emitted out), so the counterfactual is observed, not estimated — exact, per command.

// Sequential attribution (sums exactly to raw − emitted, drawable as a stacked bar); not what disabling this stage
// would save, since downstream would eat some of the same lines. Negative for `footer`, which adds cost back.
export const SavingsStageSchema = z.object({ id: z.string(), commands: z.number(), savedTokens: z.number() });
// Aggregated from historyRoot/logs/filter-stats.jsonl (one row per Bash command). Windowed on the ledger's own UTC-day
// calendar, so the reader's date range and these figures agree.
export const InputSavingsSchema = z.object({
    // Epoch ms of the ledger's last command, so the card can show its age rather than implying freshness.
    updatedAt: z.number().optional(),
    commands: z.number(),
    rawTokens: z.number(),
    emittedTokens: z.number(),
    savedPct: z.number(),
    // Per-stage attribution, biggest first.
    perCleaner: z.array(SavingsStageSchema),
    // The measured control (raw vs. cleaned); the only real whole-pipeline counterfactual, not an estimate.
    holdout: z.object({ cleaned: z.number(), heldOut: z.number(), measuredSavedPct: z.number().optional() }),
    // Grouped by command text: worth a handler is judged by total tokens across runs, not one outlier's size.
    gaps: z.array(z.object({ command: z.string(), commands: z.number(), tokens: z.number() })),
});
export type InputSavings = z.infer<typeof InputSavingsSchema>;
// One arm of a turn-level experiment; mean is per turn, since the two arms never hold the same count.
export const SavingsArmSchema = z.object({ turns: z.number(), mean: z.number() });
// One metric's reading of a turn-level experiment (the two arms, plus the arithmetic over them). `metric` says what
// `mean`/`deltaPct` count:
// searchCalls: searches a turn ran (the search teaching).
// openingSearches: same, narrowed to before the turn first touched a file.
// openingListings: directory listings a turn ran to orient itself (the project map).
// callsBeforeTarget: how far a turn walked before touching a file it went on to edit.
// failedCalls: tool calls that ended in error (the field notes, whose largest section is a failure taxonomy).
// Never cost: each mechanism moves one small part of a turn's work, inside the noise of the rest.
export const TurnMetricReadingSchema = z.object({
    metric: z.enum(["searchCalls", "openingSearches", "openingListings", "callsBeforeTarget", "failedCalls"]),
    on: SavingsArmSchema,
    off: SavingsArmSchema,
    // Additional control turns to reach a fixed target resolution, not today's delta (which inherits noise and always
    // promises "next week"). Absent means nothing to wait for: under `minTurns`, already published, or already resolved
    // enough.
    controlTurnsNeeded: z.number().optional(),
    // ± percentage points at 95% (Welch); present once both arms clear `minTurns`, even when `deltaPct` is withheld —
    // "smaller than ±35 points" is still a useful, true answer.
    marginPct: z.number().optional(),
    // Present only once the margin excludes zero — clearing `minTurns` alone isn't enough, or a wide, unresolved swing
    // reads as a real number.
    // deltaPct: change in the metric's mean per turn; negative is a saving.
    // saved: what that delta was worth over the turns that ran with it, in the metric's own unit.
    deltaPct: z.number().optional(),
    saved: z.number().optional(),
});
export type TurnMetricReading = z.infer<typeof TurnMetricReadingSchema>;
// One coin flip, several readings: `metrics` is a list since splitting readings into separate entries would duplicate
// the arm assignment. Screens read `metrics[0]` as the headline, the rest as supporting lines.
export const TurnExperimentSchema = z.object({
    // A head and a tail, not a plain array, so "always a headline" is a type fact, not a check every screen repeats.
    // `.nonempty()` doesn't do this in zod 4 (a runtime check, still typed as a plain array).
    metrics: z.tuple([TurnMetricReadingSchema], TurnMetricReadingSchema),
    // Carried on the wire so "measuring…" reflects the daemon's real threshold, not a guess; shared across every
    // reading, since they're the same turns.
    minTurns: z.number(),
    // Turn mechanisms randomize by turn; session-loaded teaching randomizes whole conversations; a once-sent treatment
    // (the map) samples one turn per conversation, not an average, or its effect divides by the conversation's length.
    sampleUnit: z.enum(["turns", "conversations", "opening turns"]).optional(),
    // Content-addressed treatment version; the reader filters to the latest so two instruction revisions don't blur
    // into one experiment.
    cohort: z.string().optional(),
});
export type TurnExperiment = z.infer<typeof TurnExperimentSchema>;
// What the settings row can say about the brief without opening it: whether there is one, how much of it this budget
// reaches, and whether anything is scheduled to rewrite it. Read off the file and the automation store, never stored.
export const FieldNotesStatusSchema = z.object({
    // False means the automation has never run (or was never set up) — the ordinary state before the first month.
    present: z.boolean(),
    // Epoch ms the file was last written. Absent when there is no file.
    writtenAt: z.number().optional(),
    // How many ranked sections the current budget reaches, out of how many the file holds. The pair is the point: "5"
    // alone cannot tell a generous budget from a short file.
    ranksSent: z.number().optional(),
    ranksTotal: z.number().optional(),
    // What the brief costs the prompt, in characters, at the current budget.
    chars: z.number().optional(),
    // The monthly rewrite: absent until the owner creates it from the offered template, since an automation names the
    // models it spends and nothing chooses those for them.
    automation: z.enum(["missing", "enabled", "disabled"]),
    // When it next runs, epoch ms; absent when there is nothing scheduled.
    nextRunAt: z.number().optional(),
    // Said out loud rather than shown as "no file": a brief that exists and cannot be read is a broken automation.
    unreadable: z.string().optional(),
});
export type FieldNotesStatus = z.infer<typeof FieldNotesStatusSchema>;
export const SavingsReportSchema = z.object({
    input: InputSavingsSchema,
    search: TurnExperimentSchema.optional(),
    // Same absence rule as `search`: not measured, never zero.
    map: TurnExperimentSchema.optional(),
    notes: TurnExperimentSchema.optional(),
    guidance: TurnExperimentSchema.optional(),
});
export type SavingsReport = z.infer<typeof SavingsReportSchema>;

// ---- what a REPOSITORY declares for itself, at `<repo>/.intentic/checks.json` ----
// Here rather than in a file of its own because the line between these shapes and the settings above is authority, not
// subject matter: a repository may declare WHAT to run, because the command belongs beside the scripts it names and
// travels with the checkout; only the sandbox owner decides whether it runs at all (`adoptedChecks` above) and what
// happens when it fails, and that stays in settings.json. Both halves of that one decision read together here, and the
// routes that carry them are the settings routes.

// Where a repository declares them, under the same `.intentic/` folder a directory already uses for its own UI. One
// spelling for the daemon that reads it, the screen that names it and the demo that mimics it.
export const REPO_CHECKS_FILE = `${STATE_DIR}/checks.json`;

// Named for the occasion as a repository would say it: `edit` is `file.edited`, and `land` is the daemon's run over the
// main tree after every land (rules/repo-checks.ts maps them). `turn` is retired: nothing runs when a turn ends any more,
// and a declaration naming it still reads but runs nothing. No check refuses a land, a commit or a push.
// `edit` runs on one file (`{file}`) and its output rides back in the edit's own response, so a command declared there is
// paid per edit and has to take the file.
export const RepoCheckMomentSchema = z.enum(["edit", "turn", "land"]);
export type RepoCheckMoment = z.infer<typeof RepoCheckMomentSchema>;

export const RepoCheckSchema = z.object({
    when: RepoCheckMomentSchema.describe(
        "When to run it: `edit` on each file as it is written (`{file}` is its path), `land` on the main tree after finished work lands (absent, the package's own verify or test script runs there). `turn` is retired and runs nothing: checks no longer run while a conversation works.",
    ),
    run: z.string().min(1).max(500).describe("The command, run in this repository's own directory, so it reads as it would in a terminal there."),
    label: z.string().min(1).max(80).optional().describe("What to call it on screen. Absent names it after the command."),
    // Same ceiling as a rule's own command; past it the process group is killed and the run is a failure.
    timeoutMs: z.number().min(60_000).max(3_600_000).optional().describe("How long it may take before it is killed and counted as failed."),
    // Repo-relative; the daemon prefixes the repo id before matching, since a rule's globs are workspace-relative.
    paths: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("Only run it when the change touches these paths, written relative to this repository. Absent runs it on every change here."),
});
export type RepoCheck = z.infer<typeof RepoCheckSchema>;

// The file itself. One key, so a second concern can be added later without breaking a file anyone has written.
export const RepoChecksFileSchema = z.object({
    checks: z
        .array(RepoCheckSchema)
        .max(10)
        .default([])
        // One land check per repository: it is THE verdict on the main tree the push hook replays, not one of several.
        .refine((checks) => checks.filter((check) => check.when === "land").length <= 1, { message: "a repository declares at most one land check" })
        // A land checks the whole tree an install settled, not a change, so there is nothing for a glob to narrow.
        .refine((checks) => checks.every((check) => check.when !== "land" || check.paths === undefined), { message: "a land check takes no paths" }),
});
export type RepoChecksFile = z.infer<typeof RepoChecksFileSchema>;

// One repository, as a screen reads it: what it declares, and where that stands with the owner.
export const RepoChecksSummarySchema = z.object({
    repo: z.string().describe('Which repository, by its workspace id ("root" is the workspace itself).'),
    path: z.string().describe("Where the declaration lives, relative to the workspace, whether or not the file exists yet."),
    checks: z.array(RepoCheckSchema).describe("What it declares, in the order the file lists them."),
    fired: z
        .array(z.number().nullable())
        .describe(
            "When each declared check last reported something, in the file's order, as epoch milliseconds; null for one that never has, or for the land check, whose verdict the activity feed records instead.",
        ),
    adopted: z
        .boolean()
        .describe("Whether these are running. False means declared and inert: nothing a repository writes runs until the owner switches it on."),
    changed: z
        .boolean()
        .describe(
            "Whether the declaration changed since it was adopted, which holds it until the owner looks again. True only for a repository that was adopted before.",
        ),
    error: z.string().optional().describe("Why the file could not be read, when it exists but does not parse. The checks list is empty in that case."),
    landDefault: z
        .string()
        .optional()
        .describe(
            "What runs on the main tree after a land when the file declares no `land` check: the package's own verify or test script. Absent when the repository has neither.",
        ),
});
export type RepoChecksSummary = z.infer<typeof RepoChecksSummarySchema>;
export const RepoChecksListSchema = z.object({
    repos: z.array(RepoChecksSummarySchema).describe("Every repository that declares checks or has a package check that runs after a land, in id order."),
});
export type RepoChecksList = z.infer<typeof RepoChecksListSchema>;
export const RepoChecksAdoptSchema = z.object({
    repo: z.string().min(1).describe("Which repository's declaration to switch."),
    on: z
        .boolean()
        .describe("On adopts what it declares as it stands now; off stops running it. Adopting again is how a changed declaration is accepted."),
});
export type RepoChecksAdopt = z.infer<typeof RepoChecksAdoptSchema>;
