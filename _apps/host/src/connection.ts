import { hostConnectUrl, HostServerFrameSchema, type HostScopes } from "@intentic/sandbox-contract";
import type { HostConfigFile, Log } from "./config.js";
import { rememberScopes } from "./config.js";
import { handleMcpMessage } from "./mcp.js";
import { hostFacts } from "./tools/describe.js";

/* The one socket. This computer dials the sandbox and keeps the connection open; everything the agent asks for
 * arrives on it, and every answer goes back the same way.
 *
 * OUTBOUND ONLY, and that is the entire networking story: no port is opened here, no router is configured, no
 * VPN is joined. A laptop on hotel wifi behind a corporate proxy can hold this connection because it is an
 * ordinary outbound wss:// — the same thing every chat app on the machine is already doing.
 *
 * RECONNECTION IS THE NORMAL CASE, not the failure case. Lids close, wifi changes, tunnels idle out, the sandbox
 * restarts. So the loop treats a dropped socket as routine and comes back with exponential backoff — and the
 * sandbox's card reads "offline" in the meantime rather than pretending. The one thing that is NOT retried is a
 * refused enrollment (close code 1008): the owner revoked this machine, that never heals on its own, and
 * hammering a door that has been locked is how an agent turns a revocation into a support ticket. */

// Backoff bounds. The first retry is fast because the overwhelmingly common cause is a sandbox restart, which
// takes seconds; the ceiling is low enough that a laptop opened after a night asleep is back within a minute.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
// A keepalive well inside the idle timeout of every tunnel and proxy that sits in the middle of this.
const PING_INTERVAL_MS = 30_000;
// The daemon closes with this when the token is not enrolled — a decision, not a fault.
const UNAUTHORIZED = 1008;

export interface HostConnection {
    // Resolves when the loop is asked to stop (and never rejects — a connection error is a retry, not a throw).
    readonly done: Promise<void>;
    readonly stop: () => void;
}

export const connect = (config: HostConfigFile, version: string, log: Log): HostConnection => {
    // The live grant. Starts as whatever the last session cached and is replaced by the sandbox's push, which
    // arrives immediately after every hello — so a scope the owner turned off is enforced from the first call of
    // the new session, not from the next restart of this agent.
    let scopes: HostScopes = config.scopes;
    let stopped = false;
    let socket: WebSocket | undefined;
    let attempt = 0;
    let resolveDone: () => void;
    const done = new Promise<void>((resolvePromise) => {
        resolveDone = resolvePromise;
    });

    const open = async (): Promise<void> => {
        const ws = new WebSocket(hostConnectUrl(config.sandboxUrl));
        socket = ws;
        let ping: ReturnType<typeof setInterval> | undefined;

        ws.addEventListener("open", () => {
            attempt = 0;
            void hostFacts(scopes).then((facts) => {
                // The token rides the first frame rather than the URL — see the protocol module for why.
                ws.send(JSON.stringify({ type: "hello", token: config.token, version, facts }));
                log(`connected to ${config.sandboxUrl} as "${config.id}"`);
            });
            ping = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), PING_INTERVAL_MS);
        });

        ws.addEventListener("message", (event) => {
            const parsed = HostServerFrameSchema.safeParse(JSON.parse(String(event.data)));
            if (!parsed.success) {
                log(`ignored an unrecognised frame from the sandbox: ${parsed.error.message}`);
                return;
            }
            const frame = parsed.data;
            if (frame.type === "scopes") {
                scopes = frame.scopes;
                log(`permissions updated: commands ${scopes.shell}, writes ${scopes.write}, screen ${scopes.screen}`);
                void rememberScopes(frame.scopes);
                return;
            }
            if (frame.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }
            if (frame.type !== "rpc") {
                return;
            }
            // Handled without awaiting, so a long command never blocks the next message on this socket — the
            // agent can ask for a screenshot while a build runs. The JSON-RPC id is what pairs answer to question.
            void handleMcpMessage(frame.payload, () => scopes).then((response) => {
                if (response !== undefined && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "rpc", payload: response }));
                }
            });
        });

        ws.addEventListener("close", (event) => {
            clearInterval(ping);
            socket = undefined;
            if (stopped) {
                resolveDone();
                return;
            }
            if (event.code === UNAUTHORIZED) {
                log("the sandbox refused this computer's enrollment — it was revoked there. Run `intentic-host uninstall` to clean up, or connect again from the sandbox.");
                stopped = true;
                resolveDone();
                return;
            }
            attempt += 1;
            const delay = Math.min(RETRY_MIN_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
            log(`disconnected (${event.code}); reconnecting in ${Math.round(delay / 1000)}s`);
            setTimeout(() => void open(), delay);
        });

        // A socket error is always followed by a close event, which owns the retry — this only records the cause,
        // which the close code alone never carries.
        ws.addEventListener("error", () => log("connection error"));
    };

    void open();

    return {
        done,
        stop: () => {
            stopped = true;
            socket?.close(1000, "stopping");
            resolveDone();
        },
    };
};
