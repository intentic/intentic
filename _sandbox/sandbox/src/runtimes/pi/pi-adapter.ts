import { access } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { PI_PROVIDER } from "@intentic/sandbox-contract/models/agent-catalog";
import {
    type AgentAdapter,
    armPlan,
    attemptProbe,
    healthReady,
    healthUnavailable,
    healthUnknown,
    type TurnArmPlan,
    type TurnContext,
} from "../../agent/providers/adapter.js";
import { withAttachments } from "../../sessions/vocabulary/attachment-note.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { onPath } from "../../image/on-path.js";
import { personaSkillsRoot } from "../../personas/persona-kit.js";
import { skillFolderNames } from "../../skill-file.js";
import { loadedSkillsRoot } from "../../store/loaded-skills.js";
import { requireRootAgentExecution } from "../../workload/agent-execution.js";
import { editReviewersOf, turnChecksOf } from "../../agent/run/harness/harness-hooks.js";
import { turnSecretAccess } from "../../agent/run/harness/harness-servers.js";
import { turnPersona } from "../../personas/personas.js";
import { declaredChecks } from "../../rules/repo-checks.js";
import { standing } from "../../rules/rules.js";
import { type DaemonServersDeps, daemonServersFor } from "../daemon-tools/daemon-servers.js";

// The Pi row: the reserved `pi` agent-kind capability, served over Pi's own RPC protocol. A plain adapter rather than a
// provider module (the ACP reason): Pi is an installed capability, so everything past serving a turn is the capability
// system's business.

// What the Pi adapter reads: the installed manifest its capability lives in, the daemon's tools it passes through, and
// the loop that spawns it.
export type PiAdapterDeps = TurnToolsDeps & DaemonServersDeps & Pick<Services, "capabilities" | "piAgent" | "sandboxSettings">;

// The skills a Pi turn loads (`--skill`, with Pi's own discovery off): the workspace's loaded skills less those the
// persona or a credential gate denies (TurnPolicy.disallowedTools names them `Skill(<name>)`, as the Claude Code loop
// is told), and the worn persona's own kit. Listed off the conversation's tree as the daemon sees it, named as Pi sees
// it, so an isolated turn loads its worktree's copies.
export const piSkillsOf = async (context: Pick<TurnContext, "localCwd" | "effectiveCwd" | "base" | "persona">): Promise<string[]> => {
    const denied = new Set(context.base.policy.disallowedTools ?? []);
    const loaded = (await skillFolderNames(loadedSkillsRoot(context.localCwd)))
        .filter((name) => !denied.has(`Skill(${name})`))
        .map((name) => join(loadedSkillsRoot(context.effectiveCwd), name));
    const persona = context.persona?.persona?.id;
    const kit = persona === undefined || (await skillFolderNames(personaSkillsRoot(context.localCwd, persona))).length === 0 ? [] : [personaSkillsRoot(context.effectiveCwd, persona)];
    return [...loaded, ...kit];
};

// Spawned and driven over Pi's own RPC; harness doesn't apply (Pi is its own loop). Unlike the ACP floor it takes
// steering (real mid-turn injection) and effort (set_thinking_level), and the turn's remote MCP servers, the daemon's
// own among them (daemon-servers.ts), ride a fresh lease each turn, since each turn is a fresh process: a Pi too old for
// built-in MCP says so in the turn (pi-agent.ts). What the Claude Code loop's hooks answer at an edit and at its end
// (harness-hooks.ts) is bound here too, for the daemon's Pi extension to reach through the turn's hook socket
// (pi-hooks.ts), with the secrets every result is masked against and every shell line resolves.
export const planPiTurn = async (
    services: PiAdapterDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    const capability = granted.find((entry) => entry.kind === "agent" && entry.id === PI_PROVIDER);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: "Pi is not installed, add the Pi Agent capability first." };
    }
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: context.persona?.powers.browser ?? true,
        shell: context.persona?.powers.shell ?? true,
        extensions: context.persona?.powers.extensions,
    });
    const skills = await piSkillsOf(context);
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const settings = context.settings ?? (await services.sandboxSettings.get());
    // One secret seam for the turn: what its shell lines resolve, its results are masked against, and its typist uses.
    const secrets = context.base.tools.secrets ?? turnSecretAccess(services, input, context.base.signal);
    const withSecrets: TurnContext = { ...context, base: { ...context.base, tools: { ...context.base.tools, secrets } } };
    // Pi's own hook socket stands in front of every tool (pi-hooks.ts), so the gate server would only be three more tools.
    const daemon = daemonServersFor(services, { input, context: withSecrets, persona, granted, settings, mounted, gate: false });
    const tools = [...mounted.tools, ...daemon.tools];
    const sealedAtDoor = daemon.tools.map((tool) => tool.name);
    return armPlan(
        releasingMounts((request) => services.piAgent(capability.config, request, { skills, sealedAtDoor }), mounted),
        withAttachments(
            {
                ...withSecrets.base,
                spec: { ...context.base.spec, ...opt("steering", context.steering) },
                tools: { ...withSecrets.base.tools, ...opt("remote", tools.length > 0 ? tools : undefined), diagnostics: daemon.diagnostics },
                hooks: {
                    ...context.base.hooks,
                    relay: daemon.relay,
                    ...editReviewersOf(services, context, standing(settings.rules, "file.edited")),
                    ...turnChecksOf(services, context, declaredChecks(standing(settings.rules, "turn.ending"))),
                },
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
    );
};

export const PI_ADAPTER: AgentAdapter<"pi", PiAdapterDeps> = {
    runtime: "pi",
    preflight: (services, input, context, installed) => planPiTurn(services, input, context, installed),
    // Two things must hold, each a different fix: the `pi` capability installed (Setup ▸ Extend), and its command on
    // PATH (a card added before the image rebuild is exactly this state). Probed on the command's head, the OpenCode
    // precedent.
    health: async (services) => {
        const installed = await attemptProbe(() => services.capabilities.list());
        if (installed === undefined) {
            return healthUnknown();
        }
        const capability = installed.find((entry) => entry.kind === "agent" && entry.id === PI_PROVIDER);
        if (capability === undefined || capability.kind !== "agent") {
            return healthUnavailable("Add the Pi Agent capability to run Pi here.");
        }
        const head = capability.config.command.trim().split(/\s+/)[0] ?? "";
        return (await onPath(head)) ? healthReady() : healthUnavailable(`\`${head}\` is not on PATH, rebuild the sandbox so the Pi install lands in the image.`);
    },
    // A Pi session is a JSONL file (the id on the wire is its path); resume-ability is whether the file still exists,
    // asked of the filesystem since there's no process between turns to ask. Only a missing file is a lost session.
    holdsSession: async (_services, sessionId, execution) => {
        // A path in a domain is not the daemon's filesystem view.
        requireRootAgentExecution(execution, "Pi's filesystem session probe");
        return (await access(sessionId).then(() => true, undefinedIfMissing)) ?? false;
    },
};
