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
import type { BootTracker } from "../platform/boot/boot.js";
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

// The converging work every held data route waits on, in the order it runs. A request arriving mid-boot queues on the
// gate rather than reading half-built state, and the browser is told which step is running. Declaring the chain is what
// closes the gate; the caller opens it once this returns. Steps are declared in BOOT_STEPS, so an undeclared step is a
// type error, not a silent gap.
const BOOT_STEPS = [
    { key: "authorizedKeys", label: "Restoring desktop enrollments" },
    { key: "claudeState", label: "Linking conversation state" },
    { key: "sshHosts", label: "Linking ssh hosts" },
    { key: "vaultSecrets", label: "Securing stored credentials" },
    { key: "staleSessions", label: "Sweeping stale sessions" },
    { key: "rootRepo", label: "Preparing the workspace repo" },
    { key: "starterSite", label: "Putting your starter site in place" },
    { key: "referenceShelf", label: "Ensuring the reference shelf" },
    { key: "staleExports", label: "Sweeping interrupted exports and arrivals" },
    { key: "repoGitDirs", label: "Healing repository git dirs" },
    { key: "definitionSeed", label: "Seeding the sandbox definition" },
    { key: "agentsRegistry", label: "Loading conversations" },
    { key: "skills", label: "Converging agent skills" },
    { key: "baseline", label: "Taking the workspace baseline" },
    { key: "agentToken", label: "Writing the agent token" },
] as const;

// Closes the data gate. Called before the listeners come up, so no request can slip past an undeclared chain.
export const declareBootSteps = (services: Services): void => services.boot.declare(BOOT_STEPS);

// Kills leftover panel/agent/job tmux sessions from a previous daemon, except a live infra apply, dockerd or model
// server, re-adopted instead. Container-wide: the tmux server is shared, so these sessions belong to whoever owns it.
const sweepStaleSessions = async ({ config, logger, services }: BootPhase): Promise<void> => {
    const applyLive =
        (await applyRunLive(applyEventsPath(config.historyRoot)).catch(() => false)) &&
        (await services.processes.adopt(INFRA_APPLY_KEY, { oneShot: true }).catch(() => false));
    const dockerAlive = await services.processes.adopt(DOCKER_PANEL_KEY, {}).catch(() => false);
    // Adopted for the same reason as dockerd, but pricier to get wrong: killing a live model server discards a
    // loaded model, costing minutes to reload.
    const modelKeys = (await services.capabilities.list().catch(() => [])).flatMap((capability) =>
        capability.kind === "localmodel" ? [localModelPanelKey(capability.id)] : [],
    );
    const modelsAlive: string[] = [];
    for (const key of modelKeys) {
        if (await services.processes.adopt(key, {}).catch(() => false)) {
            modelsAlive.push(panelSession(key));
        }
    }
    await killStaleManagedSessions([
        ...(applyLive ? [panelSession(INFRA_APPLY_KEY)] : []),
        ...(dockerAlive ? [panelSession(DOCKER_PANEL_KEY)] : []),
        ...modelsAlive,
    ]).catch(() => undefined);
    // Catches extension-gateway children of a daemon that died without unwinding; they survive in their own process
    // groups, holding connections the restore below would duplicate. A clean shutdown already stopped them.
    await killOrphanServiceProcesses(logger).catch(() => undefined);
};

// Seeds a runner's SANDBOX_DEFINITION_SEED into an empty workspace: repos cloned, connections listed, settings set,
// overlay proposed. Guarded by workspaceArrivedEmpty so a replayed env can never run over real work.
const seedDefinition = async ({ config, logger, services }: BootPhase, runnerEnv: RunnerModeEnv | undefined): Promise<void> => {
    // A prewarmed volume (starter only, nothing the user's) still counts as empty for this gate.
    if (!services.workspaceArrivedEmpty && !(await arrivedPrewarmed(config.workspaceRoot, config.historyRoot))) {
        return;
    }
    try {
        const definition = parseDefinitionToml(Buffer.from(config.sandbox.definitionSeed, "base64").toString("utf8"));
        // On a runner, only `settings` items apply: no owner here to reconnect a capability or fill a secret. Repos
        // arrive separately through the parent's own git sync, carrying exact branches a clone can't.
        const pick = runnerEnv !== undefined ? (item: ArrivalItem): boolean => item.group === "settings" : (): boolean => true;
        const report = await applyDefinitionItems(services, definition, pick);
        logger.info({ report }, "sandbox definition seeded; its needsAction list is the owner's arrival checklist");
    } catch (error) {
        logger.warn({ err: error }, "sandbox definition not seeded, the workspace opens as it arrived");
    }
};

