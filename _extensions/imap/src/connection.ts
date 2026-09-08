import type { ConnectorEntry, GatewayCtx, ListenerMessage } from "@intentic/connector-runtime";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { expungeMessage, flagsMessage, htmlText, mailMessage } from "./normalize.js";
import { readWatermark, resumePoint, watermarkPath, writeWatermark } from "./watermark.js";

// One account's ImapFlow lifecycle: connect, watch the mailbox read-only, catch up from the persisted UID watermark,
// then IDLE dispatching message/flags/expunge events. The reconcile loop owns which connections exist; this module owns
// what one connection does.

// Cap on fetched raw MIME per message; attachments come from BODYSTRUCTURE, not the source.
const SOURCE_MAX = 512 * 1024;

export interface ImapConnectorConfig {
    readonly provider: string;
    readonly host: string;
    readonly port: string;
    readonly username: string;
    readonly password: string;
    readonly mailbox?: string;
}
// On catch-up, only the newest of these are delivered; the rest are skipped, still readable via the skill.
export const CATCH_UP_MAX = 50;

export const mailboxOf = (config: ImapConnectorConfig): string => (config.mailbox === undefined || config.mailbox === "" ? "INBOX" : config.mailbox);

// Identity used to detect a config change (reopens the slot) and as the fatal-backoff key (an edit clears backoff
// instantly).
export const configKeyOf = (config: ImapConnectorConfig): string =>
    JSON.stringify([config.host, config.port, config.username, config.password, mailboxOf(config)]);

// Accounts with enough config to attempt a connection.
export const desiredAccounts = (connectors: ReadonlyArray<ConnectorEntry<ImapConnectorConfig>>): ReadonlyArray<ConnectorEntry<ImapConnectorConfig>> =>
    connectors.filter(({ config }) => config.host !== "" && config.username !== "" && config.password !== "");

// Marks a connect failure retries can't fix (bad credential or mailbox); providers can lock an account on repeated
// failed logins.
export class FatalConnectionError extends Error {}

// Client slice one catch-up pass reads, so the pass is testable without a live ImapFlow.
export interface SyncSource {
    readonly search: (range: string) => Promise<number[] | false>;
    readonly fetch: (uid: number) => Promise<FetchMessageObject | false>;
}

export interface SyncOptions {
    readonly capabilityId: string;
    readonly payloadOf: (msg: FetchMessageObject) => Promise<ListenerMessage>;
    readonly dispatch: (payload: ListenerMessage) => Promise<void>;
    readonly save: (lastUid: number) => Promise<void>;
    readonly warn: (fields: object, msg: string) => void;
}

// Delivers everything above the watermark, oldest first, saving the mark after each successful dispatch; a failure
// mid-pass resumes from the failed message next time.
export const syncNewMail = async (source: SyncSource, mark: { lastUid: number }, opts: SyncOptions): Promise<void> => {
    const found = await source.search(`${mark.lastUid + 1}:*`);
    if (found === false) {
        return;
    }
    // `N:*` matches the highest-UID message even when N exceeds it (RFC 3501); drop already-seen uids.
    let pending = found.filter((uid) => uid > mark.lastUid).toSorted((a, b) => a - b);
    if (pending.length > CATCH_UP_MAX) {
        opts.warn({ capabilityId: opts.capabilityId, skipped: pending.length - CATCH_UP_MAX }, "imap catch-up capped to the newest messages");
        pending = pending.slice(-CATCH_UP_MAX);
    }
    for (const uid of pending) {
        const msg = await source.fetch(uid);
        if (msg === false) {
            // Expunged between search and fetch; nothing to deliver, but later uids still advance the mark.
            continue;
        }
        await opts.dispatch(await opts.payloadOf(msg));
        mark.lastUid = Math.max(mark.lastUid, msg.uid);
        await opts.save(mark.lastUid);
    }
};

export interface ImapConnection {
    readonly usable: () => boolean;
    readonly stop: () => Promise<void>;
}

// Best-effort text: mailparser's plain text, then stripped html, else undefined; a body that fails to parse must not
// fail the sync.
const textOf = async (source: Buffer | undefined): Promise<string | undefined> => {
    if (source === undefined) {
        return undefined;
    }
    try {
        const parsed = await simpleParser(source);
        if (parsed.text !== undefined && parsed.text !== "") {
            return parsed.text;
        }
        return typeof parsed.html === "string" && parsed.html !== "" ? htmlText(parsed.html) : undefined;
    } catch {
        return undefined;
    }
};

