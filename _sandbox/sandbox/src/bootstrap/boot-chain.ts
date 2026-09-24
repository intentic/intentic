import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArrivalItem } from "@intentic/sandbox-contract";
import { defaultGit } from "@intentic/scaffold";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { unmaskableSecrets } from "../agent/tools/agent-redaction.js";
import { ensureApprovalsSkill } from "../approvals/approvals-store.js";
import { writeAgentToken } from "../auth/agent-token.js";
import { DOCKER_PANEL_KEY } from "../capabilities/handlers/docker.handler.js";
import { localModelPanelKey } from "../capabilities/handlers/localmodel.handler.js";
import { linkSshHosts } from "../capabilities/ssh-hosts.js";
import type { Services } from "../composition.js";
import { ensureRepoGitDirs } from "../git/remote/repo-git-dirs.js";
import { commitRootBaseline, ensureLocalRootRepo, ensureRootRepo } from "../git/remote/root-repo.js";
import { applyEventsPath, applyRunLive } from "../intentic/apply-events.js";
import { checkEventsDir } from "../intentic/check-run.js";
import { INFRA_APPLY_KEY } from "../intentic/infra-apply.js";
import { arrivedPrewarmed } from "../platform/boot/prewarm.js";
import { restoreAuthorizedKeys } from "../platform/sync.js";
import { applyDefinitionItems } from "../portability/apply-definition.js";
import { sweepArrivals } from "../portability/bundle-arrival.js";
import { parseDefinitionToml } from "../portability/definition.js";
import { sweepStaleExports } from "../portability/exports.js";
import { killStaleManagedSessions, panelSession } from "../processes/managed-processes.js";
import { killOrphanServiceProcesses } from "../processes/service-processes.js";
import type { RunnerModeEnv } from "../runners/runner-mode.js";
import { seedStarterSite } from "../scaffold/starter-site.js";
import { linkClaudeState } from "../sessions/session-store.js";
import { reconcileBakedSkills } from "../settings/skills.js";
import type { BootPhase } from "./boot-phase.js";

// What a step reads: the boot phase, the runner env a definition seed is filtered by, and whether rootRepo created the
// workspace repo this boot, which the starter seed and the baseline commit wait on.
interface BootRun extends BootPhase {
    readonly runnerEnv: RunnerModeEnv | undefined;
    freshRoot: boolean;
}

interface BootChainStep {
    readonly key: string;
    readonly label: string;
    // Absent runs on every daemon; a step this daemon skips still reads done.
    readonly when?: (run: BootRun) => boolean;
    readonly run: (run: BootRun) => Promise<unknown>;
    // Logged when `run` rejects, and the chain goes on; a step without one handles its own failures.
    readonly failure?: string;
}

// Kills a previous daemon's panel, agent and job tmux sessions, re-adopting a live infra apply, dockerd or model server;
// the tmux server is container-wide, so they are the container owner's to sweep.
const sweepStaleSessions = async ({ config, logger, services }: BootRun): Promise<void> => {
    // An events log that cannot be read spares whatever apply session exists: killing a live infra apply mid-run is the
    // costlier mistake.
    // A session that could not be adopted is swept as stale below, so the refusal is said, not dropped.
    const adopted = (key: string, options: { oneShot?: true }): Promise<boolean> =>
        services.processes.adopt(key, options).catch((error: unknown) => {
            logger.warn({ err: error, key }, "boot: a managed session could not be adopted, so it is swept as stale");
            return false;
        });
    const applyLive =
        (await applyRunLive(applyEventsPath(config.historyRoot)).catch((error: unknown) => {
            logger.warn({ err: error }, "boot: the infra apply's event log could not be read, its session is spared if one is alive");
            return true;
        })) && (await adopted(INFRA_APPLY_KEY, { oneShot: true }));
    const dockerAlive = await adopted(DOCKER_PANEL_KEY, {});
    // Killing a live model server discards a loaded model, minutes to reload.
    const capabilities = await services.capabilities.list().catch((error: unknown) => {
        logger.warn({ err: error }, "boot: capabilities could not be listed, so no local model server is spared the stale sweep");
        return [];
    });
    const modelKeys = capabilities.flatMap((capability) => (capability.kind === "localmodel" ? [localModelPanelKey(capability.id)] : []));
    const modelsAlive: string[] = [];
    for (const key of modelKeys) {
        if (await adopted(key, {})) {
            modelsAlive.push(panelSession(key));
        }
    }
    await killStaleManagedSessions([
        ...(applyLive ? [panelSession(INFRA_APPLY_KEY)] : []),
        ...(dockerAlive ? [panelSession(DOCKER_PANEL_KEY)] : []),
        ...modelsAlive,
    ]).catch(() => undefined);
    // Extension-gateway children of a daemon that died without unwinding hold connections a restore would duplicate.
    await killOrphanServiceProcesses(logger).catch(() => undefined);
};

