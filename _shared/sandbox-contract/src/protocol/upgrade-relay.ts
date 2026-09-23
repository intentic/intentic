import type { ClientRequest } from "node:http";
import type { Duplex } from "node:stream";

// `upstream` is the client's handshake replayed; a 101 is echoed and bytes flow raw, any other answer ends the socket.
export const relayUpgrade = (upstream: ClientRequest, socket: Duplex, head: Buffer): void => {
    upstream.on("error", () => socket.destroy());
    upstream.on("response", (answer) => {
        socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}\r\n\r\n`);
    });
    upstream.on("upgrade", (answer, upstreamSocket, upstreamHead) => {
        const lines: string[] = [];
        for (let index = 0; index < answer.rawHeaders.length; index += 2) {
            lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`);
        }
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
        if (upstreamHead.length > 0) {
            socket.write(upstreamHead);
        }
        if (head.length > 0) {
            upstreamSocket.write(head);
        }
        upstreamSocket.on("error", () => socket.destroy());
        socket.on("error", () => upstreamSocket.destroy());
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
    });
    upstream.end();
};
