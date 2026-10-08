import { setTimeout as sleep } from "node:timers/promises";
import { createBackoff } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { HOST_HEARTBEAT_MS, hostConnectUrl, type DeviceScopes } from "@intentic/sandbox-contract";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { type DaemonBase, resolveDaemonBase } from "../daemon-base.js";
import { answeredGone, GONE_RECHECK_MS, GONE_RETIRE_MS } from "../sync/gone.js";
import { type HostLink, readDeviceConfig, rememberScopes, removeLinks, writeDeviceConfig } from "./config.js";
import { type Indicator, machineIndicator } from "./indicator.js";
import { createHostRouter } from "./router.js";

// This device's one instance of sandbox-contract's peer-dial (the socket, handler-before-hello, backoff, the
// 1008 rule). What's local: WHERE it dials, resolved per attempt (../daemon-base.ts) so a sandbox on this
// machine's own loopback is reached even when its public tunnel is down, and what it serves.

// The two things between this agent and the network, injectable together: where the daemon is, and the socket
// that answer is handed to. Production wires the real resolver and the runtime's own WebSocket.
export interface Dial {
    readonly resolveBase: (sandboxUrl: string) => Promise<DaemonBase>;
    readonly socket: (url: string) => WebSocket;
    // Whether the platform's edge says this sandbox no longer exists (`probeEdge`); absent in a test that never asks.
    readonly gone?: (sandboxUrl: string) => Promise<boolean>;
}

/* A LINK TO A SANDBOX THAT NO LONGER EXISTS STOPS DIALLING IT (2026-10-05). The dial loop never gives a link up but on
   1008, which only a sandbox that is up can send; a deleted sandbox answers every dial with the edge's 502, which a
   WebSocket cannot read the headers of, so one PC sat on "disconnected (1002); 51 failed attempts, retrying every 900s"
   for every sandbox it ever linked. After GONE_PROBE_AFTER_ATTEMPTS failed dials in a row, each next attempt first asks
   the sandbox's address with a plain HTTPS GET, which can read the edge's verdict (`x-intentic-edge`). On its final word
   (`unknown-sandbox`) the link stops dialling and is marked gone in device.json; it is asked again every hour, an answer
   brings it back at once, and past the trash window (the week a removed sandbox can still be restored, sync/gone.ts) it
   is forgotten, as a 1008 forgets it. Connecting the sandbox again replaces the link, and the mark with it. */
export const GONE_PROBE_AFTER_ATTEMPTS = 6;

// Bounded like any request the agent makes: the edge answers its own errors at once.
const PROBE_TIMEOUT_MS = 10_000;

