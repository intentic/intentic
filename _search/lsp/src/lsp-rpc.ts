import { type ChildProcess, spawn } from "node:child_process";

/* A minimal LSP-over-stdio client, just enough protocol to hold one short conversation with the native
 * compiler's language server (`tsgo --lsp`) and hang up. Used by rename, which needs the server's
 * project-wide view for the one question the batch compiler cannot answer: "every location this symbol is
 * used, with the edits that move it".
 *
 * Deliberately not a language-server HOST: nothing stays running, nothing watches files, and server-initiated
 * requests are answered with nulls, the session exists for one request chain and is torn down with the
 * process. */

interface Pending {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}

export class LspSession {
    private readonly child: ChildProcess;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private buffer = Buffer.alloc(0);
    private failure: Error | undefined;

    constructor(command: string, args: readonly string[], cwd: string) {
        this.child = spawn(command, [...args], { cwd, stdio: ["pipe", "pipe", "ignore"] });
        this.child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
        this.child.on("error", (error) => this.fail(error));
        this.child.on("close", () => this.fail(new Error("the language server exited before answering")));
    }

    private fail(error: Error): void {
        if (this.failure !== undefined) {
            return;
        }
        this.failure = error;
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private receive(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                return;
            }
            const header = this.buffer.subarray(0, headerEnd).toString();
            const length = /Content-Length: (\d+)/i.exec(header);
            if (length === null) {
                this.fail(new Error("the language server sent an unreadable frame"));
                return;
            }
            const total = headerEnd + 4 + Number(length[1]);
            if (this.buffer.length < total) {
                return;
            }
            const body = this.buffer.subarray(headerEnd + 4, total).toString();
            this.buffer = this.buffer.subarray(total);
            this.dispatch(JSON.parse(body) as Record<string, unknown>);
        }
    }

    private dispatch(message: Record<string, unknown>): void {
        const id = message["id"];
        // A response to something we asked.
        if (typeof id === "number" && ("result" in message || "error" in message)) {
            const pending = this.pending.get(id);
            if (pending === undefined) {
                return;
            }
            this.pending.delete(id);
            const error = message["error"] as { message?: string } | undefined;
            if (error !== undefined) {
                pending.reject(new Error(error.message ?? "the language server declined the request"));
            } else {
                pending.resolve(message["result"]);
            }
            return;
        }
        // A server-initiated request (configuration, capability registration): answered with null so the
        // conversation can continue. Notifications need no answer at all.
        if (id !== undefined && typeof message["method"] === "string") {
            this.send({ jsonrpc: "2.0", id, result: null });
        }
    }

    private send(message: Record<string, unknown>): void {
        const body = JSON.stringify(message);
        this.child.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }

    request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        if (this.failure !== undefined) {
            return Promise.reject(this.failure);
        }
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`the language server did not answer ${method} within ${timeoutMs / 1000}s`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (result) => {
                    clearTimeout(timer);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            this.send({ jsonrpc: "2.0", id, method, params });
        });
    }

    notify(method: string, params: unknown): void {
        if (this.failure === undefined) {
            this.send({ jsonrpc: "2.0", method, params });
        }
    }

    dispose(): void {
        this.fail(new Error("the session was disposed"));
        this.child.kill("SIGKILL");
    }
}
