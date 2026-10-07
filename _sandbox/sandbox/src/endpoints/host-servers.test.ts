import type { Capability } from "@intentic/sandbox-contract";
import { findHostServers } from "./host-servers.js";

// The hosting computer as the container sees it: Ollama on its port, nothing on the others, and a web app on 8000 that
// answers but serves no model list.
const host = (answers: Readonly<Record<string, unknown>>) =>
    (async (url: string) => {
        const { port, pathname } = new URL(String(url));
        const body = answers[port];
        if (body === undefined) {
            throw new TypeError("fetch failed: connect ECONNREFUSED");
        }
        return pathname === "/v1/models"
            ? new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
            : new Response("", { status: 404 });
    }) as unknown as typeof fetch;

test("lists only the ports that answer with a model list, as the container reaches them", async () => {
    const fetchImpl = host({ "11434": { data: [{ id: "qwen3:32b" }, { id: "llama3.2:latest" }] }, "8000": "<html>my app</html>" });
    expect(await findHostServers([], fetchImpl)).toEqual([
        { kind: "ollama", label: "Ollama", baseUrl: "http://host.docker.internal:11434/v1", models: ["qwen3:32b", "llama3.2:latest"] },
    ]);
});

// Ollama with nothing pulled is running; the row has to be able to say "no models yet" rather than hide it.
test("a server with no models yet still counts", async () => {
    const servers = await findHostServers([], host({ "1234": { data: [] } }));
    expect(servers.map(({ label, models }) => ({ label, models }))).toEqual([{ label: "LM Studio", models: [] }]);
});

test("names the connection that already points at a server, however its address was typed", async () => {
    const capabilities = [
        { id: "ollama", kind: "endpoint", config: { baseUrl: "http://HOST.docker.internal:11434/", protocol: "openai" } },
    ] as unknown as Capability[];
    const [server] = await findHostServers(capabilities, host({ "11434": { data: [{ id: "qwen3:32b" }] } }));
    expect(server?.capability).toBe("ollama");
});
