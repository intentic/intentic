// settings: per-sandbox agent settings (.intentic/config/settings.json)
import { z } from "zod";
import { AdmissionPolicySchema, AdmissionRuleSchema, CommandClassSchema } from "./agent.js";
// Which prompt the agent is, before this turn composes anything on top. Two built-in bases and an escape
// hatch: Intentic's own (the default), Claude Code's preset, or the owner's text. Declared out here rather
// than inline in the settings object because both sides of the wire branch on it, the daemon to build the
// turn, the browser to decide which base it can show you.
export const SystemPromptModeSchema = z.enum(["intentic", "claude", "custom"]);
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>;
// The two bases a user can READ and fork, "custom" is excluded because there is nothing to fetch: it is
// whatever they have already typed into the settings field.
export const BuiltinPromptSchema = z.object({ base: z.enum(["intentic", "claude"]) });
/* ---- rules: "at this moment, if this is true, do this" ------------------------------------------------------
 *
 * The one table behind every standing instruction the owner gives the sandbox about its own work. It replaces
 * three settings that were the same idea built three ways, ask for proof before a turn ends, run a command
 * before a push, hold or release finished work, and the point of replacing them is that a FOURTH is now a row
 * in this table rather than a release.
 *
 * The moments are named to sit in one family with WorkspaceEventKind (`turn.settled`, `agent.landed`), because
 * chores already wake on those and folding them into this table later must not mean renaming what users wrote.
 */

// WHERE a rule can stand. Three, and each is a place the daemon already stopped to make a decision, this
// names those decisions rather than inventing new ones.
export const RuleMomentSchema = z.enum([
    // The assistant is about to stop. A rule here can send it back to work, which is the only moment that can.
    "turn.ending",
    // Code is about to leave the machine. A rule here gates the push on its own exit code.
    "push.starting",
    // An agent's turn is over and its delta is sitting on its branch. A rule here decides whether it lands.
    "agent.finished",
]);
export type RuleMoment = z.infer<typeof RuleMomentSchema>;
/* WHAT A RULE DOES. Four shapes, and the split is functional rather than tidy: the three settings this table
 * replaces need three DIFFERENT ones, which is the evidence that a single "run this command" table would have
 * mangled at least two of them.
 *
 *   command, run a shell command; its exit code is the verdict. What the pre-push check always was.
 *   instruct, say something to the assistant, so it acts before it finishes.
 *   verdict, allow or hold the thing that is about to happen. The vocabulary the permission rules already
 *             speak, and the honest shape of "land finished work automatically": nothing extra RUNS at that
 *             moment, a pass that always runs is told which way to go.
 *   builtin, invoke a named daemon behaviour. The escape hatch that keeps this table from having to express
 *             machinery it has no business expressing: the proof ledger behind "verify before finishing"
 *             tracks what a turn edited against what it ran, which is not a shell command and never will be.
 */
/* The named behaviours a rule can invoke. Both read a record only the daemon keeps, which is what makes them
 * built-ins rather than commands: `verify-edits` weighs what a turn edited against what it ran, and
 * `verify-removals` weighs what a turn DELETED against what the repository's history says about those lines,
 * which is a question `git log` answers and no shell one-liner an owner could type would. */
export const RuleBuiltinSchema = z.enum(["verify-edits", "verify-removals"]);
export type RuleBuiltin = z.infer<typeof RuleBuiltinSchema>;
export const RuleActionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("command"),
        command: z.string().max(500),
        // Ceiling on one run, after which the child's whole process group is killed and the run is `failed`.
        // Never a pass: a command that did not finish has said nothing, and a green light nobody earned is the
        // one outcome a check exists to prevent.
        timeoutMs: z.number().min(60_000).max(3_600_000).default(900_000),
    }),
    z.object({ kind: z.literal("instruct"), text: z.string().min(1).max(4000) }),
    z.object({ kind: z.literal("verdict"), verdict: z.enum(["allow", "hold"]) }),
    z.object({ kind: z.literal("builtin"), name: RuleBuiltinSchema }),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;
// WHEN a rule narrows. Three keys, chosen because they cover the two things people reach for on day one,
// "only this repo" and "don't bother for a docs-only change", without opening a query language. Every key
// absent ⇒ the rule always matches at its moment, which is what the three replaced settings each did.
export const RuleConditionSchema = z.object({
    // A workspace repo id, or "root". Absent ⇒ any.
    repo: z.string().min(1).optional(),
    // Globs the change has to touch for the rule to fire. Absent/empty ⇒ any.
    paths: z.array(z.string().min(1)).max(20).optional(),
    // How the turn ended. Absent/empty ⇒ any.
    outcome: z.array(z.enum(["clean", "error", "conflict"])).optional(),
});
export type RuleCondition = z.infer<typeof RuleConditionSchema>;
/* ONE RULE. `id` is stable and owner-visible: it is what the activity feed names when the rule fires and what
 * the last-fired store is keyed by, so it survives a relabel.
 *
 * WHICH ACTIONS FIT WHICH MOMENT is checked here rather than left to the consumer, because the alternative is
 * a rule that saves cleanly and then quietly does nothing, the failure mode a settings screen can least
 * afford. A verdict at `turn.ending` has nothing to decide; a command at `agent.finished` has no defined place
 * in the landing pass and would be a promise this stage cannot keep. */
