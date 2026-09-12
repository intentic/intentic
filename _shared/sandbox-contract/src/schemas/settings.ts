// settings: per-sandbox agent settings (.intentic/config/settings.json), plus the checks a repository declares for
// itself, which those settings adopt.
import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";
import { CommandJudgeModeSchema } from "../policy/safety-policy.js";
import { ModelRoleSchema } from "../models/model-roles.js";
import { AdmissionPolicySchema, AdmissionRuleSchema, ModelPinSchema } from "./agent.js";
// Which prompt base the agent runs before this turn composes anything on top: Intentic's own (default), Claude Code's
// preset, or the owner's text. Declared out here since both the daemon and the browser branch on it.
export const SystemPromptModeSchema = z.enum(["intentic", "claude", "custom"]);
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>;
// Excludes "custom": there is nothing to fetch, it's whatever the owner already typed into the settings field.
export const BuiltinPromptSchema = z.object({ base: z.enum(["intentic", "claude"]) });
// Declared out here because the daemon branches on it in three places (whether to wire the hook, consult the successor
// list, what the notice says) and the browser branches on it too.
export const DependencyFreshnessSchema = z.enum(["off", "versions", "full"]);
export type DependencyFreshness = z.infer<typeof DependencyFreshnessSchema>;
// Rules: "at this moment, if this is true, do this" — one table replacing three settings that were the same idea built
// three ways; a fourth is now a row here, not a release. Moments are named to match `WorkspaceEventKind`, so folding
// chores in later won't rename what users wrote.

// Four places the daemon already stops to decide something; this names those decisions rather than inventing new ones.
export const RuleMomentSchema = z.enum([
    // A command here runs on the just-written file (`{file}` is its path); the cheapest moment to catch a defect.
    "file.edited",
    // The assistant is about to stop. A rule here can send it back to work, which is the only moment that can.
    "turn.ending",
    // Code is about to leave the machine. A rule here gates the push on its own exit code.
    "push.starting",
    // An agent's turn is over and its delta is sitting on its branch. A rule here decides whether it lands.
    "agent.finished",
]);
export type RuleMoment = z.infer<typeof RuleMomentSchema>;
// What a rule does; the split is functional since the three settings this table replaces each needed a different shape.
// command: runs a shell command; its exit code is the verdict.
// instruct: says something to the assistant before it finishes.
// verdict: allows or holds what is about to happen (a pass with nothing to run, told which way to go).
// builtin: invokes a named daemon behaviour the table has no business expressing itself.
// Each reads a record only the daemon keeps, which is what makes it a built-in rather than a command.
// verify-edits: what a turn edited, against what it ran.
// verify-removals: what a turn deleted, against the repo's own history (a `git log` question, not a shell one-liner).
// verify-ui-edits: rendered surfaces a turn changed, against whether it ever looked at one.
// verify-tests: whether a touched test's assertions got weaker than at HEAD, or would have passed before its own
// change.
export const RuleBuiltinSchema = z.enum(["verify-edits", "verify-removals", "verify-ui-edits", "verify-tests"]);
export type RuleBuiltin = z.infer<typeof RuleBuiltinSchema>;
export const RuleActionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("command"),
        command: z.string().max(500),
        // Past this, the process group is killed and the run is `failed`, never a silent pass.
        timeoutMs: z.number().min(60_000).max(3_600_000).default(900_000),
    }),
    z.object({ kind: z.literal("instruct"), text: z.string().min(1).max(4000) }),
    z.object({ kind: z.literal("verdict"), verdict: z.enum(["allow", "hold"]) }),
    z.object({ kind: z.literal("builtin"), name: RuleBuiltinSchema }),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;
// `checks-failed` is a clean turn whose `turn.ending` check went red on the tree about to land; unlike the others, it
// defaults to HELD unless a rule explicitly allows it.
export const RuleOutcomeSchema = z.enum(["clean", "error", "conflict", "checks-failed"]);
export type RuleOutcome = z.infer<typeof RuleOutcomeSchema>;
// Three keys covering "only this repo" and "skip docs-only changes" without a query language; every key absent means
// the rule always matches.
export const RuleConditionSchema = z.object({
    // A workspace repo id, or "root". Absent ⇒ any.
    repo: z.string().min(1).optional(),
    // Globs the change has to touch for the rule to fire. Absent/empty ⇒ any.
    paths: z.array(z.string().min(1)).max(20).optional(),
    // How the turn ended. Absent/empty ⇒ any, except that `checks-failed` never lands by omission.
    outcome: z.array(RuleOutcomeSchema).optional(),
    // The fraction of occasions a rule fires on, at moments that draw one (turn.ending); absent ⇒ every occasion.
    sample: z.number().gt(0).lt(1).optional(),
});
export type RuleCondition = z.infer<typeof RuleConditionSchema>;
// `id` is stable and owner-visible, so a rename doesn't orphan the firing history. Which actions fit which moment is
// validated here, not left to the consumer — the alternative is a rule that saves cleanly and silently does nothing.
const MOMENT_ACTIONS: Record<RuleMoment, readonly RuleAction["kind"][]> = {
    "file.edited": ["command"],
    "turn.ending": ["builtin", "instruct", "command"],
    "push.starting": ["command"],
    "agent.finished": ["verdict"],
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
    });
