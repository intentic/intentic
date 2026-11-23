import { runnersContract } from "@intentic/sandbox-contract/contracts/runners.contract";
import type { RunnerOpenViewInput, RunnerView } from "@intentic/sandbox-contract/schemas/runner-views";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Caller } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import { mintRunnerViewTicket, type RunnerViewDeps, RunnerViewRefused, type RunnerViewTickets } from "../uplink/runner-view-tickets.js";
import type { RunnerSockets } from "./runner-calls.js";
import { runnerOf } from "./runner-stops.js";

/* The editor's `runners.openView` (runners.contract.ts, 2026-11-23): a live view of the runner a conversation runs on,
   as a path under `/system/runner-view/<runner>/…` on this sandbox's own address with a one-shot ticket its netd redeems
   here (uplink/runner-view-tickets.ts). The ticket's own rules decide who may: a maintainer who may read the conversation,
   for the runner it is placed on. This route adds what a person needs said plainly: a conversation that runs here, and a
   runner that is away. */

export const openRunnerView = (
    services: { readonly auth: unknown; readonly agents: RunnerViewDeps["agents"]; readonly runnerHub: RunnerSockets },
    context: { readonly identity?: Caller | undefined },
    input: RunnerOpenViewInput,
    tickets?: RunnerViewTickets,
): RunnerView => {
    const entry = services.agents.entry(input.conversationId);
    if (entry === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "unknown conversation" });
    }
    const runner = runnerOf(entry);
    if (runner === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "this conversation runs in this sandbox: open its views here" });
    }
    try {
        const minted = mintRunnerViewTicket(
            { auth: services.auth, agents: services.agents },
            { identity: context.identity, runner, conversationId: entry.id, kind: input.kind, session: input.session ?? "" },
            tickets,
        );
        // Asked after the caller is known to be allowed, so a refusal says nothing of a runner's whereabouts.
        if (services.runnerHub.client(runner) === undefined) {
            throw new ORPCError("SERVICE_UNAVAILABLE", { message: services.runnerHub.offline(runner) });
        }
        const at = minted.path.indexOf("?");
        return { runner, path: minted.path.slice(0, at), query: minted.path.slice(at + 1) };
    } catch (error) {
        if (error instanceof RunnerViewRefused) {
            throw new ORPCError("FORBIDDEN", { message: error.message });
        }
        throw error;
    }
};

export const createRunnerViewsRoutes = (services: Pick<Services, "agents" | "auth" | "runnerHub">) => {
    const i = implement(runnersContract).$context<OrpcContext>();
    return {
        openView: i.openView.handler(({ input, context }) => openRunnerView(services, context, input)),
    };
};
