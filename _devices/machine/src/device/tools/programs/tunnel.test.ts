import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { ScopeError } from "../../policy.js";
import { dialLoopback, hostDialFailure, tunnelSocketUrl } from "./device-tunnel.js";

// This machine's end of a `devices reach` tunnel: allowed by either switch that already reaches its loopback, said
// plainly when nothing listens on the port, and aimed at the daemon the link dialled.

const off: DeviceScopes = { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" };
const ticket = "a".repeat(48);

test("the tunnel route is the link's own daemon, over ws or wss as the link is", () => {
    expect(tunnelSocketUrl("https://sandbox-x.example.dev/")).toBe("wss://sandbox-x.example.dev/system/hosts/tunnel");
    expect(tunnelSocketUrl("http://127.0.0.1:8123")).toBe("ws://127.0.0.1:8123/system/hosts/tunnel");
});

test("with both switches off nothing is dialled, and either one is enough to get past the switch", async () => {
    await expect(dialLoopback({ ticket, port: 1 }, off, "http://127.0.0.1:1")).rejects.toBeInstanceOf(ScopeError);
    // Past the switch, the next thing said is about the port, not the switch.
    await expect(dialLoopback({ ticket, port: 1 }, { ...off, programs: "on" }, "http://127.0.0.1:1")).rejects.toThrow("nothing is listening on port 1");
    await expect(dialLoopback({ ticket, port: 1 }, { ...off, shell: "on" }, "http://127.0.0.1:1")).rejects.toThrow("nothing is listening on port 1");
});

test("a link that is not connected says so rather than dialling anywhere", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    await expect(dialLoopback({ ticket, port }, { ...off, programs: "on" }, undefined)).rejects.toThrow("not connected");
    server.close();
});

// (2026-11-10) A host on this machine's network, dialled the way any program here would: behind the same switches, and a
// failure said in words that point at what to fix here (the name, the VPN), before any WebSocket opens.
test("a host on the network is behind the same switches as the loopback", async () => {
    await expect(dialLoopback({ ticket, port: 445, host: "127.0.0.1" }, off, "http://127.0.0.1:1")).rejects.toBeInstanceOf(ScopeError);
});

test("a host that refuses the port is said to refuse it, from this computer", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    // SAFETY: a server listening on a TCP port answers address() with an AddressInfo, never a pipe name or null.
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, "close");
    await expect(dialLoopback({ ticket, port, host: "127.0.0.1" }, { ...off, shell: "on" }, "http://127.0.0.1:1")).rejects.toThrow(
        `127.0.0.1 refused port ${port} from this computer`,
    );
});

test("a name this computer cannot resolve says so, and points at the VPN whose DNS would know it", async () => {
    await expect(dialLoopback({ ticket, port: 445, host: "nas.invalid" }, { ...off, programs: "on" }, "http://127.0.0.1:1")).rejects.toThrow(
        "this computer cannot resolve nas.invalid",
    );
});

test("each way a dial fails reads as what to check on this computer", () => {
    expect(hostDialFailure("nas.corp", 445, "EAI_AGAIN", "x")).toContain("cannot resolve nas.corp");
    expect(hostDialFailure("10.0.0.5", 445, "EHOSTUNREACH", "x")).toContain("no route to 10.0.0.5");
    expect(hostDialFailure("10.0.0.5", 445, "ENETUNREACH", "x")).toContain("is the VPN it sits behind connected here?");
    expect(hostDialFailure("10.0.0.5", 445, "ETIMEDOUT", "x")).toContain("did not answer from this computer");
    expect(hostDialFailure("10.0.0.5", 445, "EPIPE", "broken pipe")).toBe("could not reach 10.0.0.5:445 from this computer: broken pipe");
});
