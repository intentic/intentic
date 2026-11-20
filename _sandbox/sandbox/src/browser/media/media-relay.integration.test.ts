import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, connect, createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { withMediaRelay } from "./media-relay.js";

// The daemon's fallback behind a netd older than the media route: the upgrade reaches the daemon's own HTTP server, which
// pipes it to the window's castd as bytes, head first. Real sockets on both sides; castd is a stand-in that records the
// head it was sent and echoes after its 101.

let dir = "";
let server: Server;
let port = 0;
const closers: (() => void)[] = [];

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "media-relay-"));
    server = createHttpServer();
    // Another upgrade listener, as hono's WebSocket adapter is: every path the relay does not take must still reach it.
    server.on("upgrade", (_request: IncomingMessage, socket: Duplex) => {
        socket.end("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nx-served-by: daemon\r\n\r\n");
    });
    withMediaRelay(server, dir);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo, never a pipe's string.
    port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
    for (const close of closers.splice(0)) {
        close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
});

// castd on `<dir>/<session>.sock`: the head it was sent goes on `heads`, then it switches and echoes.
const castdAt = async (session: string): Promise<string[]> => {
    const heads: string[] = [];
    const castd: NetServer = createServer((socket: Socket) => {
        let head = "";
        const onData = (chunk: Buffer): void => {
            head += chunk.toString("latin1");
            const end = head.indexOf("\r\n\r\n");
            if (end < 0) {
                return;
            }
            socket.off("data", onData);
            heads.push(head.slice(0, end));
            socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
            const rest = head.slice(end + 4);
            if (rest !== "") {
                socket.write(rest);
            }
            socket.pipe(socket);
        };
        socket.on("data", onData);
    });
    await new Promise<void>((resolve) => castd.listen(join(dir, `${session}.sock`), resolve));
    closers.push(() => castd.close());
    return heads;
};

// One request written raw; resolves with everything the server answered until `until` shows up or the socket ends.
const exchange = (head: string, until: string, after?: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const socket = connect({ port, host: "127.0.0.1" });
        let answer = "";
        socket.on("data", (chunk: Buffer) => {
            answer += chunk.toString("latin1");
            if (after !== undefined && answer.includes("\r\n\r\n") && !answer.includes(after)) {
                socket.write(after);
            }
            if (answer.includes(until)) {
                socket.destroy();
                resolve(answer);
            }
        });
        socket.on("end", () => resolve(answer));
        socket.on("error", reject);
        socket.write(head);
    });

const upgradeHead = (path: string): string =>
    `GET ${path} HTTP/1.1\r\nHost: sandbox-x.sbx.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;

describe("withMediaRelay", () => {
    test("a media upgrade is piped to its castd as it arrived, token and handshake headers included, then both ways", async () => {
        const heads = await castdAt("cast-_own");
        const answer = await exchange(upgradeHead("/system/browser-media/cast-_own?token=abc.def"), "frame-bytes", "frame-bytes");
        expect(answer.startsWith("HTTP/1.1 101")).toBe(true);
        expect(answer).toContain("frame-bytes");
        expect(answer).not.toContain("x-served-by");
        const [head] = heads;
        expect(head?.split("\r\n")[0]).toBe("GET /system/browser-media/cast-_own?token=abc.def HTTP/1.1");
        expect(head).toContain("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==");
        expect(head).toContain("Upgrade: websocket");
    });

    test("no castd listening is a 502 naming the session; a name that is no session's is a 404", async () => {
        const missing = await exchange(upgradeHead("/system/browser-media/cast-gone"), "cast-gone\u0000");
        expect(missing.startsWith("HTTP/1.1 502 Bad Gateway")).toBe(true);
        expect(missing.endsWith("no media daemon is serving the browser session cast-gone")).toBe(true);
        const bad = await exchange(upgradeHead("/system/browser-media/..%2Fkey"), "\u0000");
        expect(bad.startsWith("HTTP/1.1 404 Not Found")).toBe(true);
    });

    test("every other upgrade reaches the server's own listener, as before the relay", async () => {
        const answer = await exchange(upgradeHead("/system/browser-view?session=browser-own"), "x-served-by: daemon");
        expect(answer).toContain("x-served-by: daemon");
    });

    test("a target no URL parses is another listener's to answer, never a throw that leaves the socket hanging", async () => {
        for (const target of ["//", "//:99999", "/\\\\"]) {
            const answer = await exchange(upgradeHead(target), "x-served-by: daemon");
            expect(answer).toContain("x-served-by: daemon");
        }
    });

    test("only the media path as written is relayed, as netd matches it: a path that merely normalises to it is not", async () => {
        const heads = await castdAt("cast-_own");
        for (const target of ["/./system/browser-media/cast-_own", "/x/../system/browser-media/cast-_own", "//x/system/browser-media/cast-_own"]) {
            const answer = await exchange(upgradeHead(target), "x-served-by: daemon");
            expect(answer).toContain("x-served-by: daemon");
        }
        expect(heads).toEqual([]);
    });
});
