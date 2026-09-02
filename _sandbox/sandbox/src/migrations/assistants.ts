import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArrivalHost, ArrivalReport, AssistantSource, Capability } from "@intentic/sandbox-contract";
import { ENV_FILE } from "@intentic/scaffold";
import { capabilityCtx } from "../capabilities/capability.js";
import { registry } from "../capabilities/registry.js";
import type { Services } from "../composition.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { composeEnvironment } from "../environment/environment.js";
import { upsertEnv } from "../secrets/secrets.routes.js";
import { reconcileSkills, writeOwnSkill } from "../settings/skills.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import type { Files, SourcePlan } from "./adapter-shared.js";
import { MigrationFormatError, readForeignArchive, rebaseArchive } from "./archive.js";
import { applyMigration, type MigrationDeps, SecretsInactiveError } from "./apply.js";
import { diagnoseArchive } from "./diagnose.js";
import { detectHermes, planHermes } from "./hermes.js";
import { probeHost, scanHost } from "./host-scan.js";
import { detectOpenclaw, planOpenclaw } from "./openclaw.js";

/* THE TWO FOREIGN SOURCES an arrival can come from, as a PARSER rather than a surface of its own.
 *
 * This file used to hold a whole import feature: its own held upload, its own token, its own plan/apply pair
 * and its own routes, beside two other features doing the same four things to different artifacts. What is
 * left here is only the part that is particular to a foreign assistant — recognizing one, reading it off an
 * upload or straight off a connected computer, translating it, and writing it through native paths. The
 * holding, the token, the ticked ids and the report belong to the arrival pipeline
 * (portability/arrival.ts), which does them once for all four sources.
 *
 * WHAT MUST NOT BE LOST IN THE MOVE, and is not:
 *
 * A SETUP IS HELD IN MEMORY, NEVER ON DISK. The upload is a credential store (an .env, an auth.json), so it
 * lives in the pipeline's pending object until the apply consumes it, the abandon drops it, or the daemon
 * restarts (in which case the owner re-reads; a plan costs seconds). The pipeline spools a BUNDLE to disk
 * because a bundle is too large to hold — it deliberately does not spool these.
 *
 * NOTHING FOREIGN IS EXECUTED OR COPIED VERBATIM into daemon state; every item lands through the same write
 * paths the settings/skills/automations/capabilities surfaces use, which is what keeps an imported setup
 * editable and deletable in the ordinary UI the day after (docs/assistant-import-design.md). */

/* One foreign setup, read and recognized: which tool laid it out, its files, and what the reader declined to
 * hold. The pipeline holds THIS, and re-derives the plan from it at apply. */
export interface AssistantSetup {
    readonly source: AssistantSource;
    readonly files: Files;
    readonly skipped: readonly string[];
}

/* The source registry: an anchor file that proves where the home directory starts, a detect that says "this is
 * mine", and the pure planner. Order matters only in that the first recognizing adapter wins, the anchors are
 * disjoint today, and a future archive that somehow carries both is answered by whichever is listed first. */
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

// The translated checklist, derived fresh from the held files every time, so the plan the owner reviewed and
// the plan the apply honors cannot disagree.
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

/* Every enrolled machine with a one-call probe each, run concurrently: the card renders this before the owner
 * has read anything, so a sleeping laptop must cost the render nothing but a row that says so. */
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
        throw new MigrationFormatError(`"${hostId}" is not one of your connected computers`);
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
        // The same trio the skills route performs, in the same order, text, enabled list, reconcile, so a
        // migrated skill is indistinguishable from one saved on the Skills page. The adapter already renamed
        // around baked names; an existing OWN skill of the same name is overwritten, which is the upsert the
        // route itself performs and is idempotent across a re-run.
        saveSkill: async (skill) => {
            await writeOwnSkill(services, skill);
            const settings = await services.sandboxSettings.get();
            const skills = settings.skills.includes(skill.name) ? settings.skills : [...settings.skills, skill.name];
            await services.sandboxSettings.set({ ...settings, skills });
            await reconcileSkills(services, skills);
        },
        upsertAutomation: (automation) => services.automations.upsert(automation),
        // The capability route's core sequence (handler apply, then the manifest entry), minus its streaming
        // frames. Existing ids are refused, a foreign setup lands beside nothing, never over something.
        addCapability: async (capability) => {
            if ((await services.capabilities.get(capability.id)) !== undefined) {
                throw new Error(`a "${capability.id}" connection already exists: rename or remove it first`);
            }
            for await (const line of registry[capability.kind].apply(ctx, capability.id, capability.config)) {
                void line;
            }
            await services.capabilities.upsert(capability);
        },
        // The secrets route's own write, byte for byte: parse/re-serialize round-trip into desired-state/.env,
        // mode 0600. Gated the same way too, no DevOps checkout, no env store.
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

/* Land the ticked rows of a re-derived plan. The pipeline has already dropped the held setup by the time this
 * returns: the failures a re-run can fix are about the TARGET (activate DevOps, free disk), not about the held
 * bytes, and holding a credential store past its use would be a lifetime somebody has to remember. */
export const applyAssistantSetup = async (
    services: Services,
    setup: AssistantSetup,
    selection: { readonly items: readonly string[]; readonly includeSecrets: boolean },
): Promise<ArrivalReport> => {
    const report = await applyMigration(migrationDeps(services), assistantPlan(setup), selection);
    /* The same convergence the capability add route runs, once, after the loop: fold any fragments into the
     * composed overlay and teach the translator about new endpoints. Imported env secrets mirror to CI the way
     * the secrets route mirrors them, fire and forget, warn on failure. */
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
