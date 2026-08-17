import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type MigrationApply, type MigrationPlan, type MigrationReport } from "@intentic/sandbox-contract";
import { ENV_FILE } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { capabilityCtx } from "../capabilities/capability.js";
import { registry } from "../capabilities/registry.js";
import { composeEnvironment } from "../environment/environment.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { upsertEnv } from "../secrets/secrets.routes.js";
import { reconcileSkills, writeOwnSkill } from "../settings/skills.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { type Files, type SourcePlan } from "./adapter-shared.js";
import { MigrationFormatError, readForeignArchive, rebaseArchive } from "./archive.js";
import { applyMigration, type MigrationDeps, SecretsInactiveError } from "./apply.js";
import { detectHermes, planHermes } from "./hermes.js";
import { detectOpenclaw, planOpenclaw } from "./openclaw.js";

/* THE MIGRATION SURFACE'S COMPOSITION — the held upload, the plan/apply pair the routes call, and the six-
 * function deps object that is everything a migration may write through.
 *
 * ONE PENDING MIGRATION AT A TIME, HELD IN MEMORY. The upload is a credential store (an .env, an auth.json),
 * so it never touches /work or /history — it lives in this object until the apply consumes it, the DELETE
 * abandons it, or the daemon restarts (in which case the owner re-uploads; a plan costs seconds). A second
 * upload replaces the first: the owner changing their mind is the ordinary case, not a conflict.
 *
 * THE APPLY RE-DERIVES THE PLAN from the held files and honors the ticked ids against THAT — the wire plan the
 * browser rendered is never the input a write trusts (portability/restore.ts's rule, kept). Deterministic item
 * ids are what make the two derivations name the same things. */

interface PendingMigration {
    readonly token: string;
    readonly source: MigrationPlan["source"];
    readonly files: Files;
    readonly skipped: readonly string[];
}

/* The source registry: an anchor file that proves where the home directory starts, a detect that says "this is
 * mine", and the pure planner. Order matters only in that the first recognizing adapter wins — the anchors are
 * disjoint today, and a future archive that somehow carries both is answered by whichever is listed first. */
const ADAPTERS = [
    { source: "hermes", anchor: "config.yaml", detect: detectHermes, plan: planHermes },
    { source: "openclaw", anchor: "openclaw.json", detect: detectOpenclaw, plan: planOpenclaw },
] as const satisfies readonly {
    source: MigrationPlan["source"];
    anchor: string;
    detect: (files: Files) => boolean;
    plan: (files: Files) => SourcePlan;
}[];

export const PACK_HINTS = ["tar czf hermes-setup.tar.gz -C ~ .hermes", "tar czf openclaw-setup.tar.gz -C ~ .openclaw"] as const;

export interface Migrations {
    readonly plan: (body: ReadableStream<Uint8Array>, limit: number) => Promise<MigrationPlan>;
    readonly apply: (input: MigrationApply) => Promise<MigrationReport>;
    readonly abandon: () => boolean;
}

// What the archive reader declined to hold, worded for the plan's refused list.
const skippedLines = (skipped: readonly string[]): string[] => skipped.map((entry) => `${entry} (not read from the archive)`);

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
        // The same trio the skills route performs, in the same order — text, enabled list, reconcile — so a
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
        // frames. Existing ids are refused — a migration lands beside nothing, never over something.
        addCapability: async (capability) => {
            if ((await services.capabilities.get(capability.id)) !== undefined) {
                throw new Error(`a "${capability.id}" connection already exists — rename or remove it first`);
            }
            for await (const line of registry[capability.kind].apply(ctx, capability.id, capability.config)) {
                void line;
            }
            await services.capabilities.upsert(capability);
        },
        // The secrets route's own write, byte for byte: parse/re-serialize round-trip into desired-state/.env,
        // mode 0600. Gated the same way too — no DevOps checkout, no env store.
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

// Which adapter answers for a map: rebase on each anchor in turn, first recognizing one wins.
const recognize = (raw: Files): { source: MigrationPlan["source"]; files: Files; plan: (files: Files) => SourcePlan } | undefined => {
    for (const adapter of ADAPTERS) {
        const files = rebaseArchive(raw, adapter.anchor);
        if (files !== undefined && adapter.detect(files)) {
            return { source: adapter.source, files, plan: adapter.plan };
        }
    }
    return undefined;
};

const planOf = (source: MigrationPlan["source"], files: Files): SourcePlan =>
    (ADAPTERS.find((adapter) => adapter.source === source) ?? ADAPTERS[0]).plan(files);

export const createMigrations = (services: Services): Migrations => {
    let pending: PendingMigration | undefined;

    return {
        plan: async (body, limit) => {
            const archive = await readForeignArchive(body, limit);
            const recognized = recognize(archive.files);
            if (recognized === undefined) {
                throw new MigrationFormatError(
                    `this does not look like a Hermes or OpenClaw home directory — pack one with \`${PACK_HINTS.join("` or `")}\` and upload that`,
                );
            }
            const source = recognized.plan(recognized.files);
            pending = { token: randomUUID(), source: recognized.source, files: recognized.files, skipped: archive.skipped };
            return {
                source: recognized.source,
                token: pending.token,
                items: source.planned.map((planned) => planned.item),
                refused: [...source.refused, ...skippedLines(archive.skipped)],
                needsAction: [...source.needsAction],
            };
        },
        apply: async (input) => {
            if (pending === undefined || pending.token !== input.token) {
                throw new MigrationFormatError("no held upload matches that plan — upload the archive again and re-review");
            }
            const held = pending;
            const report = await applyMigration(migrationDeps(services), planOf(held.source, held.files), {
                items: input.items,
                includeSecrets: input.includeSecrets,
            });
            // Consumed on the way out whatever happened item-by-item: the failures a re-run can fix are about
            // the TARGET (activate DevOps, free disk), not about the held bytes, and holding a credential store
            // past its use would be a lifetime somebody has to remember.
            pending = undefined;
            /* The same convergence the capability add route runs, once, after the loop: fold any fragments into
             * the composed overlay and teach the translator about new endpoints. Imported env secrets mirror to
             * CI the way the secrets route mirrors them — fire and forget, warn on failure. */
            if (report.applied.some((entry) => entry.target === "capability")) {
                await composeEnvironment(services);
                await syncEndpointCompat(services);
            }
            if (report.applied.some((entry) => entry.target === "secret")) {
                void (async () => {
                    for await (const line of services.intentic({ args: ["deploy", "secrets", "push"], cwd: services.workspace.root })) {
                        void line;
                    }
                })().catch((error: unknown) => services.logger.warn({ err: error }, "secrets push after migration failed"));
            }
            services.history.notifyUserWrite();
            return report;
        },
        abandon: () => {
            const had = pending !== undefined;
            pending = undefined;
            return had;
        },
    };
};
