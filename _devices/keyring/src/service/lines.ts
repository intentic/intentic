import type { Socket } from "node:net";
import type { z } from "zod";
import { KEYRING_LINE_MAX } from "../protocol.js";
import type { DoorMessage } from "./door.js";

// One JSON line at a time over a socket, for the door's long-lived helper connection and its handshakes: lines are
// queued as they arrive and handed out in order, each wait with its own deadline.

export class LineSocket {
    readonly #socket: Socket;
    #buffered = "";
    readonly #lines: string[] = [];
    readonly #waiting: ((line: string | undefined) => void)[] = [];
    #closed = false;

    constructor(socket: Socket) {
        this.#socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.#take(chunk));
        socket.on("close", () => this.#close());
        socket.on("error", () => this.#close());
    }

    get closed(): boolean {
        return this.#closed;
    }

    #take(chunk: string): void {
        this.#buffered += chunk;
        if (this.#buffered.length > KEYRING_LINE_MAX) {
            this.#socket.destroy();
            return;
        }
        let end = this.#buffered.indexOf("\n");
        while (end !== -1) {
            const line = this.#buffered.slice(0, end);
            this.#buffered = this.#buffered.slice(end + 1);
            const waiter = this.#waiting.shift();
            if (waiter === undefined) {
                this.#lines.push(line);
            } else {
                waiter(line);
            }
            end = this.#buffered.indexOf("\n");
        }
    }

    #close(): void {
        this.#closed = true;
        for (const waiter of this.#waiting.splice(0)) {
            waiter(undefined);
        }
    }

    // The next line, or undefined when the connection closed or `deadlineMs` passed first.
    async next(deadlineMs: number): Promise<string | undefined> {
        const queued = this.#lines.shift();
        if (queued !== undefined) {
            return queued;
        }
        if (this.#closed) {
            return undefined;
        }
        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                const index = this.#waiting.indexOf(done);
                if (index !== -1) {
                    this.#waiting.splice(index, 1);
                }
                resolve(undefined);
            }, deadlineMs);
            const done = (line: string | undefined): void => {
                clearTimeout(timer);
                resolve(line);
            };
            this.#waiting.push(done);
        });
    }

    // The next line read as `schema`'s, or undefined for none in time, one that is not JSON, or one that does not fit.
    async nextOf<T>(schema: z.ZodType<T>, deadlineMs: number): Promise<T | undefined> {
        const line = await this.next(deadlineMs);
        if (line === undefined) {
            return undefined;
        }
        try {
            const parsed = schema.safeParse(JSON.parse(line));
            return parsed.success ? parsed.data : undefined;
        } catch {
            // allow(silent-catch): a line that is not JSON is no answer, which every caller refuses
            return undefined;
        }
    }

    send(message: DoorMessage): void {
        if (!this.#closed) {
            this.#socket.write(`${JSON.stringify(message)}\n`);
        }
    }

    end(): void {
        this.#socket.end();
    }
}