// Guarded by an empty (or only prewarmed) workspace, so a replayed env can never run over real work.
const seedDefinition = async ({ config, logger, services, runnerEnv }: BootRun): Promise<void> => {
    if (!services.workspaceArrivedEmpty && !(await arrivedPrewarmed(config.workspaceRoot, config.historyRoot))) {
        return;
    }
    const definition = parseDefinitionToml(Buffer.from(config.sandbox.definitionSeed, "base64").toString("utf8"));
    // A runner has no owner to reconnect a capability or fill a secret, and its repos arrive through the parent's git sync.
    const pick = runnerEnv !== undefined ? (item: ArrivalItem): boolean => item.group === "settings" : (): boolean => true;
    const report = await applyDefinitionItems(services, definition, pick);
    logger.info({ report }, "sandbox definition seeded; its needsAction list is the owner's arrival checklist");
};

// The approvals skill and the baked-tool skills settings name, before the baseline commit; an owner's own skill file is
// never created or deleted here.
const convergeSkills = async ({ logger, services }: BootRun): Promise<void> => {
    await ensureApprovalsSkill(services).catch((error: unknown) => logger.warn({ err: error }, "approvals skill not converged"));
    try {
        const { settings, unreadable } = await services.sandboxSettings.load();
        // Defaults standing in for an unreadable file are nobody's choice, so they switch no tool.
        if (unreadable) {
            logger.warn("settings.json could not be read by this build, so the baked-tool skills stay as they are");
            return;
        }
        await reconcileBakedSkills(services, settings.skills);
    } catch (error) {
        logger.warn({ err: error }, "skill reconcile failed");
    }
};

// A credential written into the agent-readable manifest or settings file by hand rather than through a save is moved to
// the private store before any turn can read it; best-effort.
const vaultLooseSecrets = async ({ logger, services }: BootRun): Promise<void> => {
    const moved = await services.vaultManifestSecrets().catch((error: unknown) => {
        logger.warn({ err: error }, "capability credentials: could not be moved out of the manifest, they stay readable to the agent");
        return [];
    });
    if (moved.length > 0) {
        logger.info({ capabilities: moved }, "capability credentials moved out of the workspace manifest into the private store");
    }
    // Unlike the manifest this file is tracked, so an unswept secret would be committed, not just readable.
    const settings = await services.vaultExtensionSettingSecrets().catch((error: unknown) => {
        logger.warn({ err: error }, "extension setting secrets: could not be moved out of the tracked file, they stay readable to the agent");
        return [];
    });
    if (settings.length > 0) {
        logger.info({ extensions: settings }, "extension setting secrets moved out of the tracked settings file into the private store");
    }
    // Masking (agent-redaction.ts) has a length floor below which a stored value passes unmasked.
    const unmaskable = unmaskableSecrets(
        await services.secretRegistry().catch((error: unknown) => {
            logger.warn({ err: error }, "secrets: the stores could not be read, so every tool result is withheld until they can");
            return [];
        }),
    );
    if (unmaskable.length > 0) {
        logger.warn(
            { secrets: unmaskable },
            "these stored secrets are too short to mask, so they reach the model in full when something reads them: replace them with longer values",
        );
    }
};

// Before the baseline commit, or the seeded repo's files show as a phantom add.
const seedStarter = async ({ logger, services }: BootRun): Promise<void> => {
    const outcome = await seedStarterSite(services);
    if ("repo" in outcome) {
        logger.info({ repo: outcome.repo }, "starter site seeded");
        return;
    }
    // The one boot meant to seed is the only place the reason for an empty workspace is ever recorded.
    logger.info({ why: outcome.skipped }, "starter site not seeded, the workspace opens as it arrived");
};

