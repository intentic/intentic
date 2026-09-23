import {
    type AgentCapabilities,
    type CredentialGate,
    type SandboxSettings,
    type SystemPromptMode,
    type TurnNote,
    envSuffix,
} from "@intentic/sandbox-contract";
import { jsExecutionPlanOf } from "../../../execution/js-runtime.js";
import { personaScopeOf } from "../../../personas/persona-scope.js";
import {
    type TurnPersona,
    personaCliEnv,
    personaDisallowedTools,
    personaNote,
    personaWithheldAccounts,
    unattendedAccountsNote,
} from "../../../personas/personas.js";
import { turnEndingNote } from "../../../rules/turn-ending-note.js";
import { gatedCliEnv, gatedCredentialsNote, gatedSkills } from "../../../secrets/credential-gating.js";
import { SKILL_CATALOG_NOTE_TITLE } from "../../../store/loaded-skills.js";
import { resolveWithin } from "../../../workspace/files/workspace-files-paths.js";
import { setupNoticeFor, setupNoticeTitle } from "../../../workspace/layout/workspace-setup.js";
import { IQ_SEARCH_INSTRUCTION_TITLE } from "../../prompt/iq-search-instruction.js";
import { turnPromptPlacement } from "../../prompt/system-prompt.js";
import { worktreeNote, worktreeReminder } from "../../prompt/turn-preamble.js";
import { promptTrim } from "../../prompt/window/context-trim.js";
import { WORKSPACE_MAP_NOTE_TITLE } from "../../prompt/workspace-map.js";
import { SPAWN_NOTE_TITLE } from "../../subagents/spawn-note.js";
import type { TurnBase, TurnPolicy, TurnSpec, TurnTools } from "../../providers/agent-request.js";
import { opt } from "../../../opt.js";
import { TURN_CONTEXT_NOTE_TITLE } from "../turn/turn-context.js";
import type { TurnContext } from "../../providers/adapter.js";
import type { AdmittedTurnFacts } from "./turn-facts.js";
import type { TurnPremise } from "./turn-premise.js";

// The one point every provider arm passes through: controls a runtime cannot honour are dropped, and every
// runtime-agnostic fact (worktree, dependency readiness, persona shelves, credential gates, standing instructions) is
// applied once here rather than drifting per arm. Pure: whatever it needs from disk is already in the facts.

// Which system prompt the turn runs on: the persona's answer, already resolved against the sandbox's (personaPrompt).
export interface TurnPrompt {
    readonly mode: SystemPromptMode;
    readonly systemPrompt: string;
}

// Through the workspace escape guard: a folder that fails it is dropped rather than refused, so a typo opens the root.
const startPathOf = (startIn: string | undefined, effectiveCwd: string): string | undefined =>
    startIn === undefined || startIn === "" ? undefined : resolveWithin(effectiveCwd, startIn);

// What the turn may reach. The environment passes two filters, the persona's and the gate's, and a connector caught by
// either loses every variable carrying its suffix; a withheld credential's skill is denied with it, since it would dangle.
const turnAccess = (facts: AdmittedTurnFacts, base: TurnBase, persona: TurnPersona, withheldMounts: readonly CredentialGate[]) => {
    const personaEnv = base.tools.cliEnv === undefined ? undefined : personaCliEnv(base.tools.cliEnv, facts.installed, persona, envSuffix);
    const gatedEnv =
        personaEnv === undefined
            ? undefined
            : gatedCliEnv(personaEnv, facts.installed, facts.gates, facts.releases, base.spec.conversationId, envSuffix);
    const withheld = [...withheldMounts, ...(gatedEnv?.withheld ?? [])];
    return {
        shellEnv: gatedEnv?.cliEnv,
        withheld,
        denied: [...(base.policy.disallowedTools ?? []), ...personaDisallowedTools(persona, facts.installed), ...gatedSkills(withheld)],
    };
};

// Composed by planning but not read off the facts: the teaching for a shell-only spawn door, and the sandbox's brief.
export interface PlannedNotes {
    readonly spawn: string | undefined;
    readonly fieldNotes: string | undefined;
}

