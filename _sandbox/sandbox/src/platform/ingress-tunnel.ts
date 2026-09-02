import { createBackoff, sleep } from "@intentic/base/async";
import {
    INGRESS_GRANT_HEADER,
    INGRESS_TUNNEL_PATH,
    type IngressTunnelHandle,
    type IngressTunnelOptions,
} from "@intentic/sandbox-contract/ingress-contract";
import { serveIngressSession, type IngressSessionServer } from "@intentic/sandbox-contract/ingress-protocol";
import { createWebSocketStream, WebSocket } from "ws";

/* HOW THIS SANDBOX BECOMES REACHABLE, and it is one outbound dial.
 *
 * WHAT THIS REPLACED. The entrypoint used to spend ~150 lines before the daemon even started: enable a zrok
 * environment, claim the `sandbox-<id>` name, bind a share to it, and reclaim whatever the previous container
 * had left holding that name. All of it existed because reachability was STATE on a hub — an account, a name,
 * a share — and a `docker rm -f` killed the terminator without telling the hub, so a recreated box came up 502
 * on its own address and fought its own corpse for the name.
 *
 * None of that is here, because none of it is needed: every public name this sandbox serves ends in its own
 * 12-hex id, so the edge decides who may serve a request by PARSING the Host. The only thing that has to be
 * proved is identity, and that is a signature the platform already put in this container's environment. So the
 * whole of reachability is: dial, present the grant, serve h2 over the socket. Nothing to claim, nothing to
 * bind, nothing to reclaim — and a redial simply displaces whatever held the id, which is what makes a
 * recreated container heal itself instead of needing a reaper.
 *
 * IT NEVER GIVES UP. The tunnel IS this sandbox's reachability; a daemon that stopped dialing would be a
 * workspace nobody can open, with no way back short of a restart nobody knows to perform. So, like the agent
 * loop it replaces, it only ever waits longer.
 */

// Backoff bounds. The floor is low because the overwhelmingly common redial is a deploy of the edge — the
// container should be back within a second, not sit out a punishment interval for someone else's rollout.
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/* A session that lasted this long was a WORKING tunnel, so the next failure starts its backoff from the floor
 * again. Without this, a container that has been up for a week reconnects at the ceiling after one blip,
 * because the counter still remembers a bad afternoon in between. One that opened and died young keeps
 * climbing, which is what keeps a refused grant or a dead edge from being hammered. The ladder itself, with
 * the full jitter every container in a region needs when it redials the same edge at the same instant, is
 * @intentic/base's createBackoff. */
const STABLE_AFTER_MS = 60_000;

/* DISPLACEMENT IS NOT A FAILURE, and redialing straight into it is how two containers sharing one connect
 * token turn into a flap: each dial evicts the other, forever, and neither serves a request in between.
 *
 * Normally the loser here is a container that is already being torn down, so this delay costs nothing and is
 * never observed. When it is observed, something else is genuinely holding this id — a stale container that
 * outlived its recreate, a second box started from a copied token — and waiting a minute means the live one
 * keeps the address for minutes at a time instead of milliseconds. It still redials, because the other side
 * may be the one that is dying. */
const DISPLACED_BACKOFF_MS = 60_000;

// The registry's code for "a newer tunnel took your id" (ingress registry.ts).
const DISPLACED_CODE = 4001;

/* The door, derived rather than configured: a container is told one address (INGRESS_URL) and the path is the
 * contract's. Versioned in the path, so a v2 session shape is a new door rather than a flag day. */
export const tunnelUrl = (base: string): string => {
    const url = new URL(INGRESS_TUNNEL_PATH, base);
    url.protocol = url.protocol === `http:` ? `ws:` : `wss:`;
    return url.toString();
};

/* The bits of `ws` this uses, named so a test can supply a fake without a network. Nothing here is a
 * WebSocket-the-spec, it is the node client's surface. */
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
    serveIngressSession(createWebSocketStream(socket as unknown as WebSocket), { targetPort });

/* START IT ONLY IF THIS SANDBOX HAS WHAT IT TAKES, and say which piece is missing when it does not.
 *
 * Three postures reach here and only one of them is a tunnel: a container the platform made reachable, a
 * `local` profile serving one loopback port, and a test. The other two are not degraded — a loopback-only
 * sandbox is a supported way to run this — so the log line states the posture rather than warning about it.
 * Naming the missing piece matters because the three causes are fixed in three different places: the profile,
 * the deployment's env, and the lane that was supposed to mint a grant.
 *
 * `frontDoor` is whether the preview proxy is running (traits.extraListeners): the tunnel forwards every
 * hostname to it, so without one there is nowhere for a stream to land. */
export const startIngressTunnelWhenConfigured = (options: {
    readonly url: string;
    readonly grant: string;
    readonly targetPort: number;
    readonly frontDoor: boolean;
    readonly log: (message: string, error?: unknown) => void;
}): IngressTunnelHandle | undefined => {
    const { url, grant, targetPort, frontDoor, log } = options;
    if (!frontDoor) {
        log(`reachable over loopback only: this profile serves no front door for a tunnel to reach`);
        return undefined;
    }
    if (url === ``) {
        log(`reachable over loopback only: no INGRESS_URL, so there is no edge to dial`);
        return undefined;
    }
    if (grant === ``) {
        log(`reachable over loopback only: no SANDBOX_GRANT, so nothing proves which sandbox this is`);
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

    /* ONE DIAL, resolving with how long to wait before the next one. Written as a promise the loop awaits
     * rather than as a web of listeners, because every way a tunnel ends — refused, opened-then-dropped,
     * displaced, timed out — has to converge on exactly one "settle, then redial", and a listener graph that
     * can fire twice is how a reconnect loop turns into two reconnect loops sharing one flag. */
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
                // How long the session worked is what the ladder reads: long enough earns the floor back, a
                // dial that was refused or died on arrival keeps climbing.
                settle(ladder.next(openedAt === undefined ? 0 : now() - openedAt));
            }) as (...args: never[]) => void);

            /* `error` and `close` both fire for a refused dial, in that order, so the wait is decided by the
             * close handler above and this one only reports. Deciding it here too is how the same failure
             * became two redials. */
            ws.on(`error`, ((error: Error) => options.log(`the ingress tunnel dropped`, error)) as (...args: never[]) => void);
        });

    /* THE LOOP, written as a tail call rather than a `while`, because its exit condition is set from OUTSIDE
     * it: `close()` is what ends this, and a loop whose guard nothing in its body touches is both a lint
     * finding and a fair description of the confusion. Each pass is one dial and one wait, and the flag is
     * re-read at both points where giving up is still cheap. No stack grows: every call is a fresh
     * continuation off a resolved promise. */
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
