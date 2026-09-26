import { connect, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import {
    ASK_PATIENCE_MS,
    FRAME_LENGTH_BYTES,
    type Answer,
    type FromNode,
    type FrontAnswer,
    type FrontQuestion,
    type Question,
    type ToNode,
} from "@intentic/sandbox-contract/front-wire";

// Node's half of the control socket to intentic-front (the front's half is _sandbox/front, link.rs): one Unix socket,
// each frame a 4-byte big-endian length then that many bytes of JSON, the types generated from the front's own crate.
// Either side may ask the other: an `ask` carrying an id, answered by an `answer` or a `refused` carrying the same one,
// waited for ASK_PATIENCE_MS.

export interface FrontLink {
    // Sends one message; the socket keeps order, so the front applies them as sent.
    readonly tell: (message: FromNode) => void;
    // Each checkout's change count, in the order asked: null for one the front does not count, and for every one when
    // the front does not answer.
    readonly sync: (dirs: readonly string[]) => Promise<(number | null)[]>;
    readonly tunnelConnected: () => boolean;
    readonly close: () => void;
}

export interface FrontLinkOptions {
    readonly path: string;
    // Answers the front's questions; a throw goes back as a refusal carrying its message.
    readonly answer: (question: Question) => Promise<Answer>;
    readonly onTunnel: (connected: boolean) => void;
    readonly onClose: () => void;
    // How long a question of Node's waits for the front; ASK_PATIENCE_MS unless a test says otherwise.
    readonly patienceMs?: number;
}

export const frameOf = (message: FromNode): Buffer => {
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(FRAME_LENGTH_BYTES + json.length);
    frame.writeUInt32BE(json.length, 0);
    json.copy(frame, FRAME_LENGTH_BYTES);
    return frame;
};

// Splits whatever has arrived into whole frames, keeping a partial one for the next read.
export const takeFrames = (buffered: Buffer): { readonly frames: Buffer[]; readonly rest: Buffer } => {
    const frames: Buffer[] = [];
    let offset = 0;
    while (buffered.length - offset >= FRAME_LENGTH_BYTES) {
        const length = buffered.readUInt32BE(offset);
        if (buffered.length - offset - FRAME_LENGTH_BYTES < length) {
            break;
        }
        frames.push(buffered.subarray(offset + FRAME_LENGTH_BYTES, offset + FRAME_LENGTH_BYTES + length));
        offset += FRAME_LENGTH_BYTES + length;
    }
    return { frames, rest: buffered.subarray(offset) };
};

interface Waiting {
    readonly settle: (answer: FrontAnswer | Error) => void;
    readonly timer: NodeJS.Timeout;
}

export const connectFront = async (options: FrontLinkOptions): Promise<FrontLink> => {
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
    const settle = (id: number, answer: FrontAnswer | Error): void => {
        const waiter = waiting.get(id);
        waiting.delete(id);
        if (waiter !== undefined) {
            clearTimeout(waiter.timer);
            waiter.settle(answer);
        }
    };
    // Rejects when the front refuses, does not answer in time, or the socket closes first.
    const ask = (question: FrontQuestion): Promise<FrontAnswer> =>
        new Promise((resolve, reject) => {
            if (socket.destroyed) {
                reject(new Error("the front is not connected"));
                return;
            }
            nextId = (nextId + 1) % 2 ** 32;
            const id = nextId;
            const timer = setTimeout(() => settle(id, new Error(`the front did not answer within ${patienceMs} ms`)), patienceMs);
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
                options.onTunnel(message.connected);
                return;
            case "answer":
                settle(message.id, message.answer);
                return;
            case "refused":
                settle(message.id, new Error(`the front refused: ${message.message}`));
                return;
            case "ask": {
                const { id, question } = message;
                options.answer(question).then(
                    (answer) => tell({ kind: "answer", id, answer }),
                    (error: unknown) => tell({ kind: "refused", id, message: errorMessage(error) }),
                );
            }
        }
    };
    socket.on("data", (chunk: Buffer) => {
        const { frames, rest } = takeFrames(buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]));
        // Copied, since `rest` is a view that would otherwise pin every chunk it was cut from.
        buffered = Buffer.from(rest);
        for (const frame of frames) {
            receive(JSON.parse(frame.toString("utf8")) as ToNode);
        }
    });
    // The front is this process's parent: its socket closing means the sandbox is going down around it.
    socket.on("close", () => {
        // Deleting the entry being visited is safe in a Map's own iteration.
        for (const id of waiting.keys()) {
            settle(id, new Error("the front went away before answering"));
        }
        options.onClose();
    });
    socket.on("error", () => socket.destroy());
    return { tell, sync, tunnelConnected: () => tunnel, close: () => socket.end() };
};
