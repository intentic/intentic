import { join } from "node:path";
import type { AuditSettings, AuditStatus } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import type { AuditLog } from "./audit-store.js";

// Sends each audit record, as stored, to the owner's forward address (a SIEM, a log collector): the copy nobody inside
// the sandbox can change. The queue is the trail itself: a cursor names the last record the address accepted, so a
// restart or an outage loses nothing, it only delays. Records go one at a time, oldest first, so the receiver can check
// the chain as they arrive. Appends never wait on any of this.

const ForwardCursorSchema = z.object({
    // The address the cursor belongs to; a new address starts from the records written after it was set.
    url: z.string(),
    // The `at` of the last record the address accepted.
    sentThrough: z.number(),
    lastSentAt: z.number().optional(),
});
type ForwardCursor = z.infer<typeof ForwardCursorSchema>;

export const auditForwardDocument = defineDocument({ root: "history", path: "audit/forward.json", schema: ForwardCursorSchema });

const BATCH = 50;
const FIRST_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 15_000;

export interface AuditForwarderDeps {
    readonly historyRoot: string;
    readonly log: AuditLog;
    readonly settings: () => Promise<AuditSettings>;
    // A stored secret's value by name; undefined when no secret of that name is stored.
    readonly secretValue: (name: string) => Promise<string | undefined>;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly warn: (message: string) => void;
}

export interface AuditForwarder {
    // Sends what is waiting, unless a send is already running or a backoff is pending.
    readonly kick: () => void;
    // Resolves once the current round of sending, if any, has ended.
    readonly settled: () => Promise<void>;
    readonly status: () => Promise<AuditStatus["forwarding"]>;
    readonly stop: () => void;
}

export const backoffMs = (failures: number): number => Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, failures - 1));

export const createAuditForwarder = (deps: AuditForwarderDeps): AuditForwarder => {
    const send = deps.fetch ?? fetch;
    const now = deps.now ?? Date.now;
    const cursorFile = openDocument<typeof auditForwardDocument, ForwardCursor | undefined>(
        auditForwardDocument,
        join(deps.historyRoot, auditForwardDocument.path),
        { fallback: () => undefined, read: (value) => value },
    );
    let running: Promise<void> | undefined;
    let retry: NodeJS.Timeout | undefined;
    let failures = 0;
    let lastError: string | undefined;
    let nextAttemptAt: number | undefined;
    let stopped = false;

    // The cursor for this address: kept when it names it, else started at the newest record already written.
    const cursorFor = async (url: string): Promise<ForwardCursor> => {
        const cursor = await cursorFile.read();
        if (cursor?.url === url) {
            return cursor;
        }
        const fresh = { url, sentThrough: (await deps.log.newestAt()) ?? 0 };
        await cursorFile.update(() => fresh);
        return fresh;
    };

    const headers = async (settings: AuditSettings): Promise<Record<string, string>> => {
        const base = { "content-type": "application/json" };
        if (settings.forwardSecret === "") {
            return base;
        }
        const token = await deps.secretValue(settings.forwardSecret);
        if (token === undefined) {
            throw new Error(`no stored secret is named ${settings.forwardSecret}`);
        }
        return { ...base, authorization: `Bearer ${token}` };
    };

    const deliver = async (url: string, line: string, settings: AuditSettings): Promise<void> => {
        const response = await send(url, { method: "POST", headers: await headers(settings), body: line, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`the forward address answered ${response.status}`);
        }
    };

    // One round: everything waiting, in order, until it is all sent or a send fails.
    const drain = async (): Promise<void> => {
        const settings = await deps.settings();
        if (settings.forwardUrl === "") {
            failures = 0;
            lastError = undefined;
            return;
        }
        let cursor = await cursorFor(settings.forwardUrl);
        for (;;) {
            const batch = await deps.log.after(cursor.sentThrough, BATCH);
            if (batch.length === 0 || stopped) {
                return;
            }
            for (const { record, line } of batch) {
                await deliver(settings.forwardUrl, line, settings);
                cursor = { url: settings.forwardUrl, sentThrough: record.at, lastSentAt: now() };
                const sent = cursor;
                await cursorFile.update(() => sent);
            }
            failures = 0;
            lastError = undefined;
        }
    };

    const schedule = (): void => {
        const delay = backoffMs(failures);
        nextAttemptAt = now() + delay;
        retry = setTimeout(() => {
            retry = undefined;
            nextAttemptAt = undefined;
            kick();
        }, delay);
        retry.unref();
    };

    const kick = (): void => {
        if (running !== undefined || retry !== undefined || stopped) {
            return;
        }
        running = drain()
            .catch((error: Error) => {
                failures += 1;
                lastError = error.message;
                deps.warn(`audit: forwarding failed (${error.message}); trying again in ${Math.round(backoffMs(failures) / 1000)}s`);
                schedule();
            })
            .finally(() => {
                running = undefined;
            });
    };

    return {
        kick,
        settled: async () => {
            await running;
        },
        status: async () => {
            const settings = await deps.settings();
            if (settings.forwardUrl === "") {
                return undefined;
            }
            const cursor = await cursorFile.read();
            const sentThrough = cursor?.url === settings.forwardUrl ? cursor.sentThrough : Number.POSITIVE_INFINITY;
            const pending = Number.isFinite(sentThrough) ? (await deps.log.after(sentThrough, Number.MAX_SAFE_INTEGER)).length : 0;
            const forwarding: NonNullable<AuditStatus["forwarding"]> = { url: settings.forwardUrl, pending };
            if (cursor?.url === settings.forwardUrl && cursor.lastSentAt !== undefined) {
                forwarding.lastSentAt = cursor.lastSentAt;
            }
            if (lastError !== undefined) {
                forwarding.lastError = lastError;
            }
            if (nextAttemptAt !== undefined) {
                forwarding.nextAttemptAt = nextAttemptAt;
            }
            return forwarding;
        },
        stop: () => {
            stopped = true;
            if (retry !== undefined) {
                clearTimeout(retry);
            }
        },
    };
};