export const openImapConnection = async (
    ctx: GatewayCtx,
    capabilityId: string,
    config: ImapConnectorConfig,
    hooks: { readonly onClose: () => void },
): Promise<ImapConnection> => {
    const mailbox = mailboxOf(config);
    const port = Number(config.port) || 993;
    const client = new ImapFlow({
        host: config.host,
        port,
        // 993 implies implicit TLS; other ports start plain and upgrade via STARTTLS if offered.
        secure: port === 993,
        auth: { user: config.username, pass: config.password },
        logger: false,
        // Re-issues IDLE every 5 min, under RFC's 29-min cap; also surfaces a dead connection as a close event.
        maxIdleTime: 5 * 60_000,
        connectionTimeout: 30_000,
    });
    let stopping = false;
    client.on("error", (error) => ctx.log.warn({ err: error, capabilityId }, "imap connection error"));
    try {
        await client.connect();
    } catch (error) {
        if ((error as { authenticationFailed?: boolean }).authenticationFailed === true) {
            throw new FatalConnectionError(
                `IMAP login failed for ${config.username} at ${config.host}: check the username/password (Gmail and Outlook need an app password, not the account password)`,
            );
        }
        throw error;
    }
    let box;
    try {
        // Read-only EXAMINE: watching must never mutate the mailbox (no \Seen from the gateway's fetches).
        box = await client.mailboxOpen(mailbox, { readOnly: true });
    } catch (error) {
        ctx.log.error({ err: error, capabilityId }, "imap mailbox open failed");
        await client.logout().catch(() => undefined);
        throw new FatalConnectionError(`IMAP mailbox "${mailbox}" can't be opened on ${config.host}: check the Watched mailbox field`);
    }

    const uidValidity = String(box.uidValidity);
    const path = watermarkPath(ctx.workspaceRoot, capabilityId);
    const point = resumePoint(await readWatermark(path), { mailbox, uidValidity, uidNext: box.uidNext });
    const mark = { lastUid: point.lastUid };
    if (point.baselined) {
        // New mailbox generation (add, folder change, UIDVALIDITY reset): baseline now, dispatch nothing from history.
        await writeWatermark(path, { mailbox, uidValidity, lastUid: mark.lastUid });
    }

    const dispatchNew = (): Promise<void> =>
        syncNewMail(
            {
                search: (range) => client.search({ uid: range }, { uid: true }),
                fetch: (uid) =>
                    client.fetchOne(
                        uid,
                        { uid: true, envelope: true, internalDate: true, bodyStructure: true, source: { maxLength: SOURCE_MAX } },
                        { uid: true },
                    ),
            },
            mark,
            {
                capabilityId,
                payloadOf: async (msg) =>
                    mailMessage({
                        capabilityId,
                        username: config.username,
                        mailbox,
                        uidValidity,
                        uid: msg.uid,
                        envelope: msg.envelope,
                        internalDate: msg.internalDate instanceof Date ? msg.internalDate : undefined,
                        bodyStructure: msg.bodyStructure,
                        text: await textOf(msg.source),
                    }),
                dispatch: ctx.daemon.dispatch,
                // Persists per message; a crash mid-catch-up re-delivers at most the in-flight message.
                save: (lastUid) => writeWatermark(path, { mailbox, uidValidity, lastUid }),
                warn: ctx.log.warn,
            },
        );

    // Catch-up runs are serialized: an `exists` burst during a run queues exactly one rerun; a failed run leaves the
    // watermark for the next event or reconnect to retry.
    const sync = { running: false, queued: false };
    const runSync = (): void => {
        if (sync.running) {
            sync.queued = true;
            return;
        }
        sync.running = true;
        void (async () => {
            try {
                do {
                    sync.queued = false;
                    await dispatchNew();
                } while (sync.queued);
            } catch (error) {
                ctx.log.warn({ err: error, capabilityId }, "imap catch-up failed");
            } finally {
                sync.running = false;
            }
        })();
    };

    client.on("exists", () => runSync());
    client.on("flags", (event) => {
        void ctx.daemon
            .dispatch(
                flagsMessage({
                    capabilityId,
                    username: config.username,
                    mailbox,
                    uidValidity,
                    seq: event.seq,
                    uid: event.uid,
                    flags: [...event.flags],
                }),
            )
            .catch((error: unknown) => ctx.log.warn({ err: error, capabilityId }, "imap flags dispatch failed"));
    });
    client.on("expunge", (event) => {
        void ctx.daemon
            .dispatch(
                expungeMessage({
                    capabilityId,
                    username: config.username,
                    mailbox,
                    uidValidity,
                    seq: event.seq,
                    uid: event.uid,
                    vanished: event.vanished,
                }),
            )
            .catch((error: unknown) => ctx.log.warn({ err: error, capabilityId }, "imap expunge dispatch failed"));
    });
    client.on("close", () => {
        if (!stopping) {
            hooks.onClose();
        }
    });

    // Unconditional first pass covers the resume backlog and any mail that raced in before the listeners attached.
    runSync();

    return {
        usable: () => client.usable,
        stop: async () => {
            stopping = true;
            await client.logout().catch(() => undefined);
        },
    };
};