// What the turn is told about its tree and what the workspace holds, in the order it reads them.
const workspaceNotes = (
    facts: AdmittedTurnFacts,
    context: TurnContext,
    capabilities: AgentCapabilities,
    send: TurnPremise["send"],
    isolated: boolean,
): TurnNote[] => {
    const setupNotice = setupNoticeFor(facts.setup);
    return [
        ...(isolated && capabilities.isolation === "cwd"
            ? [context.base.spec.sessionId === undefined ? worktreeNote(context.localCwd, facts.root) : worktreeReminder(facts.root)]
            : []),
        ...(send.map && facts.mapNote !== undefined ? [{ title: WORKSPACE_MAP_NOTE_TITLE, text: facts.mapNote }] : []),
        // After the map, which draws the tree, and before the skills: what the tree holds is the next question it raises.
        ...[facts.contextNote].filter((note) => note !== undefined),
        ...(facts.skillCatalogNote === undefined ? [] : [{ title: SKILL_CATALOG_NOTE_TITLE, text: facts.skillCatalogNote }]),
        // Only where the runtime has no readiness tools and hooks, which would otherwise repeat these facts every turn.
        ...(setupNotice !== undefined && capabilities.mcp !== "full" ? [{ title: setupNoticeTitle(setupNotice), text: setupNotice }] : []),
    ];
};

// What the turn is taught, what it cannot reach and why, and which checks its end will run.
const turnNotes = (
    facts: AdmittedTurnFacts,
    premise: TurnPremise,
    settings: SandboxSettings,
    spawn: string | undefined,
    withheld: readonly CredentialGate[],
    turnEnding: boolean,
): TurnNote[] => [
    ...(premise.send.iqTeaching && facts.iqTeaching !== undefined ? [{ title: IQ_SEARCH_INSTRUCTION_TITLE, text: facts.iqTeaching.note }] : []),
    // Last of the standing notes and nearest the message, since it answers this message rather than the workspace.
    ...(facts.turnContext !== undefined && "note" in facts.turnContext ? [{ title: TURN_CONTEXT_NOTE_TITLE, text: facts.turnContext.note }] : []),
    ...(spawn === undefined ? [] : [{ title: SPAWN_NOTE_TITLE, text: spawn }]),
    // On every turn missing something, not once per conversation: the condition changes the moment someone clicks.
    ...[gatedCredentialsNote(withheld)].filter((note) => note !== undefined),
    // The other reason an account can be missing: nobody is at the composer, so the turn acts as no one.
    ...[unattendedAccountsNote(premise.persona, personaWithheldAccounts(facts.installed, premise.persona))].filter((note) => note !== undefined),
    ...(turnEnding ? [turnEndingNote(settings.rules)].filter((note) => note !== undefined) : []),
];

// The posture the route folded into the request, kept only where this runtime's record honours it; anything else
// travels as the absence that already meant its default.
const honouredPolicy = (base: TurnBase, capabilities: AgentCapabilities): Pick<TurnPolicy, "permissionMode"> =>
    // A "plan" runtime knows only propose-then-approve or run, and every other mode means the second.
    base.policy.permissionMode !== undefined && (capabilities.permissions === "modes" || base.policy.permissionMode === "plan")
        ? { permissionMode: base.policy.permissionMode }
        : {};

const honouredReasoning = (base: TurnBase, capabilities: AgentCapabilities): Pick<TurnSpec, "effort" | "fast"> => ({
    ...(base.spec.effort !== undefined && capabilities.effort ? { effort: base.spec.effort } : {}),
    // Only the Claude Code loop can ask for it; planHarnessTurn withholds it again from a non-first-party endpoint.
    ...(base.spec.fast === true && capabilities.fastMode ? { fast: base.spec.fast } : {}),
});

