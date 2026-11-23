import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { ORPCError } from "@orpc/server";
import type { Caller } from "../../auth/auth.js";
import { conversationReader, registryProvenance } from "../../auth/scope/conversation-reader.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import type { PortForwards } from "../../ports/port-forwards.js";
import type { RunnerClient } from "../runner-peer.js";
import { olderRunner, type RunnerRoster } from "./runner-calls.js";

// What a runner port's preview reads of the runners: who is enrolled, and the vetting door of one connected.
export interface RunnerPortDeps {
    // Undefined when this daemon runs without auth: the owner's own tools, for no member (runner-view-tickets.ts).
    readonly auth: unknown;
    // Which conversations run on which runner, and whose each is.
    readonly agents: {
        readonly list: () => readonly { readonly id: string; readonly runner?: string | undefined }[];
        readonly entry: (id: string) => PersistedAgent | undefined;
    };
    readonly runners: RunnerRoster;
    readonly runnerHub: { readonly client: (id: string) => Pick<RunnerClient, "vetPort"> | undefined; readonly offline: (id: string) => string };
}

/* A runner's port previewed at an address of this sandbox's own (2026-11-23): netd carries the preview down the runner's
   uplink (port-forwards.ts `forwardRunner`, PreviewRoute `runner`). The runner vets the port first, by the reasons this
   sandbox's own forward gives (ports/port-vet.ts), since only it can see what listens there. Who may: a maintainer who may
   read a conversation that runs on that runner, as for its views (runner-view-tickets.ts), since a runner runs without
   auth and anything listening there is the runner's to the bone. */

// Throws unless the caller may preview a port of this runner.
const assertMayPreview = (services: Pick<RunnerPortDeps, "auth" | "agents">, identity: Caller | undefined, runner: string): void => {
    if (services.auth !== undefined && (identity === undefined || !tierAtLeast(identity.tier, "maintainer"))) {
        throw new ORPCError("FORBIDDEN", { message: "a runner's ports are previewed by a maintainer" });
    }
    const reads = conversationReader(identity, registryProvenance(services.agents));
    if (!services.agents.list().some((agent) => agent.runner === runner && reads(agent.id))) {
        throw new ORPCError("FORBIDDEN", { message: `no conversation you may read runs on the runner "${runner}"` });
    }
};

export const forwardRunnerPort = async (
    services: RunnerPortDeps & { readonly portForwards: Pick<PortForwards, "forwardRunner"> },
    identity: Caller | undefined,
    runner: string,
    port: number,
    urlOf: (slot: string) => string | undefined,
): Promise<{ previewUrl?: string }> => {
    assertMayPreview(services, identity, runner);
    if (!(await services.runners.list()).some((enrolled) => enrolled.id === runner)) {
        throw new ORPCError("NOT_FOUND", { message: `"${runner}" is not one of this sandbox's runners` });
    }
    const client = services.runnerHub.client(runner);
    if (client === undefined) {
        throw new ORPCError("SERVICE_UNAVAILABLE", { message: services.runnerHub.offline(runner) });
    }
    let refused: string | undefined;
    try {
        refused = (await client.vetPort({ port })).refused;
    } catch (error) {
        if (error instanceof Error && olderRunner(error)) {
            throw new ORPCError("PRECONDITION_FAILED", {
                message: `The runner "${runner}" runs a build older than previews of its ports; update the runner.`,
            });
        }
        throw error;
    }
    if (refused !== undefined) {
        throw new ORPCError("BAD_REQUEST", { message: `On the runner "${runner}": ${refused}` });
    }
    const url = urlOf(services.portForwards.forwardRunner(runner, port));
    return url === undefined ? {} : { previewUrl: url };
};
