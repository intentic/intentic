import { join } from "node:path";
import { type runnerContract,type NeedsAction,type RunnerFacts,RUNNER_HEARTBEAT_MS,type RunnerHello,RunnerHelloSchema,type RunnerSummary } from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";
import { z } from "zod";
import type { Services } from "../composition.js";
import type { PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";
import { parseDefinitionToml, settingsDefinition, settingsDrift } from "../portability/definition.js";
import { runnerParity } from "./runner-parity.js";

// A runner is a peer door (peers/): this sandbox's own execution container elsewhere, dialling in with its durable
// token and serving runnerContract. Every pairing is minted replayable, since it ends up immortal once burned into a
// container's env; the enrollment also records which device asked for it, the only way back to stop that container.

export type RunnerClient = ContractRouterClient<typeof runnerContract>;
// What a runner's hello asserts about its build and declared shape, kept beside the live socket for the parity card.
// `definitionToml` is replaced in place after a successful settings push (runner.routes.ts).
export type RunnerAnnounced = Pick<RunnerHello, "version" | "image" | "channel" | "overlayHash" | "definitionToml">;
export type RunnerHub = PeerHub<RunnerClient, RunnerAnnounced, RunnerFacts, never>;
export type RunnerStore = PeerStore<{ readonly host?: string | undefined }>;

export const RUNNER_PEER: PeerDoor<RunnerHello, RunnerAnnounced, { host: z.ZodOptional<z.ZodString> }> = {
    slug: "runners",
    noun: "runner",
    listKey: "runners",
    store: {
        files: (historyRoot) => ({ enrollments: join(historyRoot, "runner-enrollments.json"), consumed: join(historyRoot, "runner-pair-consumed.json") }),
        key: "runners", prefix: "irt_", extra: { host: z.string().optional() }, replayable: true
    },
    hub: {
        domain: "runners",
        // The runner's own watchdog is timed off the same number, which is why it lives in the contract both
        // sides read (runner-protocol.ts) rather than here.
        heartbeatMs: RUNNER_HEARTBEAT_MS,
        callTimeoutMs: 15 * 60 * 1000,
        offline: (id) => `The runner "${id}" is offline — its machine is asleep, or the runner container is down.`,
    },
    hello: {
        schema: RunnerHelloSchema,
        announced: ({ version, image, channel, overlayHash, definitionToml }) => ({
            version,
            image,
            ...(channel !== undefined ? { channel } : {}),
            ...(overlayHash !== undefined ? { overlayHash } : {}),
            ...(definitionToml !== undefined ? { definitionToml } : {}),
        }),
    },
    expired: "pairing expired or already used, mint a fresh one from the parent sandbox.",
};

// One line per environment/settings difference, surfaced not enforced. Overlay drift needs a rebuild; settings drift
// goes through the sync door. A bad claim costs its own line, not the list; undefined means never connected.
const runnerDriftLines = (
    services: Services,
    parent: Awaited<ReturnType<typeof settingsDefinition>>,
    announced: RunnerAnnounced | undefined,
): NeedsAction[] | undefined => {
    if (announced === undefined) {
        return undefined;
    }
    const lines: NeedsAction[] = [];
    const parentHash = services.config.sandbox.environmentHash;
    const runnerHash = announced.overlayHash ?? "";
    if (parentHash !== runnerHash) {
        lines.push({
            subject: "Environment overlay",
            detail:
                runnerHash === ""
                    ? "This sandbox runs an environment overlay; the runner runs the bare image. Remove and re-add it to rebuild with the overlay."
                    : parentHash === ""
                      ? "The runner was built with an environment overlay this sandbox no longer runs. Remove and re-add it to rebuild bare."
                      : "The runner was built from a different overlay than this sandbox runs. Remove and re-add it to rebuild from the current one.",
        });
    }
    if (announced.definitionToml !== undefined) {
        try {
            lines.push(...settingsDrift(parent, parseDefinitionToml(announced.definitionToml)));
        } catch {
            lines.push({ subject: "Declared settings", detail: "The runner's declared settings could not be read; update the runner to a build both sides understand." });
        }
    }
    return lines;
};

// Every enrolled runner with whatever the hub knows right now; "enrolled but never connected" must read differently
// from "connected but asleep".
export const runnerSummaries = async (services: Services): Promise<RunnerSummary[]> => {
    // Read once for the whole list, so every row's badge and drift lines are measured against the same build.
    const parentBuild = {
        image: services.config.sandbox.image,
        channel: services.config.sandbox.channel,
        overlayHash: services.config.sandbox.environmentHash,
    };
    const parent = await settingsDefinition(services);
    return (await services.runners.list()).map((runner) => {
        const state = services.runnerHub.state(runner.id);
        const drift = runnerDriftLines(services, parent, state.announced);
        return {
            id: runner.id,
            ...(runner.host !== undefined ? { host: runner.host } : {}),
            online: state.online,
            ...(state.announced === undefined
                ? {}
                : {
                      version: state.announced.version,
                      image: state.announced.image,
                      ...(state.announced.channel !== undefined ? { channel: state.announced.channel } : {}),
                      ...(state.announced.overlayHash !== undefined ? { overlayHash: state.announced.overlayHash } : {}),
                  }),
            ...(state.facts === undefined ? {} : { facts: state.facts }),
            ...(state.lastSeen === undefined ? {} : { lastSeen: state.lastSeen }),
            parity: runnerParity(parentBuild, state.announced),
            ...(drift !== undefined ? { drift } : {}),
        };
    });
};

export const runnerPeerRoutes = (services: Services) =>
    createPeerRoutes(services, RUNNER_PEER, { store: services.runners, hub: services.runnerHub, summaries: () => runnerSummaries(services) });