// Converges daemon-owned /work skill files before the baseline commit, so a fresh sandbox reads clean instead of a
// phantom add: the approvals skill (how the agent writes posts and actions for approval) and the baked-tool skills
// named in settings. The owner's own skills are not converged: boot never creates or deletes an owner's file.
const convergeSkills = async ({ logger, services }: BootPhase): Promise<void> => {
    await ensureApprovalsSkill(services).catch((error: unknown) => logger.warn({ err: error }, "approvals skill not converged"));
    try {
        const { settings, unreadable } = await services.sandboxSettings.load();
        // Defaults standing in for a file this build could not read are nobody's choice; acting on them would switch
        // tools the owner never touched.
        if (unreadable) {
            logger.warn("settings.json could not be read by this build, so the baked-tool skills stay as they are");
            return;
        }
        await reconcileBakedSkills(services, settings.skills);
    } catch (error) {
        logger.warn({ err: error }, "skill reconcile failed");
    }
};

// Capability credential values live out of the agent-readable manifest, in a separate store; only a save moves them, so
// an entry connected before the split can still be exposed. Swept before the gate opens; best-effort.
const vaultLooseSecrets = async ({ logger, services }: BootPhase): Promise<void> => {
    const moved = await services.vaultManifestSecrets().catch((error: unknown) => {
        logger.warn({ err: error }, "capability credentials: could not be moved out of the manifest, they stay readable to the agent");
        return [];
    });
    if (moved.length > 0) {
        logger.info({ capabilities: moved }, "capability credentials moved out of the workspace manifest into the private store");
    }
    // Same sweep for extension settings: unlike the manifest, this file is tracked, so an unswept secret would be
    // committed, not just readable.
    const settings = await services.vaultExtensionSettingSecrets().catch((error: unknown) => {
        logger.warn({ err: error }, "extension setting secrets: could not be moved out of the tracked file, they stay readable to the agent");
        return [];
    });
    if (settings.length > 0) {
        logger.info({ extensions: settings }, "extension setting secrets moved out of the tracked settings file into the private store");
    }
    // Masking (agent-redaction.ts) replaces a stored value with its `{{secret:name}}` reference in every tool
    // result, but has a length floor below which a value is silently unmasked. Warned by name here, once per boot.
    const unmaskable = unmaskableSecrets(await services.secretRegistry().catch(() => []));
    if (unmaskable.length > 0) {
        logger.warn(
            { secrets: unmaskable },
            "these stored secrets are too short to mask, so they reach the model in full when something reads them: replace them with longer values",
        );
    }
};

// Copies the starter site on a fresh workspace only, before the baseline commit: the seed's repo must exist first, or
// its files show as a phantom add. A failure just opens the workspace empty.
const seedStarter = async ({ logger, services }: BootPhase): Promise<void> => {
    const outcome = await seedStarterSite(services).catch((error: unknown) => {
        logger.warn({ err: error }, "starter site not seeded, the workspace opens empty");
        return undefined;
    });
    if (outcome === undefined) {
        return;
    }
    if ("repo" in outcome) {
        logger.info({ repo: outcome.repo }, "starter site seeded");
        return;
    }
    // Logged only here (the one boot meant to seed), since the reason for an empty workspace is otherwise
    // unrecoverable.
    logger.info({ why: outcome.skipped }, "starter site not seeded, the workspace opens as it arrived");
};