// The edge's word on a sandbox's address, by a plain GET of `/health`: true only for its final verdict. Every other
// answer, a network error included, says nothing.
export const probeEdge = async (sandboxUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> => {
    try {
        return answeredGone(await fetchImpl(`${sandboxUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }));
    } catch {
        // allow(silent-catch): a probe that could not be made is no verdict, which is what it returns
        return false;
    }
};

const realDial: Dial = {
    resolveBase: resolveDaemonBase,
    socket: (url) => new WebSocket(url),
    gone: async (sandboxUrl) => await probeEdge(sandboxUrl),
};

// A link as device.json may hold it: its enrollment, and since when its sandbox has been said to be gone.
export type MarkedLink = HostLink & { readonly goneSince?: number };

// Where that mark is kept. On the link's own entry, matched by address AND token, so a link connected again (a new
// token, `upsertLink`) never inherits it; every other writer of the file spreads the entry, so the mark survives them.
export interface LinkGoneStore {
    readonly mark: (link: HostLink, since: number | undefined) => Promise<void>;
}

const fileGoneStore: LinkGoneStore = {
    mark: async (link, since) => {
        const config = await readDeviceConfig();
        await writeDeviceConfig({
            ...config,
            links: config.links.map((held) => {
                if (held.sandboxUrl !== link.sandboxUrl || held.token !== link.token) {
                    return held;
                }
                // SAFETY: a link this file holds is a HostLink with, at most, the mark this store itself wrote beside it.
                const { goneSince: _was, ...rest } = held as MarkedLink;
                return since === undefined ? rest : { ...rest, goneSince: since };
            }),
        });
    },
};

// What a link said to be gone does next, given whether the edge still says so now: dial again (it answered), forget it
// (still gone past the trash window), or wait for the next hourly look. Pure, so the window is a rule with a test.
export const goneLinkStep = (goneSince: number, now: number, stillGone: boolean): "dial" | "forget" | "wait" => {
    if (!stillGone) {
        return "dial";
    }
    return now - goneSince >= GONE_RETIRE_MS ? "forget" : "wait";
};

// Whether this attempt asks the edge first: only once the link has failed enough dials in a row that "restarting" has
// stopped being the likely reading.
export const probesFirst = (attempt: number): boolean => attempt > GONE_PROBE_AFTER_ATTEMPTS;

// The links this process has reached over this machine's loopback, by sandbox URL: a daemon that answered /health there
// as this sandbox runs on this machine. Kept for the process's life, since the keeper (sandbox-rounds/keeper.ts) needs it
// most once that address has stopped answering.
const loopbackUrls = new Set<string>();
export const reachedOverLoopback: ReadonlySet<string> = loopbackUrls;

// What a revoked link is dropped with; the resident's next pass then closes nothing more, since the loop already ended.
const forgetLink = async (sandboxUrl: string): Promise<void> => void (await removeLinks(sandboxUrl));

export const connect = (
    config: HostLink,
    version: string,
    log: Log,
    dial: Dial = realDial,
    forget = forgetLink,
    indicator: Indicator = machineIndicator(),
    goneStore: LinkGoneStore = fileGoneStore,
    now: () => number = Date.now,
): PeerLink => {
    // Every line this link writes names the sandbox it is about. One agent holds a link per sandbox and the dial
    // agent's own complaints carry no address, so a machine with five links wrote "disconnected (1002); 7172 failed
    // attempts" for two days without ever saying whose — and nothing in the log could tell the dead ones apart.
    const linkLog: Log = (message) => log(`${config.sandboxUrl}: ${message}`);
    // The live grant, replaced by the sandbox's `setScopes` on every connect, so a scope turned off is enforced
    // from the new session's first call.
    let scopes: DeviceScopes = config.scopes;
    // The socket this link is on now.
    let held: WebSocket | undefined;
    // Attempts since the socket last opened, and since when the sandbox has been said to be gone (from device.json at
    // start, so an agent restarted mid-way keeps the clock).
    let attempts = 0;
    // SAFETY: the resident hands over the link as device.json holds it, which carries this mark when the store wrote one.
    let goneSince = (config as MarkedLink).goneSince;
    // A link said to be gone dials nothing: it asks the edge, now and then every hour, until the sandbox answers (dial
    // again) or the trash window has passed (forget the link, and end the loop). Answers whether to dial.
    const whileGone = async (signal: AbortSignal): Promise<boolean> => {
        while (goneSince !== undefined && !signal.aborted) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one look an hour, by design
            const step = goneLinkStep(goneSince, now(), (await dial.gone?.(config.sandboxUrl)) === true);
            if (step === "dial") {
                goneSince = undefined;
                attempts = 0;
                linkLog("answers again, so it is not gone after all: dialling it again.");
                // oxlint-disable-next-line eslint/no-await-in-loop -- once, as the loop ends
                await goneStore.mark(config, undefined).catch((error: unknown) => linkLog(`could not clear its gone mark (${errorMessage(error)})`));
                return true;
            }
            if (step === "forget") {
                linkLog(
                    "the platform still says this sandbox no longer exists, a week on: this link is forgotten. Connect again from the sandbox to restore it.",
                );
                // oxlint-disable-next-line eslint/no-await-in-loop -- once, as the loop ends
                await forget(config.sandboxUrl).catch((error: unknown) => linkLog(`could not drop the link (${String(error)})`));
                return false;
            }
            // allow(silent-catch): the sleep only rejects with the AbortError of `signal`, which the loop and the return read as signal.aborted.
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await sleep(GONE_RECHECK_MS, undefined, { signal }).catch(() => undefined);
        }
        return !signal.aborted;
    };
    // Asked before a dial that follows enough failed ones: the edge's final verdict marks the link gone (said once,
    // with the day it will be forgotten), and the link then waits in `whileGone` rather than dialling.
    const askEdgeFirst = async (): Promise<void> => {
        attempts += 1;
        if (goneSince !== undefined || !probesFirst(attempts) || (await dial.gone?.(config.sandboxUrl)) !== true) {
            return;
        }
        goneSince = now();
        const untilUtcDay = new Date(goneSince + GONE_RETIRE_MS).toISOString().slice(0, 10);
        linkLog(
            `the platform says this sandbox no longer exists, so this link stops dialling it after ${attempts - 1} failed attempts. It is asked again every hour, and forgotten on ${untilUtcDay} unless it answers; connecting again from the sandbox restores it before then.`,
        );
        await goneStore.mark(config, goneSince).catch((error: unknown) => linkLog(`could not record that it is gone (${errorMessage(error)})`));
    };
    const handler = new RPCHandler(
        createHostRouter({
            sandboxUrl: config.sandboxUrl,
            scopes: () => scopes,
            setScopes: (next) => {
                scopes = next;
                // The persistence for this link's cache alone, written by the connection, which owns the link's entry
                // in the file. Unawaited: the live grant above already enforces.
                void rememberScopes(config.sandboxUrl, next).catch((error: unknown) =>
                    linkLog(`could not save the permissions it pushed (${errorMessage(error)}); this connection enforces them regardless.`),
                );
            },
            log,
        }),
    );

    return dialPeer<WebSocket>({
        open: async (signal) => {
            await askEdgeFirst();
            if (!(await whileGone(signal))) {
                return undefined;
            }
            const { base, local } = await dial.resolveBase(config.sandboxUrl);
            if (signal.aborted) {
                return undefined;
            }
            if (local) {
                loopbackUrls.add(config.sandboxUrl);
            }
            return {
                socket: dial.socket(hostConnectUrl(base)),
                // The loopback case is logged; it's the one fact about this connection the link's own address doesn't
                // carry. The address itself comes from the prefix above, which every line of this link's carries.
                said: `connected${local ? ` over loopback (${base})` : ""} as "${config.id}"`,
            };
        },
        hello: () => ({ type: "hello", token: config.token, version }),
        attach: (ws) => {
            held = ws;
            // Open: the failures behind it no longer count toward asking the edge.
            attempts = 0;
            // A link that is gone drives nothing; only its latest socket speaks for it, as one abandoned may close late.
            ws.addEventListener("close", () => {
                if (held === ws) {
                    indicator.release(config.sandboxUrl);
                }
            });
            handler.upgrade(ws);
        },
        backoff: createBackoff(PEER_LINK_BACKOFF),
        /* The deadline that makes a dead link NOTICEABLE, and on this door it is the one that matters most. */
        silenceMs: peerLinkSilenceMs(HOST_HEARTBEAT_MS),
        log: linkLog,
        // 1008 is the sandbox having read its enrollments and not found this one, so the link is dropped rather than redialled.
        revoked: () => {
            linkLog(
                "the sandbox refused this device's enrollment: it was revoked there, so this link is dropped. Connect again from the sandbox to restore it.",
            );
            void forget(config.sandboxUrl).catch((error: unknown) => linkLog(`could not drop the revoked link (${String(error)})`));
        },
    });
};