// The JS backend's plan, where persona, tree and filtered environment are all in hand. Gated on the runtime hosting it
// and on the card, so an ungranted backend is absent rather than present-and-refused.
const jsExecutionFor = (
    capabilities: AgentCapabilities,
    persona: TurnPersona,
    context: TurnContext,
    startPath: string | undefined,
    shellEnv: Record<string, string> | undefined,
): TurnTools["jsExecution"] =>
    capabilities.execution.includes("js")
        ? jsExecutionPlanOf(persona, { root: context.effectiveCwd, cwd: startPath ?? context.base.spec.cwd }, { ...shellEnv })
        : undefined;

export const honoured = (
    facts: AdmittedTurnFacts,
    context: TurnContext,
    // The owner's settings with the repositories' declared checks merged into the rules.
    settings: SandboxSettings,
    capabilities: AgentCapabilities,
    premise: TurnPremise,
    prompt: TurnPrompt,
    // Mounts the gate filter already took from the manifest; the environment's own withholding is built here.
    withheldMounts: readonly CredentialGate[],
    planned: PlannedNotes,
): TurnBase => {
    const { persona, send } = premise;
    const { base } = context;
    // The three controls come back only where the runtime honours them (honouredPolicy/Reasoning); the rest are rebuilt.
    const { effort: _effort, fast: _fast, ...spec } = base.spec;
    const { permissionMode: _mode, disallowedTools: _denied, ...policy } = base.policy;
    const { cliEnv: _env, ...tools } = base.tools;
    // An isolated conversation's worktree is not the workspace root; a main-tree turn has nothing to say about it.
    const isolated = context.localCwd !== facts.root;
    const startPath = startPathOf(premise.startIn, context.effectiveCwd);
    const placement = turnPromptPlacement({
        capabilities,
        ...prompt,
        stableSystemPrompt: settings.stableSystemPrompt,
        ...opt("personaNote", personaNote(persona)),
        ...opt("memoryNote", facts.memoryNote),
        ...opt("fieldNotesNote", planned.fieldNotes),
        // What the window will not pay for: this product's guidance, and on the smallest windows the base prompt too.
        ...opt("trim", promptTrim(context.contextTrim)),
        guidance: premise.guidance,
    });
    const access = turnAccess(facts, base, persona, withheldMounts);
    return {
        ...base,
        spec: {
            ...spec,
            // The card's briefing applied to the whole list, so a note it dropped cannot survive on a path nobody guarded.
            notes: premise.briefing.keep([
                // First, when there is one: who the turn acts as belongs ahead of anything about files or tools.
                ...(placement.userNotes ?? []),
                ...workspaceNotes(facts, context, capabilities, send, isolated),
                // The Claude Code loop runs the checks at its own Stop; the daemon runs them for the rest on an isolated turn only.
                ...turnNotes(
                    facts,
                    premise,
                    settings,
                    planned.spawn,
                    access.withheld,
                    send.turnEnding && (capabilities.runtime === "claude-code" || isolated),
                ),
            ]),
            systemPromptMode: prompt.mode,
            ...opt("systemPrompt", placement.systemPrompt),
            ...opt("systemAppend", placement.systemAppend),
            guidance: premise.guidance,
            sessionStore: facts.sessionStore,
            ...opt("cwd", startPath),
            // A fact about that cwd: only an isolated turn works in a copy of its own. Read by the command gate.
            ownCheckout: isolated,
            ...honouredReasoning(base, capabilities),
        },
        policy: {
            ...policy,
            // Read from the pair's own record, so a lying row changes turn behavior and not just what the composer shows.
            rulebook: capabilities.rulebook,
            dependencyInstallAllowed: persona.powers.files === "write" && persona.powers.shell,
            // Anchored at the workspace root, not the start folder: a persona may start in one repo and read a sibling.
            ...opt("personaScope", personaScopeOf(persona, context.effectiveCwd)),
            ...(access.denied.length > 0 ? { disallowedTools: access.denied } : {}),
            ...honouredPolicy(base, capabilities),
        },
        tools: {
            ...tools,
            ...(access.shellEnv !== undefined && Object.keys(access.shellEnv).length > 0 ? { cliEnv: access.shellEnv } : {}),
            ...opt("jsExecution", jsExecutionFor(capabilities, persona, context, startPath, access.shellEnv)),
        },
    };
};
