import { connect, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import type { Answer, FromNode, Question, ToNode } from "@intentic/sandbox-contract/front-wire";

// Node's half of the control lane to intentic-front (the front's half is _sandbox/front, link.rs): one Unix socket,
// each frame a 4-byte big-endian length then that many bytes of JSON, the types generated from the front's own crate.

// front-wire's LENGTH_BYTES; the golden frame in front-link.test.ts pins the same bytes the Rust test does.
const LENGTH_BYTES = 4;

// Set by intentic-front on the daemon it spawns: where to dial the lane, and where to serve HTTP.
export const CONTROL_SOCKET_ENV = "INTENTIC_FRONT_SOCKET";
export const HTTP_SOCKET_ENV = "INTENTIC_NODE_SOCKET";

export interface FrontLink {
    // Sends one message; the lane keeps order, so the front applies them as sent.
    readonly tell: (message: FromNode) => void;
    // Each checkout's change count, in the order asked: null for one the front does not count, and for every one when
    // the lane closes first.
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
}

export const frameOf = (message: FromNode): Buffer => {
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(LENGTH_BYTES + json.length);
    frame.writeUInt32BE(json.length, 0);
    json.copy(frame, LENGTH_BYTES);
    return frame;
};

// Splits whatever has arrived into whole frames, keeping a partial one for the next read.
export const takeFrames = (buffered: Buffer): { readonly frames: Buffer[]; readonly rest: Buffer } => {
    const frames: Buffer[] = [];
    let offset = 0;
    while (buffered.length - offset >= LENGTH_BYTES) {
        const length = buffered.readUInt32BE(offset);
        if (buffered.length - offset - LENGTH_BYTES < length) {
            break;
        }
        frames.push(buffered.subarray(offset + LENGTH_BYTES, offset + LENGTH_BYTES + length));
        offset += LENGTH_BYTES + length;
    }
    return { frames, rest: buffered.subarray(offset) };
};

export const connectFront = async (options: FrontLinkOptions): Promise<FrontLink> => {
    const socket = await new Promise<Socket>((resolve, reject) => {
        const dialed = connect(options.path);
        dialed.once("connect", () => resolve(dialed));
        dialed.once("error", reject);
    });
    let tunnel = false;
    let buffered = Buffer.alloc(0);
    let nextSync = 0;
    const syncing = new Map<number, { readonly dirs: number; readonly resolve: (generations: (number | null)[]) => void }>();
    const tell = (message: FromNode): void => {
        socket.write(frameOf(message));
    };
    const sync = (dirs: readonly string[]): Promise<(number | null)[]> =>
        new Promise((resolve) => {
            if (socket.destroyed) {
                resolve(dirs.map(() => null));
                return;
            }
            nextSync = (nextSync + 1) % 2 ** 32;
            syncing.set(nextSync, { dirs: dirs.length, resolve });
            tell({ kind: "sync", id: nextSync, dirs: [...dirs] });
        });
    const receive = (message: ToNode): void => {
        if (message.kind === "tunnel") {
            tunnel = message.connected;
            options.onTunnel(message.connected);
            return;
        }
        if (message.kind === "synced") {
            syncing.get(message.id)?.resolve(message.generations);
            syncing.delete(message.id);
            return;
        }
        const { id, question } = message;
        options.answer(question).then(
            (answer) => tell({ kind: "answer", id, answer }),
            (error: unknown) => tell({ kind: "refused", id, message: errorMessage(error) }),
        );
    };
    socket.on("data", (chunk: Buffer) => {
        const { frames, rest } = takeFrames(buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]));
        // Copied, since `rest` is a view that would otherwise pin every chunk it was cut from.
        buffered = Buffer.from(rest);
        for (const frame of frames) {
            receive(JSON.parse(frame.toString("utf8")) as ToNode);
        }
    });
    // The front is this process's parent: its lane closing means the sandbox is going down around it.
    socket.on("close", () => {
        for (const waiting of syncing.values()) {
            waiting.resolve(Array.from({ length: waiting.dirs }, () => null));
        }
        syncing.clear();
        options.onClose();
    });
    socket.on("error", () => socket.destroy());
    return { tell, sync, tunnelConnected: () => tunnel, close: () => socket.end() };
};