const MOMENT_ACTIONS: Record<RuleMoment, readonly RuleAction["kind"][]> = {
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
// When a rule last did something, keyed by rule id, read by the settings list so a rule nobody has seen fire
// in three weeks is visible as such. Kept out of the settings object on purpose: a firing is not an edit, and
// writing the owner's config on every push would make every run a settings save.
export const RuleFiringsSchema = z.record(z.string(), z.number());
export type RuleFirings = z.infer<typeof RuleFiringsSchema>;
/* WHERE A SKILL CAME FROM, the fact that decides everything else about its row.
 *
 * A skill is inert text the agent reads, and this sandbox grows them from seven directions at once: the daemon
 * writes one per baked tool and one per core feature that has a cheatsheet, connecting a tool or a machine
 * writes one for that connection, the owner writes their own, a persona carries its own in its kit, an
 * installed extension ships some inside its checkout, and a plugin capability clones a repo full of them.
 * Nothing used to LIST the result, which is the whole gap this vocabulary closes, "what does my agent know
 * right now" had no answer on screen, and a skill spends the agent's attention whether or not anyone remembers
 * adding it.
 *
 *   builtin      this image ships it, a baked tool's cheatsheet, or a core feature's
 *   own          the owner wrote it (.intentic/config/skills/), and only these are editable here
 *   capability   something connected brought it: a CLI tool, a machine, a browser account, a VPN
 *   extension    an installed extension ships it inside its checkout
 *   plugin       a plugin capability cloned a repo that holds it
 *   persona      one card's own kit carries it, and only turns wearing that card ever see it
 *   dropped      it is simply sitting in the loaded folder, put there by hand, or by the agent itself
 *
 * `persona` is the one origin that is not on for everybody, which is why it needs its own word rather than
 * being filed under `own`: it says "the agent knows this when it is wearing that card", and a list that showed
 * it as an ordinary skill of the owner's would be claiming it applies to every chat.
 *
 * `dropped` is the honest bottom of the list rather than a category anything creates on purpose: the promise
 * this surface makes is that it shows EVERYTHING the agent knows, so a file nothing else claims has to list as
 * the loose file it is instead of being quietly left out.
 *
 * Deliberately NOT a capability kind. A capability holds a credential, can be broken right now, and wants a
 * status light; a skill either exists or it does not. See _sandbox/sandbox/src/settings/skill-inventory.ts. */
export const SkillOriginSchema = z.enum(["builtin", "own", "capability", "extension", "plugin", "persona", "dropped"]);
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;
/* A skill's own name, the directory it lives in and the word the agent invokes it by. Same slug shape the SDK's
 * loader accepts, checked here so a bad name is a refused save rather than a skill that silently never loads. */
export const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a skill name is lowercase letters, digits and dashes");
export const SkillSummarySchema = z.object({
    /* The handle the read/remove routes take. An `own` or `builtin` skill IS its name (they share one directory,
     * so names there are already unique); one that belongs to something else is `<origin>:<owner>:<name>`,
     * because two plugins may each ship a `review` and the list has to be able to tell them apart. */
    id: z
        .string()
        .describe(
            "Its handle, which reading and deleting take. A skill of your own is simply its name; one belonging to something else is qualified, because two packages may each ship a review.",
        ),
    name: z.string().describe("Its name."),
    // The frontmatter line the agent routes on, empty when a shipped skill declares none, which is worth
    // showing as the blank it is rather than papering over: a skill with no description is rarely picked.
    description: z
        .string()
        .describe(
            "What it is for, which is the line the agent reads to decide whether to reach for it. Empty when the skill declares none, which is worth showing as the blank it is: a skill with no description is rarely picked.",
        ),
    origin: SkillOriginSchema.describe("Where it came from."),
    // Who ships it, as the row names it, an extension's title, a plugin capability's id, a setting's name.
    owner: z.string().optional().describe("Who ships it, as the row would name them."),
    enabled: z.boolean().describe("Whether the agent can reach it."),
    /* Whether THIS surface can switch it. True only for the skills the settings `skills` list governs (baked
     * tools and the owner's own): everything else is on because its extension, its plugin or another setting is,
     * and a switch here that silently did nothing would be worse than no switch at all, the row names its
     * owner instead. */
    switchable: z
        .boolean()
        .describe(
            "Whether this surface can switch it. Everything else is on because its extension or its plugin is, and a switch here that silently did nothing would be worse than none, so the row names its owner instead.",
        ),
    // Whether the owner may rewrite the text here. Their own skills only, a shipped one is its author's, and
    // editing it in place would be undone the next time the thing that ships it reconciles.
    editable: z
        .boolean()
        .describe(
            "Whether it can be rewritten here. Your own only: editing somebody else's in place would be undone the next time the thing that ships it catches up.",
        ),
    /* Whether it can be deleted from this surface. Wider than `editable` by exactly one case: a skill someone
     * dropped into the loaded folder is not the owner's to edit (its home is that folder, not their store) but is
     * absolutely theirs to clear out, and with no switch and no owning extension there would otherwise be no way
     * to get rid of it short of the file tree. */
    removable: z.boolean(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export const SkillsListSchema = z.array(SkillSummarySchema);
// One skill's full text, for reading it on screen. Its own route rather than a field on the summary: bodies run
// to thousands of words and a list of twenty would cost a hundred kilobytes to draw a group of one-line rows.
export const SkillBodySchema = z.object({
    id: z.string().describe("The skill's id, which can carry the owner it came from."),
    name: z.string().describe("Its name."),
    // Everything after the frontmatter, the instructions themselves, as written.
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
/* A skill the owner writes. Three fields because a skill IS three things, what it is called, when to reach for
 * it, and what to do, and the daemon assembles the frontmatter from the first two so a saved skill can never
 * be one the loader skips over. `description` is required for the reason above: it is the only part the model
 * reads before deciding whether to open the rest. */
export const SkillDraftSchema = z.object({
    name: SkillNameSchema.describe("What to call it. Saving over an existing name rewrites it, which is also how one is renamed."),
    description: z.string().min(1).max(1024).describe("What it is for, which is what the agent reads to decide whether to reach for it."),
    body: z.string().min(1).describe("The skill itself."),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;
export const SkillRemoveSchema = z.object({
    name: SkillNameSchema.describe("Which skill to delete. The text and the enabled list are both updated, so nothing is left half done."),
});
// Small user-owned config the /settings routes edit and streamAgent reads, all opt-in booleans the owner
// toggles in the UI (so each can be A/B benchmarked):
//   stableSystemPrompt, keeps the system prompt byte-stable across turns (the delegation note rides the user
//                        message instead of the preset `append`) so the provider prompt cache survives.
//   skills           , names of baked-tool skills to load into .agents/skills so the agent reaches for them
//                        (e.g. "lsp". TS rename + diagnostics over the language service); a name absent ⇒ its
//                        skill file isn't written, so the agent doesn't reach for it. Data-driven: a new baked
//                        tool is one daemon-side registry entry, not a new settings field.
//   hashlineEdits    , swaps the native Read/Edit/Write for hash-anchored edits on the Claude path (stale-file
//                        guard + fewer output tokens); off ⇒ the native file tools.
//   terseOutput      , appends a concise-response steer to the end of the system prompt (a stable suffix, so it
//                        composes with stableSystemPrompt) to cut the model's OWN output tokens.
//   systemPromptMode , which base the agent's prompt is: "intentic" (default), "claude", or "custom".
//   systemPrompt     , the owner's own prompt text, used only by "custom" mode, where it is the ENTIRE system
//                        prompt and nothing the daemon would otherwise append rides with it, see its own note.
//   iqSearch         , loads the image-baked iq Claude Code plugin (skill + SessionStart nudge) so the agent
//                        prefers the iq CLI over grep/find/Glob; off ⇒ plugin not loaded, native search tools
//                        only. Opt-in (default off); the browser Search box uses iq regardless.
//   iqSearchHoldout  , conversation-level measurement control for iqSearch (UsageTurn.iqSearchArm). The arm
//                        stays fixed because teaching already loaded into a session cannot be removed next turn.
//   workspaceMap     , computes an AREA index of the project a run starts in and prepends it to the
//                        conversation's opening message, so the turn does not have to buy its own orientation
//                        with a directory listing. Generated from the filesystem every time, never stored.
//   sidecars         , the background pass converging a markdown shadow of every binary workspace file
//                        (docx/pdf/images/audio → .intentic/local/cache/derived/) the moment it lands, via
//                        the baked fileq CLI, so reasoning-time reads are pre-derived. The CLI itself is
//                        always available; this gates only the eager watcher-driven derivation.
//   outputCleaners   , the Bash output-cleaner spec (agent-output-filter): "off" = filter disabled,
//                        "" = all cleaners on (default), else an iq-style allow-list / default-minus
//                        spec ("git,pnpm" = only those; "-cap" = all except). Threaded to the filter via env.
//   outputHoldout    , measurement control: a fraction [0,1] of Bash commands whose output bypasses cleaning
//                        (recorded raw as `heldOut`), so the savings report compares a real cleaned-vs-raw
//                        population instead of an estimate. 0 = no holdout (default).
//   rules            , the standing "at this moment, if this is true, do this" table (RuleSchema): what proves
//                        a turn's work, what runs before a push, whether finished work lands by itself. Empty
//                        (the default) means none of those happen, which is the shape a fresh sandbox has.
//   automationFailureLimit, consecutive `error` runs after which an automation is disabled rather than left
//                        firing forever; 0 (default) ⇒ never.
//   subagentsAtOnce / subagentsPerTurn / subagentDepth, the harness's own ceilings on delegation, raised or
//                        lowered from one place; each defaults to what the CLI enforces on its own.
// The booleans default off, outputCleaners defaults "" (cleaning on) and outputHoldout 0; iqSearch stays off
// until the owner enables it. `skills` is the exception and defaults to the
// baked tools worth having on: a skill file is the ONLY thing that tells the agent a baked binary exists, and
// with the list empty `lsp` went used once in 866 sessions, not declined, never learned about.
//
// Every field carries that default IN THE SCHEMA, so a settings object written before a field existed still
// parses, the absent key reads as its default. That is not a compatibility layer, it is the seam this shape
// spans: the browser ships with the platform while the daemon ships inside the user's sandbox image, so a web
// build is routinely NEWER than the daemon answering it. Requiring the key instead makes the whole settings
// surface fail to parse the moment a toggle is added, which reaches the user as a page of switches that are
// silently dead, not as an error. It also means an older on-disk manifest keeps the owner's other picks rather
// than being discarded whole.

export const SandboxSettingsSchema = z.object({
    stableSystemPrompt: z
        .boolean()
        .default(false)
        .describe(
            "Keep the instructions identical between turns so the provider can cache them, moving anything that varies into the message instead. Cheaper, at the cost of some flexibility.",
        ),
    skills: z.array(z.string()).default(["lsp", "fileq"]).describe("Which skills are switched on."),
    hashlineEdits: z
        .boolean()
        .default(false)
        .describe(
            "Have the agent edit files by line number rather than by quoting the text it wants replaced. Cheaper on large files, and less forgiving of a stale read.",
        ),
    terseOutput: z.boolean().default(false).describe("Ask the agent to say less. It changes how much it narrates, not how much it does."),
    /* Measurement control for the terse steer, at TURN level, the same trick `outputHoldout` plays over
     * commands, one layer up. A fraction [0,1] of otherwise-eligible turns run WITHOUT the steer and record
     * which arm they ran on (UsageTurn.terse), so the savings report can compare two real populations.
     *
     * It has to be an experiment: unlike a cleaned command, which yields its own raw baseline in the same
     * event, a turn cannot be re-run to see what it would have said unsteered. 0 ⇒ no measurement (every
     * eligible turn is steered), which is the default because the control costs the very tokens it measures. */
    terseHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
            "What share of turns to run without that instruction, so the two can be compared honestly. It has to be measured this way, because a turn cannot be re-run to see what it would have said. Zero means no measurement, which is the default, since the comparison costs the very tokens it is measuring.",
        ),
    /* WHICH SYSTEM PROMPT THE AGENT RUNS ON, the base, before anything this turn composes.
     *
     *   intentic. Intentic's own prompt, tuned for this harness (intentic-prompt.ts). The default.
     *   claude  . Claude Code's preset, as shipped in the CLI this sandbox runs. Not a copy stored here, so
     *              picking it tracks whatever the installed CLI's prompt is rather than freezing at a snapshot.
     *   custom  , `systemPrompt` below, and nothing else at all.
     *
     * The first two are peers: both get the harness's own guidance appended (the AskUserQuestion/plan blocks
     * the chat's cards need, the checklist guidance behind the todo panel, the browser-tool guidance), plus the
     * delegation note and the terse steer. `custom` is the one that does not, by the owner's explicit choice,
     * see the field below. */
    systemPromptMode: SystemPromptModeSchema.default("intentic").describe(
        "Which instructions the agent starts from: intentic's own, the ones the installed Claude Code carries, or your own. The first two both get this product's own guidance added on top; your own gets nothing added, which is the point of it.",
    ),
    /* The owner's own prompt, used only when `systemPromptMode` is "custom". Then it is the ENTIRE system
     * prompt: both built-in bases are gone and so is everything the daemon would otherwise append, the widget
     * guidance the chat's cards are driven by, and the terse-output steer (whose toggle goes inert). That is
     * the price of total control, and the UI states it at the moment of the edit rather than letting the
     * widgets go quietly dark. Only the cross-provider delegation note survives, because it has a home outside
     * the system prompt already (the user-message preamble stableSystemPrompt puts it in).
     *
     * Cap is roomy, the bases it stands in for are ~6.8k characters, but finite, because every turn pays it. */
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
    /* Measurement control for the iq search teaching, at CONVERSATION level. A fraction [0,1] of conversations
     * run without the plugin/instruction and stamp that stable arm on every turn. Per-turn randomization is not
     * a valid control here: once the teaching enters a provider session, withholding it from the next request
     * does not make the model forget it. 0 ⇒ no measurement and every conversation receives the teaching. */
    iqSearchHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
            "What share of conversations to run without that teaching, so the two can be compared. Whole conversations rather than individual turns, because once the teaching is in a session, withholding it from the next request does not make the model forget it.",
        ),
    /* THE MAP THE TURN OPENS WITH, which areas the project a run starts in has, one derived line on what each
     * is for, and where the run is standing among them (agent/workspace-map.ts).
     *
     * It answers the question every first turn has whatever it was asked, "what is this and where am I in
     * it", which across a hundred sessions of this workspace was being bought with a directory listing in two
     * turns out of five, and with ~5.3k tokens of tool results before the job was touched.
     *
     * ROOTED AT THE RUN'S STARTING FOLDER rather than at the workspace: a persona's start folder, an isolated
     * conversation's worktree, or wherever the turn's cwd is. It maps the project containing that folder and
     * names the rest of the workspace on one line, because a run three levels inside one project is not asking
     * about the others.
     *
     * REGENERATED, NEVER STORED, which is the whole reason it is a mechanism rather than a paragraph in the
     * system prompt or a hand-written CLAUDE.md: in the ten days that motivated it this repo's two busiest
     * top-level directories stopped existing, and every written-down copy of the layout was wrong by the end of
     * the window. Off by default, it spends its tokens on the opening message of every conversation. */
    workspaceMap: z
        .boolean()
        .default(false)
        .describe(
            "Open every conversation with a map of the project it starts in: what is in it, what each part is for, and where the agent is standing. Worked out fresh each time rather than written down anywhere, because a written layout is wrong within a fortnight. Off by default, since it spends tokens on the first message of every conversation.",
        ),
    /* THE MARKDOWN SHADOWS OF BINARY FILES, the eager half of fileq (_sandbox/fileq). The lazy half — the
     * `fileq` CLI an agent runs mid-task — is always on PATH and gated only by its skill; this switch is
     * about the BACKGROUND pass: the daemon watching /work and converging a sidecar under
     * .intentic/local/cache/derived/ for every docx/xlsx/pptx/pdf/image/audio file the moment it lands or
     * changes, so reasoning-time reads hit a shadow that already exists. Off by default like every boolean
     * here: it spends CPU unasked, on every file that lands, which is the owner's call to make. */
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
    /* The models behind the small automatic jobs that are not a conversation, today the commit message
     * written when an agent's work lands. An ORDERED list of `${provider}:${modelId}`, tried top to bottom, or
     * EMPTY for Auto.
     *
     * A LIST rather than a pick, because the single interesting failure of this feature is a model that is
     * connected and simply will not answer today: the account's allowance went on the chat, and one spent
     * provider then takes the job down for hours while the others sit idle. Written in order, the daemon steps
     * over the spent one and the message still gets written (agent/quick-model.ts walks it).
     *
     * Empty is the default and still the interesting case: Auto is resolved from whatever accounts are
     * connected at the moment it is read (resolveQuickModels), so it can never name a provider this sandbox has
     * no credential for, it improves by itself when one is added, and it is a ladder too, the cheapest rung of
     * every connected provider, best first. Storing resolved ids here instead would go stale exactly like a
     * pinned model does. */
    quickModel: z
        .array(z.string())
        .max(10)
        .default([])
        .describe(
            "Which models do the small automatic jobs that are not a conversation, such as writing a commit message. A list rather than one pick, tried in order, because the interesting failure is a model that is connected and simply will not answer today. Empty means work it out from whatever is connected, which improves by itself as accounts are added.",
        ),
    /* WHICH REPOS KEEP A CHANGELOG, the repos whose commits carry a `Release-Note:` trailer, written by the
     * same quick model that drafts the subject (git/commit-message.ts) and harvested at release time.
     *
     * A LIST OF REPOS RATHER THAN A FLAG, and EMPTY BY DEFAULT, because this daemon runs on the user's repos
     * rather than on ours. The commit drafter's one standing rule is that house style is INFERRED, never
     * prescribed, it reads the last handful of subjects and matches them, so a repo that spells its commits
     * some other way is never argued with. A note trailer is the one thing that cannot be inferred that way: a
     * repo which has never written one gives the model nothing to copy, so asking for it has to be somebody's
     * explicit decision. Empty means every repo behaves exactly as it did before this existed.
     *
     * Named by repo id ("root", or the root-relative dir discoverRepos reports), because a workspace holds
     * several repos and a commit can span them: the trailer is written when the commit touches a repo that
     * asked for one, and a repo that did not ask never gets a line it has to explain to its reviewers. */
    changelogRepos: z
        .array(z.string())
        .max(50)
        .default([])
        .describe(
            "Which repositories keep a changelog, and so get a user-facing note written alongside each merge. A list rather than a switch, and empty by default, because the commit writer's standing rule is to copy the house style rather than impose one, and a repository that has never written such a note gives it nothing to copy.",
        ),
    /* WHAT AN AGENT RUN OPENS ON, the tier above quickModel, and the answer for every turn a SURFACE starts
     * rather than a person at a composer: Fix with agent on a pipeline or a deployment, a Maintenance chore, a
     * Documentation or Acceptance run, the fix a failed pre-push check proposes. An ORDERED list of
     * `${provider}:${model}` (quickModelKey) plus the reasoning effort beside it; EMPTY ⇒ whatever the chat
     * composer would have started with, which is the honest floor because it is the model the user already
     * chose to work with.
     *
     * A LIST, for the reason quickModel is one: the account at the head runs out, and every surface-started run
     * in the sandbox then fails on a credential the user cannot see from the row they pressed. Written in order,
     * the next one down catches it (turn-resume.ts walks it).
     *
     * PINNED, NOT DERIVED, the deliberate difference from quickModel one line above, and the reason these are
     * two settings rather than one. A quick helper exists to stay OFF the frontier tier, so cheapest-connected
     * is the right automatic answer and an empty list resolves to Auto. An agent run has to read a failing
     * suite, or a container log, or a story, and repair the thing: the tier is a judgement about how much the
     * job is worth, nothing here can make it, and a wrong guess is billed in whole sessions rather than in
     * tokens. So an empty list here resolves to NOTHING and the composer's own pick answers instead.
     *
     * The daemon applies this to any turn flagged `unattended` that names no model of its own, one rule, so a
     * surface added tomorrow inherits it by saying what it is instead of re-deriving where models come from. A
     * surface MAY still name one (the shared run button's caret, Acceptance's per-run pick), and that wins. */
    agentRunModels: z
        .array(z.string())
        .max(10)
        .default([])
        .describe(
            "Which models run the work a screen starts rather than a person: fixing a red pipeline, a maintenance chore, an acceptance run. Tried in order, so one spent account does not take every such run down. Empty falls back to whatever the chat would have used, which is the honest floor because it is the model you already chose to work with.",
        ),
    agentRunEffort: z.string().default("").describe("How hard those runs should think."),
    /* AUTOMATIC TIER SELECTION: may the daemon run an easy-looking turn on a cheaper rung of the provider the
     * user is already on, instead of on the model they picked?
     *
     * THREE STATES RATHER THAN A TOGGLE, because the middle one is the only honest way to reach the third.
     * Nobody, this repo included, can name a sensible cutoff for "easy enough" without traffic to fit it
     * against, and a routing threshold guessed in advance is how a cost feature quietly becomes a quality
     * regression. So:
     *   off     — the judge never runs. Nothing is scored, nothing is recorded, turns run on the user's pick.
     *   shadow  — the judge runs and its verdict is written to the spend ledger beside what the turn actually
     *             cost, and NOTHING IS ROUTED. This is the default: it spends no tokens, changes no behaviour,
     *             and is the only thing that can turn the weights in prompt-complexity.ts from a hypothesis
     *             into a measurement.
     *   on      — a turn judged fast runs on the cheap rung (fast-tier.ts), when the provider publishes one.
     *
     * IT CAN ONLY EVER ROUTE DOWN. There is no "which model is the standard tier" setting because the standard
     * tier is the model the user already chose, so the worst case of a wrong verdict is one turn's quality on a
     * model they can see on the card and correct, never a bill they did not ask for. That asymmetry is why this
     * can default to shadow rather than to off: shadow costs nothing and `on` cannot overspend. */
    autoTier: z
        .enum(["off", "shadow", "on"])
        .default("shadow")
        .describe(
            "Whether an easy-looking turn may run on a cheaper model from the same provider. Three states rather than a switch, because the middle one is the only honest road to the third: it scores every turn and routes nothing, so the guess can become a measurement before it changes anything. It can only ever route down, so the worst case is one turn's quality rather than a bill nobody asked for.",
        ),
    /* HOW EAGER THE JUDGE IS, the one dial this feature exposes and the answer to what the Measure mode is for:
     * the numbers say how many turns were called simple, and this is the control that acts on them.
     *
     * Three named stops rather than a number, because the number means nothing to anyone who has not read the
     * weights, while "only the unmistakable" / "the default" / "an easy question about real code too" are three
     * sentences an owner can actually hold an opinion about (FAST_CEILINGS spells out each). It moves the
     * cutoff and nothing else: the rule that a downgrade needs something POSITIVE to have been said holds at
     * every stop, so no setting of this can start downgrading short vague requests.
     *
     * `balanced` is the default and is what every verdict recorded before this existed was judged against, so
     * the shadow history stays comparable across the change rather than silently becoming two populations. */
    autoTierEagerness: z
        .enum(["cautious", "balanced", "eager"])
        .default("balanced")
        .describe(
            "How readily a turn counts as simple enough for the cheaper model. It moves only the cutoff: at every setting a turn still has to say something positively easy, so nothing here can downgrade a short vague request.",
        ),
    /* WHICH CHEAP MODEL A DOWNGRADED TURN LANDS ON, an ordered list of `${provider}:${model}` keys
     * (quickModelKey), or EMPTY for Auto.
     *
     * Empty is the default and the interesting case, exactly as quickModel's is: Auto is the cheapest row the
     * turn's own provider publishes, read through the same cheap-end order (compareCheapestFirst), so the two
     * features can never disagree about which rung is the cheap one, and connecting an account tomorrow
     * improves the answer by itself.
     *
     * A LIST, so a sandbox working across several providers can name the rung it wants on each. But unlike the
     * two lists above this one is NOT a failure ladder: entries naming a provider other than the turn's own are
     * dropped rather than tried, because switching provider retires the conversation's session (turnRequest.ts
     * `resumes`), and starting the conversation over to save a fraction of a cent is not a saving. The first
     * entry that names this provider AND is genuinely cheaper than the pick wins; if none does, Auto answers. */
    autoFastModels: z
        .array(z.string())
        .max(10)
        .default([])
        .describe(
            "Which cheaper model a downgraded turn lands on. A list so a sandbox spanning providers can name a rung on each, but not a fallback ladder: an entry naming a different provider than the turn is on is skipped rather than tried, because switching provider retires the conversation and starting over to save a fraction of a penny is not a saving. Empty picks the cheapest the turn's own provider publishes.",
        ),
    // How long a finished agent stays on the board before it is archived automatically (days; 0 ⇒ never).
    // Unlike every other flag here this one defaults ON, because the lane it governs is the board's only
    // terminal state: without a sweep the Finished lane grows for the life of the sandbox, and each card it
    // holds is a live worktree checkout, not just a row.
    agentRetentionDays: z
        .number()
        .min(0)
        .max(365)
        .default(3)
        .describe(
            "How many days a finished conversation stays on the board before being put away. Zero means never. The one setting here that defaults on, because each card left behind is a real working copy on disk, not just a row.",
        ),
    /* THE SANDBOX-WIDE DEFAULT for "when a turn dies because the MODEL PROVIDER was failing (500/502/503, a
     * 529 at capacity, a dropped socket), re-run it on an escalating backoff until it goes through or the
     * attempts are spent".
     *
     * A DEFAULT, not the whole answer: any one conversation may override it (AgentSummarySchema
     * .resumeAfterOutage), and the chat's own offer at the moment of failure writes THAT rather than this.
     * This toggle is the standing policy for every agent that has not said otherwise, which is why it lives in
     * settings and is not reachable by a single press from inside one chat, flipping how the whole board
     * behaves should be a thing somebody went to do.
     *
     * OFF by default, on the same reasoning that keeps a spent usage limit out of this pair entirely: a resume
     * re-runs a turn the user sent once, on their own allowance, and only they can say whether the turn was
     * worth paying for twice. Starting off costs nothing, because the failed turn is remembered whatever the
     * toggle says (recordOutageFailure), the failure frame reports an "available" resume and the chat's offer
     * arms that very turn the moment it is armed for that conversation. Worth turning ON for a sandbox whose
     * turns mostly have nobody in the room (automation wakes, Discord, webhooks), which is the case no browser
     * could rescue and the case a per-conversation press cannot reach. */
    resumeAfterOutage: z
        .boolean()
        .default(false)
        .describe(
            "Whether a turn killed by the model provider failing is re-run automatically, backing off between attempts. The sandbox-wide default; any one conversation can say otherwise. Off to begin with, because a retry spends your allowance on a turn you sent once and only you can say whether it was worth paying for twice. Worth turning on for a sandbox whose work mostly happens with nobody in the room.",
        ),
    /* When the daemon dies under a running turn, re-run that turn once it is back (agent/turn-journal.ts records
     * every in-flight turn; the boot pass in agent/turn-resume.ts re-runs what survived). OFF by default, like
     * the outage resume above and for the same reason: a boot that re-runs turns spends the user's allowance on
     * work they are not watching, and edits the workspace while they are still waiting for the sandbox to come
     * back. Worth turning on for the case it was built for, the container is recreated on every update, every
     * environment approval and every dev-sandbox.sh swap, so approving the Dockerfile change an agent asked for
     * otherwise costs the run that asked for it.
     *
     * OFF still records the interruption: the fleet card reads `interrupted` (see AgentStatusSchema) and an
     * automation's row shows an `interrupted` run, nothing is re-run, but nothing is silently lost either. */
    autoResumeOnRestart: z
        .boolean()
        .default(false)
        .describe(
            "Whether a turn killed by the sandbox restarting is re-run once it comes back. Off to begin with, for the same reason: it would spend your allowance on work you are not watching and edit files while you are still waiting for the sandbox to return. Either way the interruption is recorded rather than silently lost.",
        ),
    /* THE RULE TABLE, every standing instruction the owner gives the sandbox about its own work: ask for
     * proof before a turn ends, run a command before a push, hold or release finished work, and whatever they
     * add next. See RuleSchema for the shape and for why the four action kinds are four.
     *
     * EMPTY IS THE DEFAULT, and it is exactly the behaviour a fresh sandbox had when these were three separate
     * flags: no proof is asked for, no command runs at a push, and finished work waits on its branch. That is
     * not a coincidence to preserve by hand, each of those defaults is what "no rule matched" means at its
     * moment, so the empty table IS the old default rather than a reconstruction of it.
     *
     * Rules live here, in the owner's own settings, rather than in the workspace: a rule can hold work back and
     * gate a push, so the first version answers to the person whose sandbox it is and to nobody else. Repo-
     * committed and extension-contributed rules are worth having and are deliberately not here yet, they need
     * the question of what a rule from somewhere else may WIDEN answered first. */
    rules: z
        .array(RuleSchema)
        .max(50)
        .default([])
        .describe(
            "Standing instructions you give the sandbox about its own work: ask for proof before a turn ends, run something before a push, hold or release finished work. Empty is the default and is exactly the behaviour of a fresh sandbox, because each of those defaults is what no rule matched means at its own moment.",
        ),
    /* STOP AN AUTOMATION THAT ONLY EVER FAILS. After this many consecutive `error` runs the scheduler disables
     * it and says so on the row, instead of firing a job that has proven it cannot succeed every minute until
     * someone notices. 0 ⇒ never, which is the default.
     *
     * Off by default because quarantining edits the USER'S OWN configuration, and the failure it reacts to is
     * not always the automation's fault: an hourly poll against an API having a bad afternoon is broken for
     * three fires and fine on the fourth, and a job disabled at 3 a.m. is one nobody re-enables until they
     * notice it stopped. So the mechanism exists for the case it is unambiguously right for, a misconfigured
     * job burning a turn's worth of tokens on every tick, and the owner is the one who decides their
     * automations are the kind that should be stopped rather than retried.
     *
     * Only `error` counts. A `skipped` run is a guard doing its job, and an `interrupted` one means the daemon
     * died mid-fire, which says nothing about the automation, counting either would quarantine healthy jobs. */
    automationFailureLimit: z
        .number()
        .min(0)
        .max(20)
        .default(0)
        .describe(
            "How many failures in a row before an automation switches itself off. Zero means never, which is the default, because the failure is not always the automation's fault and a job disabled at three in the morning is one nobody re-enables. Only real errors count: a guard deciding there was nothing to do, or the sandbox dying mid-run, say nothing about the automation.",
        ),
    /* WHO MAY START A SESSION WITHOUT YOU, the admission floor, per wake source (see AdmissionPolicySchema).
     * Defaults all-allow, so a fresh sandbox behaves exactly as before the floor existed and the per-automation
     * `requireApproval` stays the way most owners meet holds. */
    admission: AdmissionPolicySchema.prefault({}).describe(
        "Whether work started from outside may run, per kind of trigger: let it, hold it for approval, or refuse it. Composes with each automation's own setting, and the stricter of the two wins, so holding every visitor's message needs no edit to each automation.",
    ),
    /* THE SNIFFER'S RULEBOOK, verdicts for in-turn actions the outbound gate classifies, keyed by
     * `<provider>.<type>` ("discord.message.send") with `<provider>.*` as the per-provider wildcard; exact key
     * wins. An action with no rule is allowed, the empty default wires no hook at all, so an unconfigured
     * workspace pays nothing. "hold" cannot park a running turn (nobody may be there to answer); it refuses the
     * live call and points the agent at the drafts outbox, which IS the held form of a send.
     *
     * The CHILD-AGENT surface reads the same book: `agents.spawn` covers starting, steering and answering
     * child agents on every provider, `agents.spawn.<provider>` singles one out (the specific key wins), and
     * the daemon's own taint floor holds a spawn from a turn that has taken in outside content unless the
     * owner wrote an explicit allow (guard/actions.ts childSpawn). "hold" refuses with the owner named, the
     * same translation a send gets. */
    actionRules: z
        .record(z.string(), AdmissionRuleSchema)
        .default({})
        .describe("What an agent may do out in the world, per kind of action: go ahead, ask first, or never."),
    /* THE COMMAND GATE'S RULEBOOK, a verdict per CommandClass, for shell commands the agent runs itself. This
     * is the layer that still applies once a session is already running: the admission floor above decides who
     * may wake the agent, and after that every command it types is inside one already-admitted session.
     *
     * "hold" means what it says here, unlike in actionRules: the gate raises a permission card and the command
     * waits for a real answer, in EVERY posture, hooks fire under bypassPermissions, where the card machinery
     * on its own never would. An UNATTENDED turn has nobody to answer, so a hold there refuses instead and says
     * why; that is the honest form of "ask me" when there is no me.
     *
     * An unlisted class is allowed, WITH ONE FLOOR UNDER IT: the classes nothing brings back (FLOOR_CLASSES in
     * command-classes.ts, `system.destructive` today) are held where the owner wrote nothing, so a workspace
     * that has never opened this page is not one mistyped path away from a formatted disk. An explicit `allow`
     * still wins, it is a decision about that exact class and the floor must not override the person who made
     * it. Everything else stays as it was: unlisted is allowed and ordinary work is never asked about.
     *
     * Keys are the CommandClass enum, so a typo is a settings error rather than a rule that silently never
     * matches. */
    commandRules: z
        .partialRecord(CommandClassSchema, AdmissionRuleSchema)
        .default({})
        .describe(
            "What an agent may run inside the sandbox, for the six kinds of command that are hard to take back: rewriting git history, deleting recursively, wiping a disk or a container volume, reading credential files, publishing a package, reaching out to the network. Everything else is recoverable in a container that is itself disposable, and gating it would be friction bought with nothing. Leaving a kind unset is not the same as allowing it: wiping a disk is held for your approval until you say otherwise, because nothing here brings that back.",
        ),
    /* HOW MUCH AN AGENT MAY DELEGATE, the three ceilings the Claude Code harness enforces on its own Agent
     * tool, surfaced here because their defaults are tuned for a laptop and this is a container the owner sized.
     *
     * They are three settings rather than one because they stop different things, and a fan-out that clears one
     * lands on the next: `subagentsAtOnce` is the parallel width of a single fan-out, `subagentsPerTurn` is the
     * lifetime budget of one conversation, and `subagentDepth` is how far a child may itself delegate. Raising
     * the width alone is what makes a wide sweep hit the lifetime cap two rounds later, which reads to the user
     * as the same wall in a new place.
     *
     * Each default is what the CLI does with no env set, so a sandbox that has never opened this group behaves
     * exactly as it always did, these are not our numbers, they are the harness's, restated so they can move.
     * The ceilings are ours: an agent is told to stop and NOT retry when it hits one, so the cost of a number
     * set too high is a real fleet of models running at once, and the cost of one set too low is a wall.
     *
     * The refusal an agent sees names the env var (`ask them to raise CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`),
     * which is why these three exist as settings at all: without them the only answer to that ask is editing
     * the container's environment and restarting the daemon. */
    subagentsAtOnce: z.number().min(1).max(200).default(20).describe("How many helper agents may work at the same time."),
    subagentsPerTurn: z.number().min(1).max(2000).default(200).describe("How many a single turn may start in total."),
    // Depth 1 = an agent may delegate, but its children may not. The CLI's own default is 3, and it is the one
    // of the three whose runaway case is unbounded rather than merely wide, each level multiplies the last.
    subagentDepth: z
        .number()
        .min(1)
        .max(10)
        .default(3)
        .describe("How many levels deep the delegation may go, since a helper can start helpers of its own."),
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
 *   input , shell output the cleaners trimmed before the model ever saw it. Both sides of the comparison come
 *            off the SAME command (raw in, emitted out), so the counterfactual is observed rather than
 *            estimated: exact, per command, no sample size to argue about.
 *   output, the model's own tokens under the terse steer. There is no second run of the same turn to compare
 *            against, so the only honest number is an experiment: a turn-level holdout, an n per arm, and a
 *            margin. It is absent entirely until both arms are large enough for the delta to mean anything.
 *
 * The two are also in different units of value, a saved tool-output token is saved again on every later
 * request of that conversation, an output token is saved once but costs several times as much, which is the
 * other reason they are separate sections with separate totals rather than one number.
 */

// One mechanism's realized saving, biggest first. `savedTokens` is what THIS stage removed from what reached
// it in pipeline order, sequential attribution, which is why the stages sum exactly to raw − emitted and can
// be drawn as one stacked bar. It is NOT "what turning this cleaner off would cost you": the cap downstream
// would have eaten some of the same lines. `commands` is how many commands the stage ran on. Negative for the
// `footer` stage, which adds the retrieval pointer back, a cost on the same ledger as what it bought.
export const SavingsStageSchema = z.object({ id: z.string(), commands: z.number(), savedTokens: z.number() });
// What the cleaners saved on the way in, aggregated from historyRoot/logs/filter-stats.jsonl, one row per
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
    // The measured control, commands the holdout left raw, against the cleaned population. A real saved-%
    // for the pipeline as a whole rather than an estimate, and the only whole-pipeline counterfactual there is.
    holdout: z.object({ cleaned: z.number(), heldOut: z.number(), measuredSavedPct: z.number().optional() }),
    /* High-volume commands that matched no cleaner: where the next handler is worth writing. GROUPED by the
     * command text, `commands` is how many times it ran and `tokens` their total, because the question this
     * list is read for is "what is worth a handler", and a handler is worth writing for a command that costs
     * 5k twenty times over, not for the single 60k outlier that happened to sort first. */
    gaps: z.array(z.object({ command: z.string(), commands: z.number(), tokens: z.number() })),
});
export type InputSavings = z.infer<typeof InputSavingsSchema>;
// One arm of a turn-level experiment: the turns that ran with the mechanism, and the turns the holdout ran
// without it. A mean PER TURN, because the arms never hold the same number of turns.
export const SavingsArmSchema = z.object({ turns: z.number(), mean: z.number() });
/* ONE METRIC'S READING of a turn-level experiment: the two arms, and whatever the arithmetic over them will
 * stand behind. An experiment can carry several, see TurnExperimentSchema.
 *
 * `metric` says what `mean` counts and what `deltaPct` is a delta in, and choosing it is most of the work.
 *   proseChars     , the terse steer: the thing it steers, and the only part of the model's output that
 *                     responds to being asked to be brief (UsageTurn.proseChars has why output tokens cannot).
 *   searchCalls    , the search teaching: the searches a turn ran, which the teaching directly changes.
 *   openingSearches, the same, narrower: the searches before the turn first touched a file.
 * Search mechanisms must not be judged on COST. Cost is a whole turn's work, a search mechanism moves one part
 * of it, and the part sits inside the noise of the rest exactly as the steer's effect once sat inside its
 * tool-call arguments. */
export const TurnMetricReadingSchema = z.object({
    metric: z.enum(["proseChars", "searchCalls", "openingSearches"]),
    on: SavingsArmSchema,
    off: SavingsArmSchema,
    /* HOW MUCH LONGER, when the margin spans zero and the honest answer is "keep collecting": the additional
     * CONTROL turns at which the resolution would reach a width worth acting on (turn-experiments.ts sets it),
     * holding the spread where it sits today.
     *
     * It is aimed at a FIXED resolution rather than at today's delta on purpose. Sized against the observed
     * effect it reported fourteen more turns for an experiment that had gone nine days without resolving, an
     * estimate divided by noise inherits the noise and promises an answer next week indefinitely. Against a
     * fixed target the same ledger asks for a few hundred, which is the fact the reader needs: this holdout is
     * not close, and waiting is not the move.
     *
     * An order-of-magnitude figure, and it reads as one, the point is telling "a few more days" apart from
     * "not at this holdout", which is a decision, where "measuring…" forever is not.
     *
     * Absent ⇒ nothing to wait for: the arms are under `minTurns`, the delta is published, or the resolution is
     * already good enough and the effect is simply smaller than it. */
    controlTurnsNeeded: z.number().optional(),
    /* THE RESOLUTION, present as soon as both arms clear `minTurns`: ± percentage points at 95% (Welch,
     * unequal variances and unequal arms). Present even when the delta below is withheld, because "whatever
     * this mechanism does, it is smaller than ±35 points" is a true and useful thing to be told, it is the
     * reading that says to keep collecting rather than to act. */
    marginPct: z.number().optional(),
    /* THE CLAIM, present only once there is one. Both together, and only when the margin does NOT span zero.
     *
     * A schema that can't express a half-measured experiment is how a 34%-that-becomes-8%-tomorrow never
     * reaches the screen, and clearing `minTurns` turned out not to be enough to buy that. The terse steer
     * crossed its thirtieth control turn and immediately reported +31.2% ± 35.1pp: a confidence interval
     * running from −3.4% to +66.7%, which is to say no effect was measured at all, rendered as an alarming
     * number pointing the wrong way. Thirty turns is where the normal approximation starts to hold, not where
     * this much per-turn spread resolves an effect; requiring the interval to exclude zero is the same
     * withhold-until-it-means-something rule applied to the thing that actually decides whether it does.
     *   deltaPct, change in the metric's mean per turn under the mechanism; negative is a saving.
     *   saved   , what the delta is worth over the turns that actually ran with it, in this window, in the
     *              metric's own unit (characters, or searches). */
    deltaPct: z.number().optional(),
    saved: z.number().optional(),
});
export type TurnMetricReading = z.infer<typeof TurnMetricReadingSchema>;
/* A turn-level A/B, the one shape both of this sandbox's turn experiments report in, because they differ in
 * nothing but which flag flips and what the turns are judged on. Only turns the mechanism was ELIGIBLE for are
 * counted: a turn under a custom system prompt drops the terse steer along with everything else the daemon
 * appends, so it belongs to neither arm.
 *
 * ONE COIN FLIP, SEVERAL READINGS. `metrics` is a list because the search teaching is judged on two, the
 * searches a turn ran, and the ones it ran before touching a file, and they are two readings of the SAME
 * experiment, not two experiments. Splitting them into separate entries would duplicate the arm assignment and
 * let a screen show a turn count on one that disagrees with the other. Headline first: the screens read
 * `metrics[0]` for the big number and the rest as supporting lines. */
export const TurnExperimentSchema = z.object({
    // A head and a tail rather than a plain array, because an experiment judged on nothing is not an experiment:
    // the screens take the first reading for their headline and stack the rest under it, and this is what makes
    // "there is always a headline" a fact the type carries instead of a check every screen repeats. (`.nonempty()`
    // would not do it, in zod 4 it adds a min-length rule and leaves the inferred type a plain array.)
    metrics: z.tuple([TurnMetricReadingSchema], TurnMetricReadingSchema),
    // Turns per arm before a delta is reported at all. Carried on the wire so the screen's "measuring…" state
    // counts toward the daemon's real threshold instead of a number the browser guessed. Shared by every
    // reading: they are the same turns counted differently, so they clear it together.
    minTurns: z.number(),
    // The randomized unit behind the arm counts. Turn mechanisms default to turns; teaching loaded into a
    // provider session randomizes and analyzes whole conversations so repeated turns are not false replicas.
    sampleUnit: z.enum(["turns", "conversations"]).optional(),
    // Content-addressed treatment version. Present where mixing rows from two instruction revisions would turn
    // one experiment into two unnamed ones; the reader filters to this (latest) cohort.
    cohort: z.string().optional(),
});
export type TurnExperiment = z.infer<typeof TurnExperimentSchema>;
// `output`/`search` are absent when that experiment isn't running at all (its flag off, or no holdout set), a
// section that isn't there reads as "not measured", which is the truth, while zeros would read as "measured,
// worth nothing".
/* WHAT THE COMPLEXITY JUDGE HAS BEEN SAYING, read back off the spend ledger's tier fields (UsageTurn.tierScore
 * and friends) over the requested window. The three numbers docs/model-routing-design.md §4 says the feature
 * cannot be defended without, plus the veto count, and nothing else: no counterfactual "you would have saved
 * $X", because the ledger holds what turns COST, not what they would have cost on a model they never ran.
 *
 * NOT a TurnExperiment, deliberately. The experiments compare two randomized arms of one population; this is a
 * tally of what one mechanism observed and did. Dressing it in arms and margins would claim a control group that
 * does not exist (routing follows the settings mode, which follows time, not a coin flip).
 *
 * The whole section is absent when no turn in the window was judged at all (autoTier "off" throughout), which a
 * screen renders as absence: "not measured" is the truth, zeros would read as "measured, found nothing". */
export const TierReportSchema = z.object({
    // Turns the judge ran on in the window, the denominator under everything below.
    judged: z.number(),
    // …of which landed at or below FAST_CEILING: the turns that looked simple. fast ÷ judged is the fast share.
    fast: z.number(),
    /* What the fast-judged turns that STAYED on the user's pick actually cost, the money measure mode is
     * pointing at. An upper bound on any saving, never an estimate of one: moving those turns to the cheap rung
     * would have cost something too, and this schema refuses to guess how much. */
    atStakeUsd: z.number(),
    // Turns that actually ran the cheap rung, and what they cost there. Realized, not projected.
    routed: z.number(),
    routedUsd: z.number(),
    /* THE GUARDRAIL: fast-judged turns whose conversation's very next ledger row asked for a dearer model, the
     * user reaching for the model picker right after a turn the judge called simple. The strongest negative
     * signal the ledger can carry (§4's first calibration row). Past a few percent of `fast`, the judge is
     * costing more in retries and trust than it saves in tokens. */
    escalated: z.number(),
    // Fast-judged turns the user vetoed outright (UsageTurn.tierDenied): the same signal, said even louder.
    denied: z.number(),
});
export type TierReport = z.infer<typeof TierReportSchema>;
export const SavingsReportSchema = z.object({
    input: InputSavingsSchema,
    output: TurnExperimentSchema.optional(),
    search: TurnExperimentSchema.optional(),
    // Automatic tier selection's readout, see TierReportSchema. Absent ⇒ nothing was judged in the window.
    tier: TierReportSchema.optional(),
});
export type SavingsReport = z.infer<typeof SavingsReportSchema>;