export type Rule = z.infer<typeof RuleSchema>;
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
// picks rather than failing whole.

export const SandboxSettingsSchema = z.object({
    stableSystemPrompt: z
        .boolean()
        .default(false)
        .describe(
            "Keep the instructions identical between turns so the provider can cache them, moving anything that varies into the message instead. Cheaper, at the cost of some flexibility.",
        ),
    skills: z.array(z.string()).default(["lsp", "fileq"]).describe("Which built-in tools are switched on. A skill of your own is not listed here: it is on while the agent's copy of it exists."),
    // Router reads the sent message and one line per card, once per chat, between send and the first turn
    // (persona-router.ts / model-roles.ts). Never asked of a draft: only a sent message is a finished one.
    // Attended chats only: routing onto a card would grant an unwatched wake accounts nobody named for it.
    personaRouting: z
        .boolean()
        .default(true)
        .describe(
            "Whether a new chat is matched to one of your personas from its first message. The message is read once it is sent, by the model on the persona-routing list, and the chat says in its own transcript what was asked and which persona it landed on. Never applies to unwatched runs, which name their persona themselves.",
        ),
    hashlineEdits: z
        .boolean()
        .default(false)
        .describe(
            "Have the agent edit files by line number rather than by quoting the text it wants replaced. Cheaper on large files, and less forgiving of a stale read.",
        ),
    // intentic: this product's own prompt (intentic-prompt.ts), tuned for this harness. Default.
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
    // Only the eager background pass; the `fileq` CLI itself is always on PATH regardless, gated only by its own skill.
    sidecars: z
        .boolean()
        .default(false)
        .describe(
            "Keep an up-to-date markdown rendering of every document, image and audio file in the workspace, made in the background as files land, so the agent reads a pre-derived text instead of paying to parse the file mid-task. Costs background CPU on a document-heavy workspace, so it is a switch rather than a default.",
        ),
    // versions: a measurement only (the registry's own newest release).
    // full: also the name of a successor, but only where the registry itself corroborates it (deprecated, or nothing
    // published in 18 months) — curation supplies the name, measurement supplies the reason.
    // Informs, never blocks: matching a version the workspace already pins is usually correct, and a gate would fight
    // legitimate work more than it caught mistakes.
    dependencyFreshness: DependencyFreshnessSchema.default("off").describe(
        "Whether a version the agent is about to pin is checked against the package's own registry first. Facts only, or facts plus the name of a maintained replacement where the registry agrees the current choice has been abandoned. It tells the agent and lets it decide rather than refusing, because matching a version your project already uses is usually the right answer and a gate would fight it.",
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
    // Named by repo id ("root" or discoverRepos's dir); a commit spanning repos gets the trailer only where one was
    // asked for.
    changelogRepos: z
        .array(z.string())
        .max(50)
        .default([])
        .describe(
            "Which repositories keep a changelog, and so get a user-facing note written alongside each merge. A list rather than a switch, and empty by default, because the commit writer's standing rule is to copy the house style rather than impose one, and a repository that has never written such a note gives it nothing to copy.",
        ),
    // off: the judge never runs.
    // shadow (default): the judge scores every turn to the ledger; nothing is routed.
    // on: a turn judged fast runs on the cheap rung, where the provider publishes one.
    autoTier: z
        .enum(["off", "shadow", "on"])
        .default("shadow")
        .describe(
            "Whether an easy-looking turn may run on a cheaper model from the same provider. Three states rather than a switch, because the middle one is the only honest road to the third: it scores every turn and routes nothing, so the guess can become a measurement before it changes anything. It can only ever route down, so the worst case is one turn's quality rather than a bill nobody asked for.",
        ),
    // `balanced` is what every verdict recorded before this setting existed was judged against, so shadow history stays
    // comparable.
    autoTierEagerness: z
        .enum(["cautious", "balanced", "eager"])
        .default("balanced")
        .describe(
            "How readily a turn counts as simple enough for the cheaper model. It moves only the cutoff: at every setting a turn still has to say something positively easy, so nothing here can downgrade a short vague request.",
        ),
    // Auto uses the same cheap-end order as this list (`compareCheapestFirst`), so the two can never disagree.
    autoFastModels: z
        .array(z.string())
        .max(10)
        .default([])
        .describe(
            "Which cheaper model a downgraded turn lands on. A list so a sandbox spanning providers can name a rung on each, but not a fallback ladder: an entry naming a different provider than the turn is on is skipped rather than tried, because switching provider retires the conversation and starting over to save a fraction of a penny is not a saving. Empty picks the cheapest the turn's own provider publishes.",
        ),
    agentRetentionDays: z
        .number()
        .min(0)
        .max(365)
        .default(3)
        .describe(
            "How many days a finished conversation stays on the board before being put away. Zero means never. The one setting here that defaults on, because each card left behind is a real working copy on disk, not just a row.",
        ),
    // Off still records the failure, so the per-conversation resume offer arms normally; nothing is lost, just not
    // automatic.
    resumeAfterOutage: z
        .boolean()
        .default(false)
        .describe(
            "Whether a turn killed by the model provider failing is re-run automatically, backing off between attempts. The sandbox-wide default; any one conversation can say otherwise. Off to begin with, because a retry spends your allowance on a turn you sent once and only you can say whether it was worth paying for twice. Worth turning on for a sandbox whose work mostly happens with nobody in the room.",
        ),
    // The one resume that waits for a published instant rather than guessing; a limit with no published reset (Grok,
    // Cursor) never fires this way at all.
    resumeAfterLimit: z
        .boolean()
        .default(false)
        .describe(
            "Whether a turn a spent usage limit refused is sent again by itself once the allowance reopens. The sandbox-wide default; any one conversation can say otherwise. Off to begin with, because the allowance is your budget and a turn that spends it the second it comes back is not a decision to make for you. Worth turning on for a sandbox whose work mostly happens with nobody in the room.",
        ),
    // Same provider only; a different provider would retire the session for a saving that isn't one. Composes with
    // `resumeAfterLimit` into four postures: hold, wait for reset, move-or-hold, move-or-wait.
    moveAfterLimit: z
        .boolean()
        .default(false)
        .describe(
            "Whether a turn a spent usage limit refused is moved to another connected account of the same provider that still has room, as soon as the refusal lands. The sandbox-wide default; any one conversation can say otherwise. Off to begin with, because it spends a second account on your behalf. With no account that has room the turn waits as the setting above says.",
        ),
    limitMoveCarryUnder: z
        .number()
        .int()
        .min(0)
        .default(100_000)
        .describe(
            "When a spent usage limit moves a turn to another account, carry the provider session (the model keeps everything, and re-reads all of it once on the other account) while the conversation's context is under this many tokens; at or above it, start a fresh session with the sandbox's measured brief instead. Zero always starts fresh.",
        ),
    // Worth it since the container is recreated on every update or environment approval — otherwise approving a
    // Dockerfile change costs the run that asked for it.
    autoResumeOnRestart: z
        .boolean()
        .default(false)
        .describe(
            "Whether a turn killed by the sandbox restarting is re-run once it comes back. Off to begin with, for the same reason: it would spend your allowance on work you are not watching and edit files while you are still waiting for the sandbox to return. Either way the interruption is recorded rather than silently lost.",
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
    // Lives in the owner's own settings, not the workspace: a rule can hold work and gate a push, so it answers to the
    // sandbox owner alone. A repository may declare a COMMAND of its own (see `adoptedChecks`), never a verdict.
    rules: z
        .array(RuleSchema)
        .max(50)
        .default([])
        .describe(
            "Standing instructions you give the sandbox about its own work: ask for proof before a turn ends, run something before a push, hold or release finished work. Empty is the default and is exactly the behaviour of a fresh sandbox, because each of those defaults is what no rule matched means at its own moment.",
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
// Read live from the installed CLI (preset-prompt.ts), not a stored transcription. `version` is the CLI build it came
// from, so a fork from an older build reads as a snapshot; empty for Intentic's own prompt.
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
// Never cost: each mechanism moves one small part of a turn's work, inside the noise of the rest.
export const TurnMetricReadingSchema = z.object({
    metric: z.enum(["searchCalls", "openingSearches", "openingListings", "callsBeforeTarget"]),
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
// Absent when the experiment isn't running (flag off, or no holdout set); absence reads as "not measured", not as zero.
// Read off the spend ledger's tier fields over the window; no counterfactual $ saved, since the ledger holds only what
// turns cost. Not a `TurnExperiment`: there's no randomized control, routing follows the settings mode over time, not a
// coin flip. Absent (no turn judged, autoTier off) reads as "not measured", not "measured, found nothing".
export const TierReportSchema = z.object({
    // Turns the judge ran on in the window, the denominator under everything below.
    judged: z.number(),
    // …of which landed at or below FAST_CEILING: the turns that looked simple. fast ÷ judged is the fast share.
    fast: z.number(),
    // Upper bound on any saving, never an estimate: moving these turns to the cheap rung would have cost something too.
    atStakeUsd: z.number(),
    // Turns that actually ran the cheap rung, and what they cost there. Realized, not projected.
    routed: z.number(),
    routedUsd: z.number(),
    // The guardrail: fast-judged turns whose very next ledger row asked for a dearer model. Past a few percent of
    // `fast`, the judge costs more in trust than it saves.
    escalated: z.number(),
    // Fast-judged turns the user vetoed outright (UsageTurn.tierDenied): the same signal, said even louder.
    denied: z.number(),
});
export type TierReport = z.infer<typeof TierReportSchema>;
// One dependency version or library improvement suggested or pinned.
export const DependencyImprovementSchema = z.object({
    prevented: z.string(),
    chosen: z.string(),
    reason: z.string(),
    at: z.number().optional(),
});
export type DependencyImprovement = z.infer<typeof DependencyImprovementSchema>;
// Rollup of registry freshness interventions over the queried day window.
export const DependencySavingsSchema = z.object({
    checked: z.number(),
    improved: z.number(),
    recent: z.array(DependencyImprovementSchema),
    updatedAt: z.number().optional(),
});
export type DependencySavings = z.infer<typeof DependencySavingsSchema>;
export const SavingsReportSchema = z.object({
    input: InputSavingsSchema,
    search: TurnExperimentSchema.optional(),
    // Same absence rule as `search`: not measured, never zero.
    map: TurnExperimentSchema.optional(),
    // Automatic tier selection's readout, see TierReportSchema. Absent ⇒ nothing was judged in the window.
    tier: TierReportSchema.optional(),
    dependencies: DependencySavingsSchema.optional(),
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

// Named for the occasion as a repository would say it, not for the daemon's wire moment: `turn` is `turn.ending` and
// `push` is `push.starting` (rules/repo-checks.ts maps them). Two, because these are the two occasions whose command a
// repository actually owns; a verdict moment has nothing here to express.
export const RepoCheckMomentSchema = z.enum(["turn", "push"]);
export type RepoCheckMoment = z.infer<typeof RepoCheckMomentSchema>;

export const RepoCheckSchema = z.object({
    when: RepoCheckMomentSchema.describe("When to run it: `turn` before the assistant finishes, `push` before code leaves the machine."),
    run: z.string().min(1).max(500).describe("The command, run in this repository's own directory, so it reads as it would in a terminal there."),
    label: z.string().min(1).max(80).optional().describe("What to call it on screen. Absent names it after the command."),
    // Same ceiling as a rule's own command; past it the process group is killed and the run is a failure, never a
    // silent pass.
    timeoutMs: z.number().min(60_000).max(3_600_000).optional().describe("How long it may take before it is killed and counted as failed."),
    // Repo-relative, as anybody reading this file would write them; the daemon prefixes the repo id before matching,
    // since a rule's globs are workspace-relative.
    paths: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("Only run it when the change touches these paths, written relative to this repository. Absent runs it on every change here."),
});
export type RepoCheck = z.infer<typeof RepoCheckSchema>;

// The file itself. One key, so a second concern can be added later without breaking a file anyone has written.
export const RepoChecksFileSchema = z.object({ checks: z.array(RepoCheckSchema).max(10).default([]) });
export type RepoChecksFile = z.infer<typeof RepoChecksFileSchema>;

// One repository, as a screen reads it: what it declares, and where that stands with the owner.
export const RepoChecksSummarySchema = z.object({
    repo: z.string().describe('Which repository, by its workspace id ("root" is the workspace itself).'),
    path: z.string().describe("Where the declaration lives, relative to the workspace, whether or not the file exists yet."),
    checks: z.array(RepoCheckSchema).describe("What it declares, in the order the file lists them."),
    adopted: z
        .boolean()
        .describe("Whether these are running. False means declared and inert: nothing a repository writes runs until the owner switches it on."),
    changed: z
        .boolean()
        .describe(
            "Whether the declaration changed since it was adopted, which holds it until the owner looks again. True only for a repository that was adopted before.",
        ),
    error: z.string().optional().describe("Why the file could not be read, when it exists but does not parse. The checks list is empty in that case."),
});
export type RepoChecksSummary = z.infer<typeof RepoChecksSummarySchema>;
export const RepoChecksListSchema = z.object({
    repos: z.array(RepoChecksSummarySchema).describe("Every repository that declares checks, plus any the owner has adopted before, sorted by id."),
});
export type RepoChecksList = z.infer<typeof RepoChecksListSchema>;
export const RepoChecksAdoptSchema = z.object({
    repo: z.string().min(1).describe("Which repository's declaration to switch."),
    on: z
        .boolean()
        .describe("On adopts what it declares as it stands now; off stops running it. Adopting again is how a changed declaration is accepted."),
});
export type RepoChecksAdopt = z.infer<typeof RepoChecksAdoptSchema>;
