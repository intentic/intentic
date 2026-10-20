import { join } from "node:path";
import type { AuditEvent, AuditStatus } from "@intentic/sandbox-contract/schemas/audit";
import { type AuditSettings, AuditSettingsSchema } from "@intentic/sandbox-contract/schemas/data-protection";
import type { Logger } from "pino";
import type { SecretsSlice } from "../secrets/secrets-slice.js";
import type { SandboxSettingsStore } from "../settings/settings-store.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { drainAuditInbox } from "../auth/host/host-session.js";
import { createAuditForwarder } from "./audit-forward.js";
import { type AuditLog, fileAuditLog } from "./audit-store.js";
import { settingsDiff } from "./settings-diff.js";

// services.audit: the one door every module records through, and what the /audit routes read. `record` is the whole of
// what another module needs:
//
//     services.audit.record({ actor, action: "retention.swept", target: "transcripts", details: { deleted: 12 } });
//
// It returns at once and never throws; the write, the chain and the forward happen behind it. `actor` is
// `actorOfCaller(identity, principal)` for a request (audit-actor.ts), `{ kind: "agent", conversationId }` for an agent's
// own act, `{ kind: "system", reason }` for the sandbox's. Keep `details` to a few facts, never a secret's value.

const HOUR_MS = 3_600_000;
const TICK_MS = 60_000;

// The audit settings the trail last saw in force, kept beside it: settings.json lives in the workspace, where an agent or
// a hand edit can change it without passing a route, so the tick compares and records what changed that way.
export const auditSettingsSeenDocument = defineDocument({
    root: "history",
    path: "audit/settings-seen.json",
    portability: "carry",
    schema: AuditSettingsSchema,
});

export interface AuditService {
    readonly record: (event: AuditEvent) => void;
    // The settings page saved these audit settings itself, and the route's own record says so: the tick need not.
    readonly adoptSettings: (settings: AuditSettings) => Promise<void>;
    // Whether reads are recorded now; read per request, cached for a tick.
    readonly recordsReads: () => boolean;
    readonly log: AuditLog;
    readonly status: () => Promise<AuditStatus>;
    // Prunes, notices outside changes to the audit settings and starts forwarding; then again every minute.
    readonly start: () => void;
    readonly stop: () => void;
    // One tick, for a test or the boot step: what start() repeats.
    readonly tick: () => Promise<void>;
}

export interface AuditServiceDeps {
    readonly historyRoot: string;
    readonly settings: () => Promise<AuditSettings>;
    readonly secretValue: (name: string) => Promise<string | undefined>;
    readonly warn: (message: string, error?: Error) => void;
    readonly fetch?: typeof fetch;
}

export const createAuditService = (deps: AuditServiceDeps): AuditService => {
    const log = fileAuditLog(deps.historyRoot, (message, error) => deps.warn(message, error));
    const forwarder = createAuditForwarder({ ...deps, log, warn: (message) => deps.warn(message) });
    log.onAppend(() => forwarder.kick());
    const seen = openDocument<typeof auditSettingsSeenDocument, AuditSettings | undefined>(
        auditSettingsSeenDocument,
        join(deps.historyRoot, auditSettingsSeenDocument.path),
        { fallback: () => undefined, read: (value) => value },
    );
    let reads = false;
    let lastPrune = 0;
    let timer: NodeJS.Timeout | undefined;

    const noticeOutsideChange = async (current: AuditSettings): Promise<void> => {
        const before = await seen.read();
        if (before === undefined) {
            await seen.update(() => current);
            return;
        }
        const changed = settingsDiff({ audit: before }, { audit: current });
        if (changed.length === 0) {
            return;
        }
        await seen.update(() => current);
        log.record({
            actor: { kind: "system", reason: "settings file" },
            action: "audit.settings.changed_outside",
            target: "settings.audit",
            details: { changed },
        });
    };

    const tick = async (): Promise<void> => {
        const current = await deps.settings();
        reads = current.recordReads;
        await noticeOutsideChange(current);
        // What a verb run inside the container wrote for the trail, which only this process may append to (a sign-in
        // the machine minted: auth/host/host-session.ts).
        await drainAuditInbox(deps.historyRoot, log.record, deps.warn);
        if (Date.now() - lastPrune >= HOUR_MS) {
            lastPrune = Date.now();
            const deleted = await log.prune(current.retentionDays);
            if (deleted.length > 0) {
                log.record({
                    actor: { kind: "system", reason: "retention" },
                    action: "audit.pruned",
                    details: { segments: deleted, retentionDays: current.retentionDays },
                });
            }
        }
        forwarder.kick();
    };

    const safeTick = (): void => {
        tick().catch((error: Error) => deps.warn("audit: the periodic check failed", error));
    };

    return {
        record: log.record,
        adoptSettings: async (settings) => {
            reads = settings.recordReads;
            await seen.update(() => settings);
            forwarder.kick();
        },
        recordsReads: () => reads,
        log,
        status: async () => {
            const [forwarding, oldestAt, segments] = await Promise.all([forwarder.status(), log.oldestAt(), log.segments()]);
            const status: AuditStatus = { segments };
            if (forwarding !== undefined) {
                status.forwarding = forwarding;
            }
            if (oldestAt !== undefined) {
                status.oldestAt = oldestAt;
            }
            return status;
        },
        start: () => {
            safeTick();
            timer = setInterval(safeTick, TICK_MS);
            timer.unref();
        },
        stop: () => {
            if (timer !== undefined) {
                clearInterval(timer);
            }
            forwarder.stop();
        },
        tick,
    };
};

// The service as the daemon composes it: its settings from settings.json, the forward token from the stored secrets
// (read through `secrets` per send, since the secrets are composed beside it).
export const auditServiceOf = (
    historyRoot: string,
    settings: Pick<SandboxSettingsStore, "get">,
    secrets: () => Pick<SecretsSlice, "secretRegistry">,
    logger: Pick<Logger, "warn">,
): AuditService =>
    createAuditService({
        historyRoot,
        settings: async () => (await settings.get()).audit,
        secretValue: async (name) => (await secrets().secretRegistry()).find((secret) => secret.name === name)?.value,
        warn: (message, error) => logger.warn(error === undefined ? {} : { err: error }, message),
    });
