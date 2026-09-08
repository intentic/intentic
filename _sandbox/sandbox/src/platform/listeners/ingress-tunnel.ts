import { createBackoff, sleep } from "@intentic/base/async";
import {
    INGRESS_GRANT_HEADER,
    INGRESS_TUNNEL_PATH,
    type IngressTunnelHandle,
    type IngressTunnelOptions,
} from "@intentic/sandbox-contract/ingress-contract";
import { serveIngressSession, webSocketDuplex, type IngressSessionServer, type TunnelWebSocket } from "@intentic/sandbox-contract/ingress-protocol";
import { WebSocket } from "ws";

// Reachability is one outbound dial: present the grant already signed into the container's env and serve h2 over the
// socket. No claim, no bind, no reclaim; a redial simply displaces whatever held the id, so a recreated container heals
// itself. It never gives up: the tunnel IS this sandbox's reachability.

// Backoff bounds; the floor is low since the common redial cause is an edge deploy, back within a second rather than
// serving a punishment interval for someone else's rollout.
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// A session this long counts as working: the next failure's backoff restarts from the floor, not the ceiling.
const STABLE_AFTER_MS = 60_000;

// Wait after being displaced: redialing immediately into another live holder would flap the two tunnels forever.
const DISPLACED_BACKOFF_MS = 60_000;

// The registry's code for "a newer tunnel took your id" (ingress registry.ts).
const DISPLACED_CODE = 4001;

// The door, derived rather than configured: INGRESS_URL plus the contract's path, versioned so a v2 session shape is a
// new door rather than a flag day.
export const tunnelUrl = (base: string): string => {
    const url = new URL(INGRESS_TUNNEL_PATH, base);
    url.protocol = url.protocol === `http:` ? `ws:` : `wss:`;
    return url.toString();
};

// The bits of `ws` this uses, named so a test can supply a fake without a network; not a WebSocket-the-spec, the node
// client's surface.
export interface TunnelSocket {
    readonly on: (event: string, listener: (...args: never[]) => void) => unknown;
    readonly close: (code?: number, reason?: string) => void;
    readonly terminate: () => void;
}

export interface IngressTunnelDeps {
    // Injected in tests; the default dials for real.
    readonly connect?: (url: string, headers: Record<string, string>) => TunnelSocket;
    readonly serve?: (socket: TunnelSocket, targetPort: number) => Promise<IngressSessionServer>;
    readonly delay?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly random?: () => number;
}

const realConnect = (url: string, headers: Record<string, string>): TunnelSocket => new WebSocket(url, { headers }) as unknown as TunnelSocket;

const realServe = async (socket: TunnelSocket, targetPort: number): Promise<IngressSessionServer> =>
    serveIngressSession(webSocketDuplex(socket as unknown as TunnelWebSocket), { targetPort });

// How this sandbox is reached: tunnel, direct (a Fly machine the edge replays to), or loopback. `reason` names the
// deciding piece, since postures are fixed in different places.
export type ReachPosture =
    { readonly by: "tunnel" } | { readonly by: "direct"; readonly reason: string } | { readonly by: "loopback"; readonly reason: string };

export const reachPosture = (options: {
    readonly url: string;
    readonly grant: string;
    readonly frontDoor: boolean;
    readonly vm: boolean;
}): ReachPosture => {
    if (options.vm) {
        return { by: `direct`, reason: `this machine is a Fly app the platform's edge replays requests to, so there is no tunnel to dial` };
    }
    if (!options.frontDoor) {
        return { by: `loopback`, reason: `this profile serves no front door for a tunnel to reach` };
    }
    if (options.url === ``) {
        return { by: `loopback`, reason: `no INGRESS_URL, so there is no edge to dial` };
    }
    if (options.grant === ``) {
        return { by: `loopback`, reason: `no SANDBOX_GRANT, so nothing proves which sandbox this is` };
    }
    return { by: `tunnel` };
};