// The converging work every held data route waits on, in the order it runs. A request arriving mid-boot queues on the
// gate rather than reading half-built state, and the browser is told which step is running. `role.container` owns the
// shared ~/.ssh and ~/.claude; `role.roots` owns the workspace and history roots.
const BOOT_STEPS: readonly BootChainStep[] = [
    // authorized_keys is container-local and rebuilt from /history's enrollments before sshd serves a reconnect.
    {
        key: "authorizedKeys",
        label: "Restoring desktop enrollments",
        when: ({ role }) => role.container,
        run: ({ config }) => restoreAuthorizedKeys(config.historyRoot),
        failure: "authorized_keys not restored, enrolled machines will be refused until they re-enroll",
    },
    // Before the gate: a CLI spawned mid-link would fork the session stores.
    {
        key: "claudeState",
        label: "Linking conversation state",
        when: ({ role }) => role.container,
        run: ({ services }) => linkClaudeState(services.workspace.root),
        failure: "claude session state not persisted, sessions will not survive a rebuild whole",
    },
    {
        key: "sshHosts",
        label: "Linking ssh hosts",
        when: ({ role }) => role.container,
        run: ({ config }) => linkSshHosts(config.historyRoot),
        failure: "ssh hosts dir not persisted, git access and ssh aliases will not survive a rebuild",
    },
    { key: "vaultSecrets", label: "Securing stored credentials", run: vaultLooseSecrets },
    // Before any step that starts a process of its own (boot-order.test.ts pins it).
    { key: "staleSessions", label: "Sweeping stale sessions", when: ({ role }) => role.container, run: sweepStaleSessions },
    // A failure reads as not fresh, so the baseline commit is skipped; local roots are taken as they stand.
    {
        key: "rootRepo",
        label: "Preparing the workspace repo",
        when: ({ role }) => role.roots,
        run: async (boot) => {
            const { services, config, traits } = boot;
            boot.freshRoot = await (traits.relocateGitDirs
                ? ensureRootRepo(services.workspace, config.historyRoot, defaultGit, services.workspaceArrivedEmpty)
                : ensureLocalRootRepo(services.workspace, defaultGit, services.workspaceArrivedEmpty));
        },
        failure: "root workspace repo not ensured, the Changes review will degrade",
    },
    {
        key: "starterSite",
        label: "Putting your starter site in place",
        when: ({ role, freshRoot, traits }) => role.roots && freshRoot && traits.ownsWorkspaceConfig,
        run: seedStarter,
        failure: "starter site not seeded, the workspace opens empty",
    },
    // Scanners already exclude the shelf, so its presence on disk is the whole affordance.
    {
        key: "referenceShelf",
        label: "Ensuring the reference shelf",
        when: ({ role, traits }) => role.roots && traits.ownsWorkspaceConfig,
        run: ({ config }) => mkdir(join(config.workspaceRoot, REFERENCE_DIR), { recursive: true }),
        failure: "reference shelf not ensured, refs/ drops have no target",
    },
    // A restart strands both: a half-written export would read as packing, an arrival's review token died with the process.
    {
        key: "staleExports",
        label: "Sweeping interrupted exports and arrivals",
        when: ({ role }) => role.roots,
        run: ({ config, logger }) =>
            Promise.all([
                sweepStaleExports(config.historyRoot).catch((error: unknown) =>
                    logger.warn({ err: error }, "stale exports not swept, an interrupted export may still read as packing"),
                ),
                sweepArrivals(config.historyRoot).catch((error: unknown) =>
                    logger.warn({ err: error }, "abandoned arrival spools not swept, they hold disk until the next boot"),
                ),
            ]),
    },
    // After rootRepo and before worktrees load, so a repo's git dir resolves the same inside an isolated turn.
    {
        key: "repoGitDirs",
        label: "Healing repository git dirs",
        when: ({ role, traits }) => role.roots && traits.relocateGitDirs,
        run: ({ services, config, logger }) => ensureRepoGitDirs(services.workspace, config.historyRoot, logger),
    },
    {
        key: "definitionSeed",
        label: "Seeding the sandbox definition",
        when: ({ role, traits, config }) => role.roots && traits.ownsWorkspaceConfig && config.sandbox.definitionSeed !== "",
        run: seedDefinition,
        failure: "sandbox definition not seeded, the workspace opens as it arrived",
    },
    // Before the gate, so an /events stream opened mid-boot never sees an empty fleet.
    {
        key: "agentsRegistry",
        label: "Loading conversations",
        run: ({ services }) => services.agents.init(),
        failure: "agents registry not initialized, the fleet starts empty",
    },
    { key: "skills", label: "Converging agent skills", when: ({ role, traits }) => role.roots && traits.ownsWorkspaceConfig, run: convergeSkills },
    // After every daemon-owned file exists, so Changes starts clean.
    {
        key: "baseline",
        label: "Taking the workspace baseline",
        when: ({ freshRoot }) => freshRoot,
        run: ({ services }) => commitRootBaseline(services.workspace),
        failure: "root baseline commit failed, the Changes review will start dirty",
    },
    // The in-container vpn and otp CLIs read it from /run to reach the daemon's routes.
    {
        key: "agentToken",
        label: "Writing the agent token",
        when: ({ traits }) => traits.containerCapabilities,
        run: ({ services }) => writeAgentToken(services.agentToken),
        failure: "agent token: could not write",
    },
];

// Closes the data gate. Called before the listeners come up, so no request can slip past an undeclared chain.
export const declareBootSteps = (services: Services): void => services.boot.declare(BOOT_STEPS);

export const runBootSteps = async (phase: BootPhase, runnerEnv: RunnerModeEnv | undefined): Promise<void> => {
    const boot: BootRun = { ...phase, runnerEnv, freshRoot: false };
    for (const step of BOOT_STEPS) {
        await phase.services.boot.step(step.key, async () => {
            if (step.when?.(boot) === false) {
                return;
            }
            const { failure } = step;
            await (failure === undefined ? step.run(boot) : step.run(boot).catch((error: unknown) => phase.logger.warn({ err: error }, failure)));
        });
    }
    // A previous boot's check runs left per-run event files behind; their streams died with the daemon.
    if (phase.role.roots) {
        void rm(checkEventsDir(phase.config.historyRoot), { recursive: true, force: true });
    }
};
