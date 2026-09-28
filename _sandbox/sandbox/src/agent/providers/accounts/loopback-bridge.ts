import { timingSafeEqual } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import {
    DEVICE_FEATURE_LOOPBACK_CATCH,
    derivedMachineId,
    deviceSupports,
    HOST_NATIVE_ENVIRONMENT,
    type DeviceFacts,
    LOOPBACK_CATCH_FEATURE,
    type LoopbackCatch,
    type LoopbackCatchEvent,
    parseHostConnection,
    type SignInCatcher,
    type WebExtFacts,
} from "@intentic/sandbox-contract";
import type { Logger } from "pino";

// A SIGN-IN WHOSE REDIRECT LANDS ON LOOPBACK, FINISHED WITHOUT A PASTE. A provider built for a CLI sends the browser to
// http://localhost:<port>/… where that CLI would be listening; this daemon is not on the machine the browser is, so the
// page dead-ends and the person pastes the address back. Here every device agent and browser of the owner's that can
// (`loopback-catch`) is asked to watch that one address instead, and the first landing that carries this attempt's
// state is handed to `deliver`, which is the very routine a paste would have reached. The paste stays open beside it
// for a browser on a machine nothing watches; whichever arrives first wins and the other finds the attempt gone.
//
// What a catcher sends back is checked here and only here: it holds no state, and anything on that machine can hit a
// loopback port. A landing whose state is not this attempt's is dropped and the watch goes on. The grant inside a
// genuine landing is still worthless without the verifier the door holds, which never leaves this process.

// All the bridge reads of a peer door: who holds a socket, what each last said about itself, and the one procedure it
// calls. The daemon's own hubs (PeerHub) are this and more, so it takes them as they are; a test needs nothing else.
export interface CatchingPeer {
    readonly catchLoopback: (spec: LoopbackCatch, options: { readonly signal: AbortSignal }) => Promise<AsyncIterable<LoopbackCatchEvent>>;
}
export interface CatchingHub<Facts> {
    readonly connected: () => readonly string[];
    readonly state: (id: string) => { readonly facts?: Facts };
    readonly client: (id: string) => CatchingPeer | undefined;
}
export interface LoopbackBridgeDeps {
    readonly hostHub: CatchingHub<DeviceFacts>;
    readonly webextHub: CatchingHub<WebExtFacts>;
    readonly logger: Pick<Logger, "child">;
}

// What a door asks to be watched for: where the provider sends the browser, and the state that marks this attempt's
// landing there (the query parameter a provider carries it in is `state` for every one of them so far).
export interface LoopbackTarget {
    readonly id: string;
    readonly host: LoopbackCatch["host"];
    readonly port: number;
    readonly path: string;
    readonly state: string;
    readonly expiresAt: number;
    // Who the landing page thanks ("Claude").
    readonly title: string;
}

export interface ArmedCatch {
    // Who is watching, for the card; empty means nobody, and the attempt is a paste as it always was.
    readonly catchers: readonly SignInCatcher[];
    // Stops every watch. Idempotent; a door calls it on cancel, on a paste that finished first, and on expiry.
    readonly disarm: () => void;
}

interface Catcher {
    readonly catcher: SignInCatcher;
    readonly open: (spec: LoopbackCatch, signal: AbortSignal) => Promise<AsyncIterable<LoopbackCatchEvent>>;
}

// One device connection per computer: the native side where it has one, since that side owns the screen and so the
// browser; a WSL distro only where nothing native is connected, reached through WSL's localhost forwarding.
const deviceCatchers = (hub: LoopbackBridgeDeps["hostHub"]): Catcher[] => {
    const chosen = new Map<string, { readonly id: string; readonly card: string; readonly native: boolean }>();
    for (const id of hub.connected().toSorted()) {
        const facts = hub.state(id).facts;
        if (!deviceSupports(facts, DEVICE_FEATURE_LOOPBACK_CATCH)) {
            continue;
        }
        const { card, environment } = parseHostConnection(id);
        const machine = facts?.machineId ?? derivedMachineId(card);
        const native = environment === HOST_NATIVE_ENVIRONMENT;
        const held = chosen.get(machine);
        if (held === undefined || (native && !held.native)) {
            chosen.set(machine, { id, card, native });
        }
    }
    return [...chosen.values()].flatMap(({ id, card }) => {
        const client = hub.client(id);
        return client === undefined ? [] : [{ catcher: { kind: "device", label: card }, open: (spec, signal) => client.catchLoopback(spec, { signal }) }];
    });
};

