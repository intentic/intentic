import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { InProcessServer, RpcMessage } from "../../agent/tools/turn-mounts.js";

// One of the daemon's own tool servers, built for the Claude Code loop as an SDK in-process server (a live McpServer the
// CLI talks to over the SDK's control channel), served instead through the daemon's MCP door, so a runtime that can only
// reach MCP over HTTP (Codex, OpenCode, an ACP agent, Devin, Pi) reaches the same tools with the same handlers.
// The bridge is a transport of its own rather than the MCP SDK's in-memory pair: the instance only needs something
// shaped like a Transport, and this keeps the daemon from depending on a second copy of the MCP SDK beside the one the
// Claude SDK bundles.

// The live server inside an SDK config, and the transport its connect takes, read off the SDK's own types.
type SdkInstance = McpSdkServerConfigWithInstance["instance"];
type DoorTransport = Parameters<SdkInstance["connect"]>[0];
type JsonRpc = Parameters<DoorTransport["send"]>[0];

// What the server says when the door closed under a call: the turn ended, and the lease with it.
const CLOSED = { code: -32000, message: "this turn's tool server is closed" } as const;
// A call whose HTTP client hung up before the server answered.
const ABANDONED = { code: -32000, message: "the call was abandoned by its client" } as const;

interface Pending {
    readonly id: RpcMessage["id"];
    readonly settle: (answer: RpcMessage) => void;
}

type RpcError = { readonly code: number; readonly message: string };

// The one crossing between the door's message shape and the SDK's: both are JSON-RPC 2.0 objects, the SDK's a union
// narrowed by its own schema, so the door's message is handed over as the union the instance parses it against.
const toSdk = (message: RpcMessage): JsonRpc =>
    // SAFETY: RpcMessage is the JSON-RPC 2.0 envelope the door read off the wire; the instance validates it against its
    // own schema before any handler sees it, so a malformed one is answered as an error there, not trusted here.
    message as JsonRpc;

// The way back: what the instance sends is already a JSON-RPC 2.0 object its own schema built.
const fromSdk = (message: JsonRpc): RpcMessage =>
    // SAFETY: every JSONRPCMessage variant is a JSON-RPC 2.0 object whose fields are the RpcMessage fields; only the
    // optional `params` differs, spelled `T | undefined` there where RpcMessage leaves it absent.
    message as RpcMessage;

const answerOf = (id: RpcMessage["id"], error: RpcError): RpcMessage => ({ jsonrpc: "2.0", id: id ?? null, error });

/**
 * Serves an SDK in-process server (what `createSdkMcpServer` returns) as the door's InProcessServer. Every request is
 * renumbered on the way in, since the door forwards several HTTP clients' messages to one instance and their ids can
 * collide; a client that hangs up cancels its call in the server. Connected on the first message, closed with the lease.
 */
export const sdkServerDoor = (config: McpSdkServerConfigWithInstance): InProcessServer => {
    const pending = new Map<RpcMessage["id"], Pending>();
    let nextId = 0;
    let closed = false;
    const deliver = (message: RpcMessage): void => {
        transport.onmessage?.(toSdk(message));
    };
    // The server's half of the pair, filled in by the instance's connect.
    const transport: DoorTransport = {
        start: async () => {},
        // What the server sends: an answer to one of ours, or something it starts itself (a progress or logging
        // notification, a sampling or elicitation request), which the door has no stream to carry.
        send: async (message) => {
            const raw = fromSdk(message);
            if (raw.method !== undefined) {
                // A request the server started is answered at once, so a handler that asks the client for something
                // fails rather than waits for an answer nobody will send.
                if (raw.id !== undefined && raw.id !== null) {
                    deliver(answerOf(raw.id, { code: -32601, message: "this client cannot answer server requests" }));
                }
                return;
            }
            const waiting = pending.get(raw.id);
            if (waiting === undefined) {
                return;
            }
            pending.delete(raw.id);
            waiting.settle({ ...raw, jsonrpc: "2.0", id: waiting.id ?? null });
        },
        close: async () => {
            transport.onclose?.();
        },
    };
    let connected: Promise<void> | undefined;
    const connect = (): Promise<void> => (connected ??= config.instance.connect(transport));
    return {
        handle: async (message, signal) => {
            // A client's answer to a server request: none is ever outstanding (send above refuses them at once).
            if (message.method === undefined) {
                return undefined;
            }
            if (closed) {
                return message.id === undefined ? undefined : answerOf(message.id, CLOSED);
            }
            await connect();
            if (message.id === undefined) {
                deliver(message);
                return undefined;
            }
            nextId += 1;
            const internal = nextId;
            return new Promise<RpcMessage>((settle) => {
                if (signal?.aborted === true) {
                    settle(answerOf(message.id, ABANDONED));
                    return;
                }
                const onAbort = (): void => {
                    if (!pending.delete(internal)) {
                        return;
                    }
                    // The handler sees its own signal end; the client already left, so the answer is for nobody.
                    deliver({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: internal, reason: "client hung up" } });
                    settle(answerOf(message.id, ABANDONED));
                };
                pending.set(internal, {
                    id: message.id,
                    settle: (answer) => {
                        signal?.removeEventListener("abort", onAbort);
                        settle(answer);
                    },
                });
                signal?.addEventListener("abort", onAbort, { once: true });
                deliver({ ...message, jsonrpc: "2.0", id: internal });
            });
        },
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            for (const [key, waiting] of pending) {
                pending.delete(key);
                waiting.settle(answerOf(waiting.id, CLOSED));
            }
            // allow(silent-catch): a server that fails to close holds nothing a turn could still reach; the door is shut.
            void config.instance.close().catch(() => undefined);
        },
    };
};
