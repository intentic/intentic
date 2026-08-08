import type { ConnectorEntry, GatewayCtx, ListenerMessage } from "@intentic/connector-runtime";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { expungeMessage, flagsMessage, htmlText, mailMessage } from "./normalize.js";
import { readWatermark, resumePoint, watermarkPath, writeWatermark } from "./watermark.js";

// One account's ImapFlow lifecycle: connect, open the watched mailbox read-only, catch up from the persisted
// UID watermark, then sit in IDLE dispatching message/flags/expunge events at the daemon. The gateway's
// reconcile loop owns *which* connections exist; this module owns what one connection does.

// Cap on the fetched raw MIME per message: enough for headers + the text parts of real mail, small enough
// that a 40MB attachment mail costs nothing (attachments are listed from BODYSTRUCTURE, not the source).
const SOURCE_MAX = 512 * 1024;

export interface ImapConnectorConfig {
    readonly provider: string;
    readonly host: string;
    readonly port: string;
    readonly username: string;
    readonly password: string;
    readonly mailbox?: string;
}
// A long outage on a busy inbox must not fetch a thousand bodies on reconnect: deliver the newest batch,
// advance the watermark past the rest (logged) — the agent can still read the skipped ones over the skill.
export const CATCH_UP_MAX = 50;

export const mailboxOf = (config: ImapConnectorConfig): string => (config.mailbox === undefined || config.mailbox === "" ? "INBOX" : config.mailbox);

// The connection identity: the reconcile loop stops and reopens a slot whose serialized config changed, so an
// edited password or watched mailbox reconnects within one tick. Also the fatal-backoff key — an edited
// config clears its own backoff instantly (the discord gateway's by-token behavior).
export const configKeyOf = (config: ImapConnectorConfig): string =>
    JSON.stringify([config.host, config.port, config.username, config.password, mailboxOf(config)]);

// The accounts with enough config to try connecting (the shell already gates on an enabled imap listener
// automation existing — no automations ⇒ it asks for nothing).
export const desiredAccounts = (connectors: ReadonlyArray<ConnectorEntry<ImapConnectorConfig>>): ReadonlyArray<ConnectorEntry<ImapConnectorConfig>> =>
    connectors.filter(({ config }) => config.host !== "" && config.username !== "" && config.password !== "");

// A connect failure the reconcile backoff treats as fatal (bad credential / bad mailbox): retrying every tick
// can't help until the owner fixes the config, and providers lock accounts on repeated failed logins.
export class FatalConnectionError extends Error {}

// The client slice one catch-up pass reads — a seam so the pass is testable without a live ImapFlow.
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

// One catch-up pass: everything above the watermark, oldest first, advancing (and persisting) the mark only
// after each successful dispatch — a failure mid-pass aborts and the next event or reconnect retries from the
// exact message that failed.
export const syncNewMail = async (source: SyncSource, mark: { lastUid: number }, opts: SyncOptions): Promise<void> => {
    const found = await source.search(`${mark.lastUid + 1}:*`);
    if (found === false) {
        return;
    }
    // `N:*` always matches the highest-UID message even when N exceeds it (RFC 3501) — drop seen uids.
    let pending = found.filter((uid) => uid > mark.lastUid).toSorted((a, b) => a - b);
    if (pending.length > CATCH_UP_MAX) {
        opts.warn({ capabilityId: opts.capabilityId, skipped: pending.length - CATCH_UP_MAX }, "imap catch-up capped to the newest messages");
        pending = pending.slice(-CATCH_UP_MAX);
    }
    for (const uid of pending) {
        const msg = await source.fetch(uid);
        if (msg === false) {
            // Expunged between search and fetch — nothing to deliver; later uids still advance the mark.
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

// Best-effort text of the (size-capped) raw MIME: mailparser's plain text, then stripped html, then nothing —
// truncated MIME can fail to parse, and an unreadable body must degrade to envelope-only content, not fail.
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
        // Implicit TLS is universally the 993 convention; any other port starts plain and imapflow upgrades
        // over STARTTLS when the server offers it — which also lets dev/test servers on odd ports connect.
        secure: port === 993,
        auth: { user: config.username, pass: config.password },
        logger: false,
        // Break + re-issue IDLE every 5 min: well under the RFC 29-minute cap, and doubles as a dead-NAT
        // detector (the break surfaces a socket error on a gone connection, which lands on "close" and the
        // reconcile tick reconnects). Servers without IDLE degrade to imapflow's NOOP poll on this cadence.
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
                `IMAP login failed for ${config.username} at ${config.host} — check the username/password (Gmail and Outlook need an app password, not the account password)`,
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
        throw new FatalConnectionError(`IMAP mailbox "${mailbox}" can't be opened on ${config.host} — check the Watched mailbox field`);
    }

    const uidValidity = String(box.uidValidity);
    const path = watermarkPath(ctx.workspaceRoot, capabilityId);
    const point = resumePoint(await readWatermark(path), { mailbox, uidValidity, uidNext: box.uidNext });
    const mark = { lastUid: point.lastUid };
    if (point.baselined) {
        // First watch of this mailbox generation (fresh add, folder change, or a UIDVALIDITY reset): record
        // the current end and dispatch nothing — the agent reacts to mail from now on, never to history.
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
                // Persist per message, not per batch: a crash mid-catch-up re-delivers at most the in-flight
                // message (ids are stable, so a prompt can even dedupe that).
                save: (lastUid) => writeWatermark(path, { mailbox, uidValidity, lastUid }),
                warn: ctx.log.warn,
            },
        );

    // Catch-up runs are serialized: an `exists` burst during a pass queues exactly one rerun, and a failed
    // pass (network, daemon down) leaves the watermark where it was — the next event or reconnect retries.
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

    // Unconditional first pass: covers both the resume backlog and any mail that raced in between mailboxOpen
    // and the listeners attaching (its uid is above the mark either way).
    runSync();

    return {
        usable: () => client.usable,
        stop: async () => {
            stopping = true;
            await client.logout().catch(() => undefined);
        },
    };
};