// Every connected browser that says it can, unless its owner paused it from the popup.
const browserCatchers = (hub: LoopbackBridgeDeps["webextHub"]): Catcher[] =>
    hub.connected().flatMap((id) => {
        const facts = hub.state(id).facts;
        const client = hub.client(id);
        if (client === undefined || facts === undefined || facts.paused || !(facts.features ?? []).includes(LOOPBACK_CATCH_FEATURE)) {
            return [];
        }
        return [{ catcher: { kind: "browser", label: facts.browser || id }, open: (spec, signal) => client.catchLoopback(spec, { signal }) }];
    });

// Constant-time, so a catcher probing states learns nothing from how long a refusal took.
const sameState = (expected: string, landed: string | null): boolean => {
    if (landed === null) {
        return false;
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(landed);
    return a.length === b.length && timingSafeEqual(a, b);
};

// The landing's state, or null for anything that is not a URL on the watched address at all.
const landingState = (target: LoopbackTarget, url: string): string | null => {
    try {
        const landed = new URL(url);
        return landed.port === String(target.port) && landed.pathname === target.path ? landed.searchParams.get("state") : null;
    } catch {
        return null;
    }
};

const catchersOf = (deps: LoopbackBridgeDeps): Catcher[] => [...deviceCatchers(deps.hostHub), ...browserCatchers(deps.webextHub)];

// Who would watch a loopback landing right now, without asking anyone to: for a door choosing between a redirect
// sign-in and a device code (Codex) before it has an address to watch.
export const loopbackWatchers = (deps: LoopbackBridgeDeps): SignInCatcher[] => catchersOf(deps).map(({ catcher }) => catcher);

export const armLoopbackCatch = (deps: LoopbackBridgeDeps, target: LoopbackTarget, deliver: (url: string) => Promise<void>): ArmedCatch => {
    const catchers = catchersOf(deps);
    if (catchers.length === 0) {
        return { catchers: [], disarm: () => {} };
    }
    const abort = new AbortController();
    const disarm = (): void => abort.abort();
    const deadline = setTimeout(disarm, Math.max(0, target.expiresAt - Date.now()));
    deadline.unref();
    abort.signal.addEventListener("abort", () => clearTimeout(deadline), { once: true });
    const log = deps.logger.child({ component: "loopback-bridge", attempt: target.id });
    const spec: LoopbackCatch = {
        id: target.id,
        host: target.host,
        port: target.port,
        path: target.path,
        expiresAt: target.expiresAt,
        title: target.title,
    };
    let delivered = false;
    const watch = async ({ catcher, open }: Catcher): Promise<void> => {
        try {
            for await (const event of await open(spec, abort.signal)) {
                if (event.type === "busy") {
                    log.info({ catcher: catcher.label, reason: event.reason }, "loopback bridge: a catcher could not watch");
                    return;
                }
                if (event.type !== "landed" || delivered) {
                    continue;
                }
                if (!sameState(target.state, landingState(target, event.url))) {
                    log.warn({ catcher: catcher.label }, "loopback bridge: a landing without this attempt's state was ignored");
                    continue;
                }
                delivered = true;
                disarm();
                log.info({ catcher: catcher.label }, "loopback bridge: the sign-in landed, finishing it");
                // The door records its own failure where the card reads it (the attempt's status); this only logs.
                try {
                    await deliver(event.url);
                } catch (error) {
                    log.warn({ err: errorMessage(error) }, "loopback bridge: finishing the sign-in failed");
                }
                return;
            }
        } catch (error) {
            if (!abort.signal.aborted) {
                log.info({ catcher: catcher.label, err: errorMessage(error) }, "loopback bridge: a catcher dropped");
            }
        }
    };
    for (const catcher of catchers) {
        void watch(catcher);
    }
    return { catchers: catchers.map(({ catcher }) => catcher), disarm };
};

// Where an authorize URL sends the browser, when that is a loopback address: its `redirect_uri`, read off the URL the
// vendor (or the translator on its behalf) built, so a flow whose redirect this daemon never chose can still be
// watched. Undefined for anything that is not plain http on localhost or 127.0.0.1 with a port.
export const loopbackRedirectOf = (authorizeUrl: string): Pick<LoopbackTarget, "host" | "port" | "path"> | undefined => {
    try {
        const redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "");
        const port = Number(redirect.port);
        if (redirect.protocol !== "http:" || (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") || !Number.isInteger(port) || port <= 0) {
            return undefined;
        }
        return { host: redirect.hostname, port, path: redirect.pathname };
    } catch {
        return undefined;
    }
};
