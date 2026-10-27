import type { TrialStatusResponse } from "@intentic/sandbox-contract/contracts/endpoints.contract";
import { demoLocalModelFit, demoStartPrefetch } from "../../fixture/sandbox";
import { freshEdition, noModels } from "../../mode";
import { endpointModels } from "./capabilities";
import type { Doors } from "../doors";

// A fresh sandbox has signed nothing in: the daemon-provisioned free trial is the one thing a chat can run on, with
// its whole day ahead of it. Every other recording runs on its connected Claude and has no trial to offer.
const DEMO_TRIAL: TrialStatusResponse = freshEdition && !noModels
    ? { available: true, allowance: 30, used: 0, remaining: 30, health: `healthy` }
    : { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };

export const endpointsDoors = {
    trial: () => DEMO_TRIAL,
    // A connected model server's catalog, asked of the endpoint connection the Capabilities page holds.
    models: ({ id }) => endpointModels(id),
    // What the connect view's local lane draws: a 32 GB laptop with nothing downloaded yet.
    localModelFit: () => demoLocalModelFit(),
    // Nothing is really fetched here; the press flips the fixture so the lane draws the state it has the most to say
    // about — a transfer under way, with the Stop that declines it.
    localModelPrefetch: ({ action }) => demoStartPrefetch(action === `start`),
    // Ollama on the laptop, serving two models and not yet pointed at: the row the panel has the most to say about.
    hostServers: () => ({
        servers: [{ kind: `ollama`, label: `Ollama`, baseUrl: `http://host.docker.internal:11434/v1`, models: [`qwen3:32b`, `llama3.2:latest`] }],
    }),
} satisfies Doors<`endpoints`>;
