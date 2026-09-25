import { type AgentTurn, type Capability, profileOf, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { browserFields } from "../../../browser/tools/browser-fields.js";
import type { Services } from "../../../composition.js";
import { withSettingsHookGate } from "./settings-hook-gate.js";
import { type TurnPersona, turnPersona } from "../../../personas/personas.js";
import { standing } from "../../../rules/rules.js";
import { offloadRunEnabled } from "../../../offload/offload-prefix.js";
import { armPlan, type TurnArmPlan, type TurnContext } from "../../providers/adapter.js";
import type { TurnPolicy, TurnSpec, TurnTools } from "../../providers/agent-request.js";
import { isUnknownSlashCommand } from "../../providers/agent-commands.js";
import {
    type HarnessCredentialDeps,
    type HarnessCredentials,
    harnessCredentialOf,
    resolveHarnessCredentials,
} from "../../providers/harness-credentials.js";
import { withAttachmentNote } from "../../prompt/attachment-note.js";
import { LITERAL_SLASH_NOTE } from "../../prompt/turn-preamble.js";
import { releasingMounts } from "../../tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../tools/turn-tools.js";
import { opt } from "../../../opt.js";
import { agentMounts } from "./agent-mounts.js";
import { harnessHooks, type HarnessHooksDeps } from "./harness-hooks.js";
import { harnessAccounts, harnessServers, type HarnessServersDeps, turnSecretAccess } from "./harness-servers.js";

// The Claude Code loop's own arm: the request no single provider owns, built for native Claude and every provider routed
// through the harness. Everything it reads of the daemon is named in HarnessPlanDeps; the planner never imports it.

// What the harness arm reads of the daemon, so the adapter that owns it can declare no more than this.
export type HarnessPlanDeps = HarnessCredentialDeps &
    HarnessHooksDeps &
    HarnessServersDeps &
    TurnToolsDeps &
    Pick<Services, "agent" | "capabilities" | "files" | "heavyCommands" | "hostReach" | "perf" | "sandboxSettings" | "webextReach">;

// The schema's own defaults, so an untouched setting can be told from one the owner set to the same value; not restated
// here to avoid a second, driftable copy.
const SETTINGS_DEFAULTS = SandboxSettingsSchema.parse({});

// Credential resolution, the settings read and the safety policy, run together rather than chained, so a turn later
// refused for its credential doesn't also pay for an unused settings read first.
const harnessReads = (deps: HarnessPlanDeps, input: AgentTurn, context: TurnContext) =>
    Promise.all([
        deps.perf.track("turn.plan.credentials", { provider: input.agent ?? "claude" }, () =>
            resolveHarnessCredentials(deps, { agent: input.agent, ...opt("account", input.account), ...opt("model", input.model) }),
        ),
        // Per-sandbox agent toggles; stableSystemPrompt keeps the preset prompt byte-stable so the provider prompt cache
        // survives the turn.
        context.settings === undefined
            ? deps.perf.track("turn.plan.settings", {}, () => deps.sandboxSettings.get())
            : Promise.resolve(context.settings),
        // Read once here and carried on the request, so a turn is judged against one snapshot rather than three versions of
        // a policy someone is mid-edit on.
        deps.safetyPolicy.text(),
    ]);

// The last planning I/O, run together rather than chained: the plugin dirs the Skills list also derives from, and the
// turn's MCP mounts (the browsers filtered to this persona's accounts, each call bound to its account's persisted profile).
const harnessMounts = (deps: HarnessPlanDeps, input: AgentTurn, granted: readonly Capability[], persona: TurnPersona, iqLoaded: boolean) =>
    Promise.all([
        deps.perf.track("turn.plan.extensions", {}, () =>
            agentMounts(deps, { iqLoaded, capabilities: granted, personas: persona.persona === undefined ? [] : [persona.persona] }),
        ),
        deps.perf.track("turn.plan.mounts", {}, () =>
            turnToolsOf(deps, granted, { conversationId: input.conversationId, anonymousBrowser: persona.powers.browser }),
        ),
    ]);

// The user's message with the attachment note folded in. A leading `/` naming no real command would otherwise be
// silently discarded by the CLI, so a note keeps the user's words in front of the model, last so `/` still leads.
const wordsOf = (input: AgentTurn, context: TurnContext): Pick<TurnSpec, "prompt" | "notes"> => {
    const { prompt: typed, notes } = context.base.spec;
    const prompt = context.attachmentPaths.length > 0 ? withAttachmentNote(typed, [...context.attachmentPaths]) : typed;
    const literalSlash = isUnknownSlashCommand(input.agent ?? "claude", prompt);
    return { prompt, ...opt("notes", literalSlash ? [...(notes ?? []), LITERAL_SLASH_NOTE] : notes) };
};

// A routed turn pins the endpoint's mapped model; a native Claude turn may go fast, and falls back to the daemon-wide
// default model when the turn pinned none. The harness refuses fast mode on a non-first-party endpoint.
const modelOf = (
    credentials: HarnessCredentials,
    input: AgentTurn,
    fast: boolean | undefined,
    defaultModel: string,
): Pick<TurnSpec, "model" | "fast"> =>
    credentials.endpoint !== undefined
        ? { model: credentials.endpoint.model }
        : { ...(input.model === undefined && defaultModel !== "" ? { model: defaultModel } : {}), ...(fast === true ? { fast } : {}) };

const harnessSpec = (deps: HarnessPlanDeps, input: AgentTurn, context: TurnContext, credentials: HarnessCredentials): TurnSpec => {
    // Split off since the field's absence, not `fast: undefined`, is the meaning; modelOf puts it back where it applies.
    const { fast, ...spec } = context.base.spec;
    return {
        ...spec,
        ...wordsOf(input, context),
        ...modelOf(credentials, input, fast, deps.config.intenticAgentModel),
        ...opt("thinking", input.thinking),
        // Mid-turn steering (the /agent/steer queue streamAgent registered); Claude Code harness only.
        ...opt("steering", context.steering),
    };
};

// Forwarded only where the owner actually moved a cap: an untouched one is left for the harness to answer, since the
// nesting cap's real default is remote-config'd inside the CLI and restating today's value would pin it.
const delegationCaps = (settings: SandboxSettings): Pick<TurnPolicy, "subagentsAtOnce" | "subagentsPerTurn" | "subagentDepth"> => ({
    ...(settings.subagentsAtOnce !== SETTINGS_DEFAULTS.subagentsAtOnce ? { subagentsAtOnce: settings.subagentsAtOnce } : {}),
    ...(settings.subagentsPerTurn !== SETTINGS_DEFAULTS.subagentsPerTurn ? { subagentsPerTurn: settings.subagentsPerTurn } : {}),
    ...(settings.subagentDepth !== SETTINGS_DEFAULTS.subagentDepth ? { subagentDepth: settings.subagentDepth } : {}),
});

const harnessPolicy = (
    base: TurnPolicy,
    input: AgentTurn,
    settings: SandboxSettings,
    safetyPolicy: string,
): TurnPolicy => ({
    ...base,
    // hashlineEdits owns file mutation via its own MCP server, so native Edit/Write are dropped (Read stays, for viewing
    // images/PDFs).
    ...(settings.hashlineEdits ? { disallowedTools: ["Edit", "Write"] } : {}),
    ...delegationCaps(settings),
    // The sniffer's rulebook, forwarded only when the owner wrote a rule, the same no-hook economy as above.
    ...(Object.keys(settings.actionRules).length > 0 ? { actionRules: settings.actionRules } : {}),
    // Wired unconditionally, unlike the sniffer's rulebook: triage and the hard rule are facts about the command.
    safetyPolicy,
    judging: settings.commandJudge,
    // Whether outside content caused this turn, the same distinction the admission floor draws, read for the taint.
    ...opt("outsideWake", input.outsideWake),
});

// The Bash pipeline's filters and heavy table: the output-cleaner spec (empty lets the filter's own default apply), the
// holdout fraction, and the heavy-command table, always: a heavy program keeps its class where nothing queues it
// (agent-terminals.ts asks whether bin/queue-run is there).
const shellTools = (deps: HarnessPlanDeps, settings: SandboxSettings): Pick<TurnTools, "outputCleaners" | "outputHoldout" | "heavyCommands" | "offloadCommands"> => ({
    ...(settings.outputCleaners !== "" ? { outputCleaners: settings.outputCleaners } : {}),
    ...(settings.outputHoldout > 0 ? { outputHoldout: settings.outputHoldout } : {}),
    heavyCommands: () => deps.heavyCommands.read(),
    // Read per command like the rules, so sending a kind of work elsewhere binds on the next line.
    ...(offloadRunEnabled() ? { offloadCommands: async () => (await deps.sandboxSettings.get()).offload.commands } : {}),
});

// The Claude Code harness: a native Claude turn's subscription OAuth (with mid-turn refresh) or the translator endpoint a
// routed provider rides. Credentials resolve through harness-credentials.ts; its refusals become the connect-gate's error.
export const planHarnessTurn = async (
    deps: HarnessPlanDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    const [resolved, settings, safetyPolicy] = await harnessReads(deps, input, context);
    if (!resolved.ok) {
        return { ok: false, ...opt("code", resolved.code), message: resolved.message, ...opt("account", resolved.account) };
    }
    // What this turn may reach out of the container, and the owner's own browsers: the cards peerToolsOf mounts, through
    // Services, since the hosts and webext subsystems reach back into this one.
    const hostDevices = await deps.hostReach(granted);
    const ownBrowsers = await deps.webextReach(granted);
    // Resolved by planTurn and already applied to `granted`; the open, attended fallback is only for the bench.
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    // Resolved once and read twice (the plugin list and `iqAvailable`), so the notice and the load can't disagree.
    const iqLoaded = deps.config.iqPluginDir !== "" && (context.iqSearchEnabled ?? settings.iqSearch);
    const [mounts, mounted] = await harnessMounts(deps, input, granted, persona, iqLoaded);
    const { browser, tools: remote } = mounted;
    const plugins = mounts.map((mount) => mount.pluginDir);
    const secrets = turnSecretAccess(deps, input, context.base.signal);
    const sdkServers = harnessServers(deps, { input, context, persona, browser, secrets, hashlineEdits: settings.hashlineEdits });
    const tools: TurnTools = {
        ...context.base.tools,
        ...(plugins.length > 0 ? { plugins } : {}),
        ...(remote.length > 0 ? { remote } : {}),
        sdkServers,
        ...browserFields(deps.workspace.root, browser),
        // Named in the prompt only where its tools can actually be called.
        ...(sdkServers["diagnostics"] === undefined ? {} : { diagnostics: true }),
        hostDevices,
        ownBrowsers,
        iqAvailable: iqLoaded,
        ...harnessAccounts(deps, input, context, granted),
        ...shellTools(deps, settings),
        // Every stored credential masked to its reference in tool results, unconditional since this isn't a saving worth
        // trading away.
        secrets,
    };
    // Hooks in Claude Code's settings files that the owner has not approved in this form switch every hook off.
    const gated = await deps.perf.track("turn.plan.hooks", {}, () =>
        withSettingsHookGate(deps.config.historyRoot, input.conversationId, {
            spec: harnessSpec(deps, input, context, resolved.credentials),
            policy: harnessPolicy(context.base.policy, input, settings, safetyPolicy),
        }),
    );
    return armPlan(
        releasingMounts(deps.agent, mounted),
        {
            ...context.base,
            ...gated,
            tools,
            credential: harnessCredentialOf(resolved.credentials),
            hooks: {
                ...harnessHooks(
                    deps,
                    input,
                    context,
                    standing(settings.rules, "file.edited"),
                    { settings, policy: safetyPolicy },
                ),
                // A `run_in_background` job outlives this turn, so its completion is delivered to a conversation rather
                // than to the process that started it; the same profile the watch takes, for the same reason.
                ...(input.conversationId === undefined
                    ? {}
                    : { backgroundJobs: { conversationId: input.conversationId, profile: profileOf(input), conversations: deps.conversations } }),
            },
        },
        resolved.credentials.account,
    );
};
