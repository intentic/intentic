import { methods } from "@agentclientprotocol/sdk";
import { fakeAcpAgentApp, fakeAcpConnection } from "../acp/__fixtures__/fake-acp-agent.js";
import { CLI_OWN_PICK, cliCatalogOf, offeredModels } from "./vendor-cli-catalog.js";

/* A CLI's model list as its own session offers it: every model, each with the reasoning depths it takes. */

test("every model the session offers is listed with the depths it takes, the session's own model the default", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp({ models: ["kimi-k3", "kimi-k2"], thoughts: ["off", "low", "high"] }));
    const created = await connection.agent.request(methods.agent.session.new, { cwd: "/nowhere", mcpServers: [] });
    const offered = await offeredModels(connection, created.sessionId, created.configOptions);
    // `off` names no tier on the shared ladder, so it is not an effort.
    expect(offered).toEqual([
        { value: "kimi-k3", name: "KIMI-K3", current: true, efforts: ["low", "high"] },
        { value: "kimi-k2", name: "KIMI-K2", efforts: ["low", "high"] },
    ]);
    expect(cliCatalogOf(offered)).toEqual({
        models: [
            { id: "kimi-k3", label: "KIMI-K3", efforts: ["low", "high"] },
            { id: "kimi-k2", label: "KIMI-K2", efforts: ["low", "high"] },
        ],
        default: "kimi-k3",
    });
});

test("a session that offers no model option lists nothing, and the floor is the CLI's own pick", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp());
    const created = await connection.agent.request(methods.agent.session.new, { cwd: "/nowhere", mcpServers: [] });
    expect(await offeredModels(connection, created.sessionId, created.configOptions)).toEqual([]);
    expect(cliCatalogOf([]).default).toBe(CLI_OWN_PICK);
});
