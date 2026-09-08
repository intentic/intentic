import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArrivalHost, ArrivalReport, AssistantSource, Capability, ModelPin } from "@intentic/sandbox-contract";
import { spawnableProviders } from "../agent/subagents/spawn-catalog.js";
import { ENV_FILE } from "@intentic/scaffold";
import { capabilityCtx } from "../capabilities/capability.js";
import { registry } from "../capabilities/registry.js";
import type { Services } from "../composition.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { composeEnvironment } from "../environment/environment.js";
import { upsertEnv } from "../secrets/secrets.routes.js";
import { switchOwnSkill, writeOwnSkill } from "../settings/skills.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import type { Files, SourcePlan } from "./adapter-shared.js";
import { MigrationFormatError, readForeignArchive, rebaseArchive } from "./archive.js";
import { applyMigration, type MigrationDeps, SecretsInactiveError } from "./apply.js";
import { diagnoseArchive } from "./diagnose.js";
import { detectHermes, planHermes } from "./hermes.js";
import { probeHost, scanHost } from "./host-scan.js";
import { detectOpenclaw, planOpenclaw } from "./openclaw.js";

// Recognizes and reads a foreign assistant setup (upload or connected device), translating it; the arrival pipeline
// (portability/arrival.ts) owns holding, tokens, and the report for all sources. A setup lives in memory only, never
// disk (it's a credential store); every item lands through the same write paths ordinary surfaces use.

// One foreign setup, recognized: which tool, its files, what the reader declined. The pipeline holds this and
// re-derives the plan from it at apply.
export interface AssistantSetup {
    readonly source: AssistantSource;
    readonly files: Files;
    readonly skipped: readonly string[];
}

// Source registry: an anchor file marking the home directory, a detect, and a pure planner, per source. First
// recognizing adapter wins; anchors are disjoint today.
const ADAPTERS = [
    { source: "hermes", anchor: "config.yaml", detect: detectHermes, plan: planHermes },
    { source: "openclaw", anchor: "openclaw.json", detect: detectOpenclaw, plan: planOpenclaw },
] as const satisfies readonly {
    source: AssistantSource;
    anchor: string;
    detect: (files: Files) => boolean;
    plan: (files: Files) => SourcePlan;
}[];

// What a reader declined to hold, worded for the plan's refused list.
export const skippedLines = (skipped: readonly string[]): string[] => skipped.map((entry) => `${entry} (not read)`);

// This sandbox's own spendable ladder (spawn-catalog.ts), best-first per connected provider, since the archive can't
// know what's connected. A proposal, not a default: still lands requireApproval; empty just fails the row.
const migratedLadder = async (services: Services): Promise<ModelPin[]> => {
    const providers = await spawnableProviders(services).catch(() => []);
    return providers.flatMap((provider) => {
        const head = provider.models[0];
        return head === undefined ? [] : [{ provider: provider.id, model: head.id }];
    });
};

// Which adapter answers for a map: rebase on each anchor in turn, first recognizing one wins.
const recognize = (raw: Files): { source: AssistantSource; files: Files } | undefined => {
    for (const adapter of ADAPTERS) {
        const files = rebaseArchive(raw, adapter.anchor);
        if (files !== undefined && adapter.detect(files)) {
            return { source: adapter.source, files };
        }
    }
    return undefined;
};

// Derived fresh from the held files each time, so the reviewed plan and the applied plan can't disagree.
export const assistantPlan = (setup: AssistantSetup): SourcePlan =>
    (ADAPTERS.find((adapter) => adapter.source === setup.source) ?? ADAPTERS[0]).plan(setup.files);

// Read a packed home directory off an upload. Bounded and in memory; see archive.ts for both limits.
export const readAssistantArchive = async (body: ReadableStream<Uint8Array>, limit: number): Promise<AssistantSetup> => {
    const archive = await readForeignArchive(body, limit);
    const recognized = recognize(archive.files);
    if (recognized === undefined) {
        // The archive's own contents, not the instruction they already followed, see diagnose.ts.
        throw new MigrationFormatError(diagnoseArchive(archive.files));
    }
    return { source: recognized.source, files: recognized.files, skipped: archive.skipped };
};

const hostCapabilities = async (services: Services): Promise<Extract<Capability, { kind: "host" }>[]> =>
    (await services.capabilities.list()).filter((capability): capability is Extract<Capability, { kind: "host" }> => capability.kind === "host");

