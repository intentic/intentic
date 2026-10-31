import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { startEngineDockerProxy } from "./engine-docker-proxy.js";

const fixture = "intentic-sandbox-winengine";
const fixtureId = "a".repeat(64);
const legacy = "intentic-sandbox-runner-omen";
const legacyId = "b".repeat(64);
const execId = "d".repeat(64);
let upstream: Server;
let proxy: Awaited<ReturnType<typeof startEngineDockerProxy>>;
let base: string;
let reached: string[];
let sockets: Set<Socket>;
let finishWait: (() => void) | undefined;
let createdBody: string;

beforeEach(async () => {
    reached = [];
    finishWait = undefined;
    createdBody = "";
    sockets = new Set();
    upstream = createServer((incoming, outgoing) => {
        const path = incoming.url ?? "";
        reached.push(path);
        outgoing.setHeader("content-type", "application/json");
        if (path.endsWith("/containers/json")) {
            outgoing.end(JSON.stringify([
                { Id: fixtureId, Names: [`/${fixture}`] }, { Id: legacyId, Names: [`/${legacy}`] },
            ]));
        } else if (path.includes("/wait?")) {
            outgoing.writeHead(200);
            outgoing.flushHeaders();
            finishWait = () => outgoing.end(JSON.stringify({ StatusCode: 0 }));
        } else if (path.endsWith("/containers/create")) {
            incoming.on("data", (chunk: Buffer) => { createdBody += chunk.toString(); });
            incoming.on("end", () => outgoing.writeHead(201).end(JSON.stringify({ Id: fixtureId })));
        } else if (path.endsWith("/exec")) { outgoing.writeHead(201).end(JSON.stringify({ Id: execId })); }
        else { outgoing.end(JSON.stringify({ Id: fixtureId })); }
    });
    upstream.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    upstream.on("upgrade", (incoming, socket, head) => {
        reached.push(incoming.url ?? "");
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
        socket.write(head);
        socket.pipe(socket);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    // SAFETY: the awaited listen above names a TCP port.
    const port = (upstream.address() as AddressInfo).port;
    proxy = await startEngineDockerProxy({ hostname: "127.0.0.1", port });
    base = proxy.host.replace("tcp:", "http:");
});

afterEach(async () => {
    await proxy.close();
    for (const socket of sockets) { socket.destroy(); }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

test("the real source inventory contains only the move fixture, including when the host holds an unstamped legacy sandbox", async () => {
    const response = await fetch(`${base}/v1.45/containers/json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ Id: fixtureId, Names: [`/${fixture}`] }]);
    expect((await fetch(`${base}/v1.45/containers/${fixtureId}/json`)).status).toBe(200);
    expect((await fetch(`${base}/v1.45/containers/${legacyId}/stop`, { method: "POST" })).status).toBe(403);
    expect(reached).toEqual(["/v1.45/containers/json", `/v1.45/containers/${fixtureId}/json`]);
});

test("direct requests cannot inspect, stop, rename, remove or commit another sandbox", async () => {
    for (const [method, path] of [
        ["GET", `/containers/${legacy}/json`], ["POST", `/containers/${legacy}/stop`],
        ["POST", `/containers/${legacy}/rename?name=hidden`], ["DELETE", `/containers/${legacy}`],
        ["POST", `/commit?container=${legacy}`], ["POST", "/containers/create?name=unrelated"],
        ["POST", `/containers/${fixture}/rename?name=${legacy}`],
    ] as const) {
        expect((await fetch(`${base}/v1.45${path}`, { method })).status).toBe(403);
    }
    expect(reached).toEqual([]);
});

test("a fixture's parked name and anonymous volume helper remain usable, while unknown exec IDs are refused", async () => {
    expect((await fetch(`${base}/v1.45/containers/${fixture}/rename?name=${fixture}.moved`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/v1.45/containers/${fixture}.moved/json`)).status).toBe(200);
    expect((await fetch(`${base}/v1.45/containers/create`, { method: "POST", body: "{}" })).status).toBe(201);
    expect((await fetch(`${base}/v1.45/exec/${legacyId}/start`, { method: "POST" })).status).toBe(403);
});

test("docker exec forwards the upgraded byte stream only for an exec created on the fixture", async () => {
    expect((await fetch(`${base}/v1.45/containers/${fixture}/exec`, { method: "POST", body: "{}" })).status).toBe(201);
    const body = "the attached exec stream";
    const echoed = await new Promise<string>((resolve, reject) => {
        const url = new URL(base);
        const client = connect({ host: url.hostname, port: Number(url.port) });
        client.setTimeout(5_000, () => client.destroy(new Error("Docker upgrade did not finish")));
        let output = "";
        let upgraded = false;
        client.on("connect", () => client.write(`POST /v1.45/exec/${execId}/start HTTP/1.1\r\nHost: docker.local\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`));
        client.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (!upgraded) {
                const end = output.indexOf("\r\n\r\n");
                if (end === -1) { return; }
                if (!output.startsWith("HTTP/1.1 101")) { client.destroy(new Error(output)); return; }
                upgraded = true;
                output = output.slice(end + 4);
                client.write(body);
            }
            if (output.length >= body.length) { client.destroy(); resolve(output); }
        });
        client.on("error", reject);
    });
    expect(echoed).toBe(body);
    expect(reached).toEqual([`/v1.45/containers/${fixture}/exec`, `/v1.45/exec/${execId}/start`]);
});

test("Docker receives wait headers before the container has exited", async () => {
    const response = await fetch(`${base}/v1.45/containers/${fixture}/wait?condition=removed`, {
        method: "POST", signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
    finishWait?.();
    expect(await response.json()).toEqual({ StatusCode: 0 });
});

test("container creation preserves the JSON request body", async () => {
    const body = JSON.stringify({ Image: "sandbox", HostConfig: { Binds: ["workspace:/work"] } });
    const response = await fetch(`${base}/v1.45/containers/create`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ Id: fixtureId });
    expect(createdBody).toBe(body);
});
