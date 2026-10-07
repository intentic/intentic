import { connect, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import {
    ASK_PATIENCE_MS,
    FRAME_LENGTH_BYTES,
    FRAME_MAX_BYTES,
    type Answer,
    type FromNode,
    type NetdAnswer,
    type NetdQuestion,
    type Question,
    type ToNode,
} from "@intentic/sandbox-contract/netd-wire";

// Node's half of the control socket to intentic-netd (netd's half is _sandbox/netd, link.rs): one Unix socket,
// each frame a 4-byte big-endian length then that many bytes of JSON, the types generated from netd's own crate.
// Either side may ask the other: an `ask` carrying an id, answered by an `answer` or a `refused` carrying the same one,
// waited for ASK_PATIENCE_MS.

export interface NetdLink {
    // Sends one message; the socket keeps order, so netd applies them as sent.
    readonly tell: (message: FromNode) => void;
    // Each checkout's change count, in the order asked: null for one netd does not count, and for every one when
    // netd does not answer.
    readonly sync: (dirs: readonly string[]) => Promise<(number | null)[]>;
    readonly tunnelConnected: () => boolean;
    readonly close: () => void;
}

// A question of netd's that the daemon decides; a ping the link answers itself.
export type NetdAsks = Exclude<Question, { readonly question: "ping" }>;

// Where netd's ingress tunnel stands, as it reports it: held or not, why not in its own words, and whether it
// stopped redialling at its usual pace (another copy of this sandbox holds the tunnel, or the platform deleted it). An
// older netd sends `connected` alone.
export type TunnelReport = Extract<ToNode, { readonly kind: "tunnel" }>;

export interface NetdLinkOptions {
    readonly path: string;
    // Answers netd's questions; a throw goes back as a refusal carrying its message.
    readonly answer: (question: NetdAsks) => Promise<Answer>;
    readonly onTunnel: (connected: boolean, report: TunnelReport) => void;
    readonly onClose: () => void;
    // What went wrong on the link that is not a question's own refusal: a frame that would not parse (skipped, the rest
    // still read), a length past the cap or a socket error (the link is then dropped, and `onClose` follows).
    readonly onFault: (error: Error) => void;
    // How long a question of Node's waits for netd; ASK_PATIENCE_MS unless a test says otherwise.
    readonly patienceMs?: number;
}

export const frameOf = (message: FromNode): Buffer => {
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(FRAME_LENGTH_BYTES + json.length);
    frame.writeUInt32BE(json.length, 0);
    json.copy(frame, FRAME_LENGTH_BYTES);
    return frame;
};

// A length prefix past FRAME_MAX_BYTES: the stream has lost its framing, and nothing after it can be trusted.
export class FrameTooLarge extends Error {
    constructor(readonly length: number) {
        super(`netd link: a frame announced ${length} bytes, past the ${FRAME_MAX_BYTES}-byte cap; the stream is corrupt`);
        this.name = "FrameTooLarge";
    }
}

// Splits whatever has arrived into whole frames, keeping a partial one for the next read. Throws FrameTooLarge rather
// than waiting to buffer a frame no peer may send.
export const takeFrames = (buffered: Buffer): { readonly frames: Buffer[]; readonly rest: Buffer } => {
    const frames: Buffer[] = [];
    let offset = 0;
    while (buffered.length - offset >= FRAME_LENGTH_BYTES) {
        const length = buffered.readUInt32BE(offset);
        if (length > FRAME_MAX_BYTES) {
            throw new FrameTooLarge(length);
        }
        if (buffered.length - offset - FRAME_LENGTH_BYTES < length) {
            break;
        }
        frames.push(buffered.subarray(offset + FRAME_LENGTH_BYTES, offset + FRAME_LENGTH_BYTES + length));
        offset += FRAME_LENGTH_BYTES + length;
    }
    return { frames, rest: buffered.subarray(offset) };
};

interface Waiting {
    readonly settle: (answer: NetdAnswer | Error) => void;
    readonly timer: NodeJS.Timeout;
}

export const connectNetd = async (options: NetdLinkOptions): Promise<NetdLink> => {
    const socket = await new Promise<Socket>((resolve, reject) => {
        const dialed = connect(options.path);
        dialed.once("connect", () => resolve(dialed));
        dialed.once("error", reject);
    });
    const patienceMs = options.patienceMs ?? ASK_PATIENCE_MS;
    let tunnel = false;
    let buffered = Buffer.alloc(0);
    let nextId = 0;
    const waiting = new Map<number, Waiting>();
    const tell = (message: FromNode): void => {
        socket.write(frameOf(message));
    };
    const settle = (id: number, answer: NetdAnswer | Error): void => {
        const waiter = waiting.get(id);
        waiting.delete(id);
        if (waiter !== undefined) {
            clearTimeout(waiter.timer);
            waiter.settle(answer);
        }
    };
    // Rejects when netd refuses, does not answer in time, or the socket closes first.
    const ask = (question: NetdQuestion): Promise<NetdAnswer> =>
        new Promise((resolve, reject) => {
            if (socket.destroyed) {
                reject(new Error("netd is not connected"));
                return;
            }
            nextId = (nextId + 1) % 2 ** 32;
            const id = nextId;
            const timer = setTimeout(() => settle(id, new Error(`netd did not answer within ${patienceMs} ms`)), patienceMs);
            waiting.set(id, { settle: (answer) => (answer instanceof Error ? reject(answer) : resolve(answer)), timer });
            tell({ kind: "ask", id, question });
        });
    const sync = async (dirs: readonly string[]): Promise<(number | null)[]> => {
        try {
            const answer = await ask({ question: "sync", dirs: [...dirs] });
            return answer.generations;
        } catch {
            return dirs.map(() => null);
        }
    };
    const receive = (message: ToNode): void => {
        switch (message.kind) {
            case "tunnel":
                tunnel = message.connected;
                options.onTunnel(message.connected, message);
                return;
            case "answer":
                settle(message.id, message.answer);
                return;
            case "refused":
                settle(message.id, new Error(`netd refused: ${message.message}`));
                return;
            case "ask": {
                const { id, question } = message;
                // Answered where it lands, with nothing else between: the round trip is how netd reads this event
                // loop's lag (the vitals it answers for the sandbox), so it must cost the loop nothing but its turn.
                if (question.question === "ping") {
                    tell({ kind: "answer", id, answer: { answer: "pong" } });
                    return;
                }
                options.answer(question).then(
                    (answer) => tell({ kind: "answer", id, answer }),
                    (error: unknown) => tell({ kind: "refused", id, message: errorMessage(error) }),
                );
            }
        }
    };
    socket.on("data", (chunk: Buffer) => {
        let taken: ReturnType<typeof takeFrames>;
        try {
            taken = takeFrames(buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]));
        } catch (error) {
            // Framing lost: no later byte can be placed, so the link goes, and with it this daemon (netd-door.ts onClose).
            socket.destroy(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        // Copied, since `rest` is a view that would otherwise pin every chunk it was cut from.
        buffered = Buffer.from(taken.rest);
        for (const frame of taken.frames) {
            let message: ToNode;
            try {
                message = JSON.parse(frame.toString("utf8")) as ToNode;
            } catch (error) {
                // One bad frame, its bounds still known: skipped, and the frames after it in this read still delivered.
                options.onFault(new Error(`netd link: a frame was not JSON (${errorMessage(error)}); skipped`));
                continue;
            }
            receive(message);
        }
    });
    // netd is this process's parent: its socket closing means the sandbox is going down around it.
    socket.on("close", () => {
        // Deleting the entry being visited is safe in a Map's own iteration.
        for (const id of waiting.keys()) {
            settle(id, new Error("netd went away before answering"));
        }
        options.onClose();
    });
    socket.on("error", (error) => {
        options.onFault(error);
        socket.destroy();
    });
    return { tell, sync, tunnelConnected: () => tunnel, close: () => socket.end() };
};