// Probes every enrolled machine concurrently; a sleeping laptop costs the render nothing but a row saying so.
export const assistantHosts = async (services: Services): Promise<ArrivalHost[]> =>
    await Promise.all(
        (await hostCapabilities(services)).map(async (capability): Promise<ArrivalHost> => {
            if (!services.hostHub.online(capability.id)) {
                return { id: capability.id, online: false, detail: "asleep or offline right now" };
            }
            const facts = services.hostHub.state(capability.id).facts;
            if (facts === undefined) {
                return { id: capability.id, online: true, detail: "connected, but it has not described itself yet" };
            }
            const found = await probeHost(services.hostHub, capability.id, facts.home).catch(() => undefined);
            return found === undefined
                ? { id: capability.id, online: true, detail: "no Hermes or OpenClaw setup in its home folder" }
                : { id: capability.id, online: true, found };
        }),
    );

// The zero-packing door: the daemon walks the machine's own home folder over the socket it already holds.
export const scanAssistantHost = async (services: Services, hostId: string): Promise<AssistantSetup> => {
    const capability = (await hostCapabilities(services)).find((entry) => entry.id === hostId);
    if (capability === undefined) {
        throw new MigrationFormatError(`"${hostId}" is not one of your connected devices`);
    }
    const facts = services.hostHub.state(hostId).facts;
    if (!services.hostHub.online(hostId) || facts === undefined) {
        throw new MigrationFormatError(`${hostId} is not connected right now: wake it, or pack the folder by hand instead`);
    }
    const found = await probeHost(services.hostHub, hostId, facts.home);
    if (found === undefined) {
        throw new MigrationFormatError(`${hostId} has no Hermes or OpenClaw folder in ${facts.home}`);
    }
    const scan = await scanHost(services.hostHub, hostId, facts.home, found);
    return { source: scan.source, files: scan.files, skipped: scan.skipped };
};

const migrationDeps = (services: Services): MigrationDeps => {
    const workspacePath = (relPath: string): string => {
        const resolved = resolveWithin(services.workspace.root, relPath);
        if (resolved === undefined) {
            throw new Error(`"${relPath}" escapes the workspace`);
        }
        return resolved;
    };
    const ctx = capabilityCtx(services);
    return {
        readWorkspaceFile: (relPath) => services.files.read(workspacePath(relPath)),
        writeWorkspaceFile: (relPath, content) => services.files.write(workspacePath(relPath), content),
        // Same pair the skills route performs (store, then load), so a migrated skill is indistinguishable from one
        // saved by hand. An existing own skill of the same name is overwritten, idempotent across a re-run.
        saveSkill: async (skill) => {
            await writeOwnSkill(services, skill);
            await switchOwnSkill(services, skill, true);
        },
        upsertAutomation: async (automation) => services.automations.upsert({ ...automation, models: await migratedLadder(services) }),
        // Capability route's core sequence (handler apply, then the manifest entry) minus streaming frames; an existing
        // id is refused, never overwritten.
        addCapability: async (capability) => {
            if ((await services.capabilities.get(capability.id)) !== undefined) {
                throw new Error(`a "${capability.id}" connection already exists: rename or remove it first`);
            }
            for await (const line of registry[capability.kind].apply(ctx, capability.id, capability.config)) {
                void line;
            }
            await services.capabilities.upsert(capability);
        },
        // Secrets route's own write, byte for byte: parses and re-serializes into desired-state/.env at mode 0600,
        // gated the same way (no DevOps checkout, no store).
        setSecret: async (key, value) => {
            const desiredState = services.workspace.repos["desired-state"];
            if (!existsSync(desiredState)) {
                throw new SecretsInactiveError();
            }
            const path = join(desiredState, ENV_FILE);
            await mkdir(dirname(path), { recursive: true });
            const existing = await readFile(path, "utf8").catch(() => "");
            await writeFile(path, upsertEnv(existing, key, value), { mode: 0o600 });
        },
    };
};

// Lands the ticked rows of a re-derived plan; the pipeline has already dropped the held setup by now, since a fixable
// failure is about the target (activate DevOps, free disk), not the held bytes.
export const applyAssistantSetup = async (
    services: Services,
    setup: AssistantSetup,
    selection: { readonly items: readonly string[]; readonly includeSecrets: boolean },
): Promise<ArrivalReport> => {
    const report = await applyMigration(migrationDeps(services), assistantPlan(setup), selection);
    // Same convergence the capability-add route runs, once after the loop: folds fragments into the overlay and updates
    // the translator's endpoints. Imported secrets mirror to CI the same fire-and-forget way the secrets route does.
    if (report.applied.some((entry) => entry.group === "capability")) {
        await composeEnvironment(services);
        await syncEndpointCompat(services);
    }
    if (report.applied.some((entry) => entry.group === "secret")) {
        void (async () => {
            for await (const line of services.intentic({ args: ["deploy", "secrets", "push"], cwd: services.workspace.root })) {
                void line;
            }
        })().catch((error: unknown) => services.logger.warn({ err: error }, "secrets push after an assistant arrival failed"));
    }
    services.history.notifyUserWrite();
    return { ...report, refused: [...report.refused, ...skippedLines(setup.skipped)] };
};
