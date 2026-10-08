import { PhoneResponseSchema } from "@intentic/sandbox-contract";
import type { ClientContext, ClientLink, ClientOptions } from "@orpc/client";

// The phone door's client link: the same typed client every peer door drives (`createORPCClient`), over plain JSON-RPC
// 2.0 instead of oRPC's own WebSocket framing (protocol/doors/phone-protocol.ts in the contract says why). A procedure's
// path is the method, its input the params; the phone answers each id once. Only the daemon asks, so a frame from the
// phone that answers no outstanding id is dropped, never treated as a request.

// What the link needs of a socket: the `ws` package's socket and the DOM's both have it.
export interface LinkSocket {
    send(data: string): void;
    addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
    addEventListener(type: "close", listener: () => void): void;
}

interface Pending {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly dispose: () => void;
}

// A refusal the phone answered with, carrying its code so a caller can tell "paused" from a broken call.
export class PhoneCallError extends Error {
    constructor(
        message: string,
        readonly code: number,
    ) {
        super(message);
        this.name = "PhoneCallError";
    }
}

const textOf = (data: unknown): string =>
    typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : ArrayBuffer.isView(data)
            ? new TextDecoder().decode(data)
            : String(data);

export class PhoneJsonRpcLink<Context extends ClientContext = ClientContext> implements ClientLink<Context> {
    private nextId = 0;
    private closed = false;
    private readonly pending = new Map<number, Pending>();

    constructor(private readonly socket: LinkSocket) {
        socket.addEventListener("message", (event) => this.receive(event.data));
        socket.addEventListener("close", () => {
            this.closed = true;
            for (const [id, call] of this.pending) {
                this.pending.delete(id);
                call.dispose();
                call.reject(new Error("the phone closed its connection"));
            }
        });
    }

    call(path: readonly string[], input: unknown, options: ClientOptions<Context>): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new Error("the phone closed its connection"));
        }
        const signal = options.signal;
        if (signal?.aborted === true) {
            return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }
        const id = this.nextId++;
        const frame = { jsonrpc: "2.0", id, method: path.join("."), ...(input === undefined ? {} : { params: input }) };
        return new Promise<unknown>((resolve, reject) => {
            const onAbort = (): void => {
                this.pending.delete(id);
                reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            this.pending.set(id, { resolve, reject, dispose: () => signal?.removeEventListener("abort", onAbort) });
            try {
                this.socket.send(JSON.stringify(frame));
            } catch (error) {
                this.pending.get(id)?.dispose();
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private receive(data: unknown): void {
        let raw: unknown;
        try {
            raw = JSON.parse(textOf(data));
        } catch {
            // allow(silent-catch): a frame that is not JSON answers no pending call, the same as one the schema below refuses; that call times out and says so.
            return;
        }
        const parsed = PhoneResponseSchema.safeParse(raw);
        if (!parsed.success || parsed.data.id === null) {
            return;
        }
        const call = this.pending.get(parsed.data.id);
        if (call === undefined) {
            return;
        }
        this.pending.delete(parsed.data.id);
        call.dispose();
        if ("error" in parsed.data) {
            call.reject(new PhoneCallError(parsed.data.error.message, parsed.data.error.code));
            return;
        }
        call.resolve(parsed.data.result);
    }
}