// Starts the tunnel only if this sandbox has what it takes, and logs the posture otherwise. `frontDoor` is whether the
// preview proxy runs (traits.extraListeners); `vm` is SANDBOX_VM, the platform's own hosted machine reached by replay.
export const startIngressTunnelWhenConfigured = (options: {
    readonly url: string;
    readonly grant: string;
    readonly targetPort: number;
    readonly frontDoor: boolean;
    readonly vm: boolean;
    readonly log: (message: string, error?: unknown) => void;
}): IngressTunnelHandle | undefined => {
    const { url, grant, targetPort, log } = options;
    const posture = reachPosture(options);
    if (posture.by === `direct`) {
        log(`reachable directly: ${posture.reason}`);
        return undefined;
    }
    if (posture.by === `loopback`) {
        log(`reachable over loopback only: ${posture.reason}`);
        return undefined;
    }
    return startIngressTunnel({ url, grant, targetPort, log });
};

export const startIngressTunnel = (options: IngressTunnelOptions & IngressTunnelDeps): IngressTunnelHandle => {
    const connect = options.connect ?? realConnect;
    const serve = options.serve ?? realServe;
    const delay = options.delay ?? ((ms: number) => sleep(ms, { unref: true }));
    const now = options.now ?? Date.now;
    const ladder = createBackoff({
        floorMs: BACKOFF_MIN_MS,
        capMs: BACKOFF_MAX_MS,
        stableMs: STABLE_AFTER_MS,
        random: options.random ?? Math.random,
    });
    const url = tunnelUrl(options.url);

    let stopped = false;
    let connected = false;
    let socket: TunnelSocket | undefined;

    // One dial, resolving with how long to wait before the next. A promise the loop awaits rather than a listener web,
    // since every way a tunnel ends must converge on exactly one settle-then-redial.
    const dialOnce = (): Promise<number> =>
        new Promise<number>((resolve) => {
            let settled = false;
            let server: IngressSessionServer | undefined;
            let openedAt: number | undefined;

            const settle = (waitMs: number): void => {
                if (settled) {
                    return;
                }
                settled = true;
                connected = false;
                server?.close();
                resolve(waitMs);
            };

            const ws = connect(url, { [INGRESS_GRANT_HEADER]: options.grant });
            socket = ws;

            ws.on(`open`, () => {
                void (async () => {
                    try {
                        server = await serve(ws, options.targetPort);
                        openedAt = now();
                        connected = true;
                        options.log(`reachable: the ingress tunnel is registered`);
                    } catch (error) {
                        options.log(`the ingress tunnel opened but could not serve`, error);
                        ws.terminate();
                    }
                })();
            });

            ws.on(`close`, ((code: number) => {
                if (code === DISPLACED_CODE) {
                    options.log(`another tunnel took this sandbox's address; standing back`);
                    settle(DISPLACED_BACKOFF_MS);
                    return;
                }
                // Long enough earns the floor back; a dial that died on arrival keeps climbing the ladder.
                settle(ladder.next(openedAt === undefined ? 0 : now() - openedAt));
            }) as (...args: never[]) => void);

            // Both `error` and `close` fire for a refused dial; only the close handler above decides the wait.
            ws.on(`error`, ((error: Error) => options.log(`the ingress tunnel dropped`, error)) as (...args: never[]) => void);
        });

    // The loop, written as a tail call rather than a `while` since its exit condition (`close()`) is set from outside
    // it. No stack grows: every call is a fresh continuation off a resolved promise.
    const run = async (): Promise<void> => {
        const waitMs = await dialOnce();
        if (stopped) {
            return;
        }
        await delay(waitMs);
        if (stopped) {
            return;
        }
        void run();
    };
    void run();

    return {
        close: async () => {
            stopped = true;
            connected = false;
            socket?.close(1001, `sandbox shutting down`);
            await Promise.resolve();
        },
        connected: () => connected,
    };
};
