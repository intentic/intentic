import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FromNode, ToNode } from "@intentic/sandbox-contract/front-wire";
import { connectFront, takeFrames } from "./front-link.js";

// A real Unix socket standing in for the front: Node dials it, answers a question by id, and hears the tunnel.

let dir: string;
let server: Server;
let front: Promise<Socket>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "front-link-"));
    server = createServer();
    front = new Promise((resolve) => server.once("connection", resolve));
    await new Promise<void>((resolve) => server.listen(join(dir, "front.sock"), resolve));
});

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
});

// What the front writes, framed the way its link.rs frames it.
const toNode = (message: ToNode): Buffer => {
    const json = Buffer.from(JSON.stringify(message));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(json.length);
    return Buffer.concat([head, json]);
};

const nextMessage = (socket: Socket): Promise<FromNode> =>
    new Promise((resolve) => {
        let buffered = Buffer.alloc(0);
        const read = (chunk: Buffer): void => {
            const { frames, rest } = takeFrames(Buffer.concat([buffered, chunk]));
            buffered = Buffer.from(rest);
            const [first] = frames;
            if (first !== undefined) {
                socket.off("data", read);
                resolve(JSON.parse(first.toString("utf8")) as FromNode);
            }
        };
        socket.on("data", read);
    });

test("answers the front's question under its id and reports the tunnel", async () => {
    const tunnels: boolean[] = [];
    const link = await connectFront({
        path: join(dir, "front.sock"),
        answer: () => Promise.resolve({ answer: "preview", route: { to: "node" } }),
        onTunnel: (connected) => tunnels.push(connected),
        onClose: () => undefined,
    });
    const socket = await front;
    const answered = nextMessage(socket);
    socket.write(toNode({ kind: "ask", id: 41, question: { question: "preview", host: "preview-web.localhost" } }));
    expect(await answered).toEqual({ kind: "answer", id: 41, answer: { answer: "preview", route: { to: "node" } } });

    socket.write(toNode({ kind: "tunnel", connected: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tunnels).toEqual([true]);
    expect(link.tunnelConnected()).toBe(true);
    link.close();
});

test("a throwing answer goes back as a refusal carrying its message", async () => {
    const link = await connectFront({
        path: join(dir, "front.sock"),
        answer: () => Promise.reject(new Error("no such panel")),
        onTunnel: () => undefined,
        onClose: () => undefined,
    });
    const socket = await front;
    const refused = nextMessage(socket);
    socket.write(toNode({ kind: "ask", id: 7, question: { question: "preview", host: "preview-x.localhost" } }));
    expect(await refused).toEqual({ kind: "refused", id: 7, message: "no such panel" });
    link.close();
});
