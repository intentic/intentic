import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { PeerDeflateServer } from "../peer-deflate.js";

// Run under Node by peer-deflate.integration.test.ts: Bun's own `ws` never negotiates an extension, so what this
// server agrees to is only observable on the runtime the daemon ships on. Prints, per path, the extensions the client
// was granted and whether a large frame came back whole.

const sockets = new PeerDeflateServer();
sockets.on("connection", (socket: WebSocket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
});
const server = http.createServer();
server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
// SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
const { port } = server.address() as AddressInfo;
const frame = JSON.stringify({ result: { content: [{ type: "text", text: "const value = 1;\n".repeat(20_000) }] } });

const probe = async (path: string): Promise<{ extensions: string; whole: boolean }> => {
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`);
    await new Promise((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
    });
    const echoed = new Promise<string>((resolve) => client.once("message", (data: Buffer) => resolve(data.toString("utf8"))));
    client.send(frame);
    const whole = (await echoed) === frame;
    client.close();
    return { extensions: client.extensions, whole };
};

const results: Record<string, { extensions: string; whole: boolean }> = {};
for (const path of ["/system/hosts/connect", "/system/runners/connect", "/browser/view", "/speech/listen", "/system/hosts/connect/extra"]) {
    results[path] = await probe(path);
}
sockets.close();
server.close();
process.stdout.write(JSON.stringify(results));
