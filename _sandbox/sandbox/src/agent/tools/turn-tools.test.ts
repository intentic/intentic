import { withoutShadowing } from "./turn-tools.js";

// A linked sandbox's or a contact's server is named by another sandbox, so it never replaces one the turn already mounts
// (mcpServersOf merges last-wins): a guest naming a daemon server, a host server, or a guest before it is left out.

const tool = (name: string) => ({ name, url: `http://127.0.0.1/mcp/${name}` });

test("a guest naming a daemon server, a server the turn mounts, or an earlier guest is left out, the rest kept in order", () => {
    const hosts = [tool("intentic"), tool("github"), tool("web")];
    const guests = [tool("ui"), tool("subagents"), tool("github"), tool("ops"), tool("ops"), tool("acme")];
    expect(withoutShadowing(guests, hosts).map((guest) => guest.name)).toEqual(["ops", "acme"]);
});
