import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { ScopeError } from "../../policy.js";
import { dialLoopback, tunnelSocketUrl } from "./tunnel.js";

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
