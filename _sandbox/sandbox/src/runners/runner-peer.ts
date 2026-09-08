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

/* A RUNNER as a peer door (peers/): this sandbox's own execution container on another machine, dialling its
 * parent with its durable token in the first frame and serving `runnerContract` back (docs/remote-runners-plan.md,
 * workspace root). The host door's shape without its host-specific limbs: no scopes to push (a runner has no
 * owner-ticked grant, the parent is its whole authority) and no MCP bridge (runnerContract is typed end to
 * end, both ends being this daemon's own codebase by construction).
 *
 * What is this door's own: EVERY pairing is minted replayable, because a runner's pairing always ends up in a
 * container's env, immortal by comparison with this daemon (visible in `docker inspect`, replayed verbatim into
 * every rebuilt container), so the moment one works its digest is burned and the env copy is inert from then
 * on. And the enrollment records WHICH CONNECTED DEVICE HOLDS IT, when this sandbox is the one that asked for
 * it (the Devices view's create flow): the only way back to the machine that can stop or remove the container,
 * and something the runner itself cannot supply. */

export type RunnerClient = ContractRouterClient<typeof runnerContract>;
// What a runner's hello asserts about its build and declared shape, kept beside the live socket so the parity
// card can read it. `definitionToml` is replaced in place after a successful settings push (runner.routes.ts).
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

/* Where one runner's environment stands against this sandbox's, one line per difference — the parity card's
 * content (docs/remote-runners-plan.md §7: surfaced, not enforced). Two halves with two remedies:
 *
 *   overlay  — the hash the run contract stamped on each container, compared directly. A differing line says
 *              so and names the fix (remove and re-add: `ic runner up` rebuilds from the parent's current
 *              approved overlay), because no live-link call can swap a running container's image.
 *   settings — the runner's declared settings (its hello's definitionToml) against this sandbox's, via the
 *              definition machinery, fixable in place through the sync door.
 *
 * Total over a claim that does not parse: a runner from a stranger build costs its drift lines, never the list.
 * Undefined for a runner that never connected: there is nothing to compare, and an empty list would falsely
 * read as "agrees". */
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

// The owner's view: every enrolled runner, with whatever the hub knows about it right now. "Enrolled but
// never connected" must be distinguishable from "connected but asleep", the hosts view's rule.
export const runnerSummaries = async (services: Services): Promise<RunnerSummary[]> => {
    // What THIS sandbox is running, read once for the whole list: every row's parity is measured against it —
    // the one-word verdict (runner-parity.ts) and the itemized drift lines both, so the badge and its details
    // cannot disagree about the same runner.
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
