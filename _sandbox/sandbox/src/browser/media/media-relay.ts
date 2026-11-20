import type { IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { BROWSER_MEDIA_PATH } from "@intentic/sandbox-contract/browser-wire";
import { CAST_DIR } from "./media-token.js";

/* The media socket behind a netd older than its media route (netd's README): such a netd hands
   `/system/browser-media/<session>` to the daemon like any upgrade, and this relays it on to that window's castd as the
   bytes it is. Not a frame reader: the request head is written to castd's socket as it arrived, and from then on the two
   sockets are piped both ways, so the token is castd's to check and nothing of the picture is parsed here. A netd with
   the route never lets the path reach the daemon at all. */

const NAME = /^[A-Za-z0-9_-]{1,64}$/u;

// The session a media path names; undefined for any other path, "invalid" for a media path naming none. Read off the
// request target as written, as netd's route reads it (route.rs `media`), never normalised: the target is what castd is
// sent, so the path checked is the path castd routes, and a target no URL parses (`//`) is simply not this route's.
const mediaSessionOf = (url: string | undefined): string | undefined | "invalid" => {
    const raw = url ?? "/";
    const query = raw.indexOf("?");
    const path = query < 0 ? raw : raw.slice(0, query);
    if (path !== BROWSER_MEDIA_PATH && !path.startsWith(`${BROWSER_MEDIA_PATH}/`)) {
        return undefined;
    }
    const name = path.slice(BROWSER_MEDIA_PATH.length + 1);
    return NAME.test(name) ? name : "invalid";
};

const refuse = (socket: Duplex, status: string, words: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(words)}\r\nconnection: close\r\n\r\n${words}`);
};

// The request head as it arrived, raw header names and all: castd answers the WebSocket handshake itself.
const headOf = (request: IncomingMessage): string => {
    const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    return `${lines.join("\r\n")}\r\n\r\n`;
};

// Relays one upgrade to `<dir>/<session>.sock` when it is a media path, answering it either way; false for any other
// path, which is left to whoever else serves upgrades.
const relayMediaUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer, dir: string = CAST_DIR): boolean => {
    const session = mediaSessionOf(request.url);
    if (session === undefined) {
        return false;
    }
    if (session === "invalid") {
        refuse(socket, "404 Not Found", "a browser media socket names its session: [A-Za-z0-9_-]{1,64}");
        return true;
    }
    const castd = connect({ path: join(dir, `${session}.sock`) });
    let piped = false;
    castd.once("connect", () => {
        piped = true;
        castd.write(headOf(request));
        if (head.length > 0) {
            castd.write(head);
        }
        socket.pipe(castd);
        castd.pipe(socket);
    });
    castd.once("error", () => {
        if (piped) {
            socket.destroy();
        } else {
            refuse(socket, "502 Bad Gateway", `no media daemon is serving the browser session ${session}`);
        }
    });
    socket.once("error", () => castd.destroy());
    socket.once("close", () => castd.destroy());
    castd.once("close", () => socket.destroy());
    return true;
};

// Puts the relay in front of every other upgrade the server answers: the server's own `upgrade` listeners (hono's
// WebSocket adapter) see only the paths it does not take, and still count as the only listener, so their refusal of
// an unknown path is unchanged.
export const withMediaRelay = (server: Server, dir: string = CAST_DIR): void => {
    // SAFETY: an http.Server emits `upgrade` with (request, socket, head) and nothing else, so every listener of it
    // takes those three.
    const others = server.listeners("upgrade") as ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
    server.removeAllListeners("upgrade");
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (relayMediaUpgrade(request, socket, head, dir)) {
            return;
        }
        for (const listener of others) {
            listener.call(server, request, socket, head);
        }
    });
};
