import { type Capability, providersContract, TRIAL_ENDPOINT_ID, TRIAL_LABEL } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { ProvidersRoutesDeps } from "./providers.routes.js";
import { routesClient } from "../../harness/route-client.testing.js";
import { memoryCapabilitiesStore } from "../../harness/route-stores.testing.js";
import { createProvidersRoutes } from "./providers.routes.js";

/* What a chat may be addressed to here, from the tier that drives turns but may not read /capabilities. */

const client = (capabilities: Capability[]) =>
    routesClient(providersContract, createProvidersRoutes({ capabilities: memoryCapabilitiesStore(capabilities) } as ProvidersRoutesDeps));

test("names the ACP agents and endpoints, and nothing else the box connects to", async () => {
    const providers = client([
        { id: "goose", kind: "agent", config: { command: "goose acp", name: "Goose" } },
        { id: "codebuddy", kind: "agent", config: { command: "codebuddy acp" } },
        { id: "together", kind: "endpoint", config: { baseUrl: "https://api.together.xyz/v1", protocol: "openai" } },
        { id: "qwen-local", kind: "localmodel", config: { model: "Qwen/Qwen3-8B", gpu: "off", context: "65536" } },
        // The rows this read exists to leave out: a chat can't be addressed to them, and naming them here would hand
        // the connector inventory to a tier that cannot read it.
        { id: "github", kind: "cli", config: { provider: "github" } },
        { id: "monorepo", kind: "monorepo", config: {} },
    ]);

    expect(await providers.list()).toEqual({
        // An agent's label is its own name where it declared one, its id otherwise.
        agents: [
            { id: "goose", label: "Goose" },
            { id: "codebuddy", label: "codebuddy" },
        ],
        // Weights the box runs itself and a server it was pointed at both mint `endpoint/<id>`; only `kind` tells them
        // apart afterwards.
        endpoints: [
            { id: "endpoint/together", label: "together", kind: "endpoint" },
            { id: "endpoint/qwen-local", label: "qwen-local", kind: "localmodel" },
        ],
    });
});

test("the trial is the one endpoint the user did not name, so it carries the shared label", async () => {
    const providers = client([{ id: TRIAL_ENDPOINT_ID, kind: "endpoint", config: { baseUrl: "https://trial.intentic.dev/v1", protocol: "openai" } }]);
    expect((await providers.list()).endpoints).toEqual([{ id: `endpoint/${TRIAL_ENDPOINT_ID}`, label: TRIAL_LABEL, kind: "endpoint" }]);
});

test("a box that adds no provider of its own answers empty, which is an answer", async () => {
    expect(await client([]).list()).toEqual({ agents: [], endpoints: [] });
});