export const runBootSteps = async (phase: BootPhase, runnerEnv: RunnerModeEnv | undefined): Promise<void> => {
    const { config, logger, traits, role, services } = phase;
    // Every awaited step below runs through this tracker: stamps state and elapsed time, logs slow ones, streams
    // progress to any watching browser. Narrowed to BOOT_STEPS' keys, so an undeclared step is a compile error.
    const boot: BootTracker<(typeof BOOT_STEPS)[number]["key"]> = services.boot;
    // ~/.ssh and ~/.claude are shared by every process in the container; only the daemon that owns it may converge them
    // onto its roots, or a second daemon here would repoint the live daemon's git keys and conversation state.
    const ownsHome = role.container;

    // Enrollments live on /history and outlive the container; authorized_keys (container-local) is rebuilt from the
    // store before sshd serves a reconnect. Ordered before the gate, or enrollments stay valid but unauthorized.
    await boot.step("authorizedKeys", async () => {
        if (!ownsHome) {
            return;
        }
        await restoreAuthorizedKeys(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "authorized_keys not restored, enrolled machines will be refused until they re-enroll"),
        );
    });

    // Claude session state (transcripts, plans, todos) lives under the SDK's ephemeral ~/.claude; converged onto /work
    // before the gate opens so no turn can race it. Awaited: a CLI spawned mid-link would fork the stores.
    await boot.step("claudeState", async () => {
        if (!ownsHome) {
            return;
        }
        await linkClaudeState(services.workspace.root).catch((error: unknown) =>
            logger.warn({ err: error }, "claude session state not persisted, sessions will not survive a rebuild whole"),
        );
    });

    // ssh dir (git-provider keys, capability keys) also lived in ephemeral HOME; pointed at /history before anything
    // reads or writes an alias, or a rebuild silently drops git and ssh access. Awaited for that ordering.
    await boot.step("sshHosts", async () => {
        if (!ownsHome) {
            return;
        }
        await linkSshHosts(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "ssh hosts dir not persisted, git access and ssh aliases will not survive a rebuild"),
        );
    });

    await boot.step("vaultSecrets", () => vaultLooseSecrets(phase));

    // Runs before any step that starts its own process (boot-order.test.ts pins the order).
    await boot.step("staleSessions", async () => (role.container ? sweepStaleSessions(phase) : undefined));

    // Inits the /work repo once, heals the .git pointer, converges excludes; a failure reads as not-fresh, so the
    // baseline commit below is skipped. Local roots are taken as they stand (ensureLocalRootRepo).
    const freshRoot = await boot.step("rootRepo", async () =>
        !role.roots
            ? false
            : (traits.relocateGitDirs
                  ? ensureRootRepo(services.workspace, config.historyRoot, defaultGit, services.workspaceArrivedEmpty)
                  : ensureLocalRootRepo(services.workspace, defaultGit, services.workspaceArrivedEmpty)
              ).catch((error: unknown) => {
                  logger.warn({ err: error }, "root workspace repo not ensured, the Changes review will degrade");
                  return false;
              }),
    );

    await boot.step("starterSite", async () => (role.roots && freshRoot && traits.ownsWorkspaceConfig ? seedStarter(phase) : undefined));

    // Reference shelf dir is furniture like .intentic: its presence on disk is the affordance, since scanners already
    // exclude it. Gated like other config writes: not the daemon's to place in a folder it doesn't own.
    await boot.step("referenceShelf", async () =>
        !role.roots || !traits.ownsWorkspaceConfig
            ? undefined
            : mkdir(join(config.workspaceRoot, REFERENCE_DIR), { recursive: true }).catch((error: unknown) =>
                  logger.warn({ err: error }, "reference shelf not ensured, refs/ drops have no target"),
              ),
    );

    // Sweeps both ends of the portability volume, which a restart invalidates: a half-written export is marked failed
    // instead of a frozen progress bar, and an arrival bundle whose review token died with the process is deleted.
    await boot.step("staleExports", async () =>
        !role.roots
            ? undefined
            : Promise.all([
                  sweepStaleExports(config.historyRoot).catch((error: unknown) =>
                      logger.warn({ err: error }, "stale exports not swept, an interrupted export may still read as packing"),
                  ),
                  sweepArrivals(config.historyRoot).catch((error: unknown) =>
                      logger.warn({ err: error }, "abandoned arrival spools not swept, they hold disk until the next boot"),
                  ),
              ]).then(() => undefined),
    );

    // Moves a repo's git dir out of /work so it resolves identically inside an isolated turn (agents/isolation.ts);
    // runs after rootRepo, before worktrees load. Skipped locally: those repos are the user's own.
    await boot.step("repoGitDirs", async () =>
        role.roots && traits.relocateGitDirs ? ensureRepoGitDirs(services.workspace, config.historyRoot, logger) : undefined,
    );

    await boot.step("definitionSeed", async () =>
        role.roots && traits.ownsWorkspaceConfig && config.sandbox.definitionSeed !== "" ? seedDefinition(phase, runnerEnv) : undefined,
    );

    // Loads persisted conversations and broadcasts the roster, so an /events stream opened mid-boot doesn't see an
    // empty fleet. Awaited (routes assume it's loaded), but a failure just leaves the fleet empty, not the daemon dead.
    await boot.step("agentsRegistry", () =>
        services.agents.init().catch((error: unknown) => logger.warn({ err: error }, "agents registry not initialized, the fleet starts empty")),
    );

    // Gated like other config writes: an unowned folder gets no writes under .agents/skills.
    await boot.step("skills", async () => (role.roots && traits.ownsWorkspaceConfig ? convergeSkills(phase) : undefined));

    // Commits "Initialize workspace" once on a fresh sandbox, after daemon-owned files exist, so Changes starts clean.
    await boot.step("baseline", async () => {
        if (freshRoot) {
            await commitRootBaseline(services.workspace).catch((error: unknown) =>
                logger.warn({ err: error }, "root baseline commit failed, the Changes review will start dirty"),
            );
        }
    });

    // A previous boot's check runs left per-run event files behind (their streams died with the daemon).
    if (role.roots) {
        void rm(checkEventsDir(config.historyRoot), { recursive: true, force: true });
    }

    // vpn CLI reads this to reach the daemon's /vpn routes; written before the restores below need it. Token lives at a
    // fixed container path (/run) for in-container vpn/otp CLIs; a local daemon has neither.
    await boot.step("agentToken", async () => {
        if (!traits.containerCapabilities) {
            return;
        }
        await writeAgentToken(services.agentToken).catch((error: unknown) => services.logger.warn({ err: error }, "agent token: could not write"));
    });
};
