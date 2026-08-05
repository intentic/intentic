import { type AgentTurn, type DeployResource, komodoContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import { startConversationTurn } from "../agent/turn-resume.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { type FetchFn, komodoClient, komodoConnectionFor, type KomodoConnection } from "./komodo-client.js";
import { deployAlerts, deploymentResource, serverEntry, stackResource } from "./komodo-overview.js";
import { repoLinks } from "./komodo-repos.js";

/* The Deployments rail view's whole backend, over one connected `komodo` capability.
 *
 * The credential never leaves the daemon — that is the entire reason these routes exist rather than the view
 * calling Komodo from the browser, and it is the same promise the CI routes keep for vendor tokens.
 *
 * The two halves behave differently on failure, on purpose:
 *   • `overview` DEGRADES. A Komodo that does not answer resolves with `reachable: false` and an empty board,
 *     because "we cannot see production" is a state to render, not an error that blanks the view. The rail
 *     reads that as a `warning`, never a `danger`.
 *   • the ACTIONS propagate. A refused deploy is an upstream answer the operator needs verbatim, so it becomes
 *     a BAD_GATEWAY carrying Komodo's own words.
 */

// How many log lines seed the view's inline tail. Komodo caps at 5000; 200 is enough to see a crash without
// making the response something the browser has to scroll through to find the error.
const LOG_TAIL = 200;
// How much of that tail rides into a fix conversation. The CI fix budget, for the same reason: enough to see
// the actual error, small enough that the turn stays about fixing rather than reading.
const FIX_LOG_BYTES = 24_000;
const TITLE_MAX = 80;

// The scheduler's mintConversationId recipe, for a conversation a CLICK opens: bounded, charset-safe, unique
// per process.
let fixSeq = 0;
const mintFixConversationId = (name: string, now: number): string =>
    `deploy-fix-${name.replaceAll(/[^a-zA-Z0-9-]/g, "-").slice(0, 32)}-${now.toString(36)}${(fixSeq++).toString(36)}`;

const upstream = async <T>(action: Promise<T>): Promise<T> => {
    try {
        return await action;
    } catch (error) {
        throw new ORPCError("BAD_GATEWAY", { message: error instanceof Error ? error.message : String(error) });
    }
};

/* Which Komodo operation each action means, per resource kind. Stacks and deployments have parallel but
 * differently-named operations and differently-named params, which is exactly the kind of detail that should
 * exist once. `pull` is the only composite: pull the newest image, THEN deploy it — the routine version bump
 * that is four clicks in Komodo's own UI, as one. */
const OPERATIONS = {
    deployment: {
        deploy: ["Deploy"],
        restart: ["RestartDeployment"],
        start: ["StartDeployment"],
        stop: ["StopDeployment"],
        pull: ["PullDeployment", "Deploy"],
    },
    stack: {
        deploy: ["DeployStack"],
        restart: ["RestartStack"],
        start: ["StartStack"],
        stop: ["StopStack"],
        pull: ["PullStack", "DeployStack"],
    },
} as const;

export const createKomodoRoutes = (services: Services, wake: WakeFn = streamAgent, fetchFn: FetchFn = fetch) => {
    const i = implement(komodoContract).$context<OrpcContext>();

    const connect = async (capability: string): Promise<KomodoConnection> => {
        const connection = await komodoConnectionFor(services.capabilities, capability);
        if (connection === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no connected Komodo capability "${capability}"` });
        }
        return connection;
    };

    // Re-resolve the resource per call rather than trusting the id a card was rendered with: a stale card must
    // not act on something that has since been deleted or renamed. Also gives every action and the fix prompt
    // the resource's live name and state without a second fetch.
    const resolve = async (capability: string, kind: "deployment" | "stack", id: string): Promise<[KomodoConnection, DeployResource]> => {
        const connection = await connect(capability);
        const client = komodoClient(connection, fetchFn);
        const resources =
            kind === "stack"
                ? (await upstream(client.listStacks())).map((item) => stackResource(connection.baseUrl, item))
                : (await upstream(client.listDeployments())).map((item) => deploymentResource(connection.baseUrl, item));
        const resource = resources.find((candidate) => candidate.id === id);
        if (resource === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `Komodo has no ${kind} "${id}" any more` });
        }
        return [connection, resource];
    };

    return {
        overview: i.overview.handler(async ({ input }) => {
            const connection = await connect(input.capability);
            const client = komodoClient(connection, fetchFn);
            const seenAt = await services.komodoStore.seenAt(input.capability);
            const seen = seenAt === undefined ? {} : { seenAt };
            // The repo half does not depend on Komodo answering. A workspace with a compose file and nothing
            // linked yet is exactly the state where the owner most needs to see what this view is for, so it
            // is computed outside the try and survives an unreachable Komodo (with no suggestions, since
            // there are no stack names to suggest from).
            const scan = { root: services.workspace.root, read: services.files.read };
            const links = await services.komodoStore.links(input.capability);
            const repoDirs = await discoverRepos(services.workspace.root);
            try {
                // One fan-out. All five are independent reads, so a serial version would make the view five
                // round-trips slower for nothing; Promise.all means one slow call bounds the response rather
                // than summing with the others.
                const [viewer, deployments, stacks, servers, alerts] = await Promise.all([
                    client.whoami(),
                    client.listDeployments(),
                    client.listStacks(),
                    client.listServers(),
                    client.listAlerts(),
                ]);
                return {
                    komodoUrl: connection.baseUrl,
                    reachable: true,
                    viewer,
                    repos: await repoLinks(
                        scan,
                        repoDirs,
                        stacks.map((item) => item.name),
                        links,
                    ),
                    resources: [
                        ...stacks.map((item) => stackResource(connection.baseUrl, item)),
                        ...deployments.map((item) => deploymentResource(connection.baseUrl, item)),
                    ],
                    servers: servers.map((item) => serverEntry(connection.baseUrl, item)),
                    alerts: deployAlerts(alerts),
                    ...seen,
                };
            } catch (error) {
                // Degrade, don't throw: an unreachable Komodo is the single most important thing this view can
                // say, and it can only say it by rendering.
                const reason = error instanceof Error ? error.message : String(error);
                services.logger.warn({ err: error, capability: input.capability }, "komodo: overview unreachable");
                return {
                    komodoUrl: connection.baseUrl,
                    reachable: false,
                    unreachableReason: reason,
                    repos: await repoLinks(scan, repoDirs, [], links),
                    resources: [],
                    servers: [],
                    alerts: [],
                    ...seen,
                };
            }
        }),
        link: i.link.handler(async ({ input }) => {
            await services.komodoStore.link(input.capability, input.repo, input.stack);
            return { ok: true as const };
        }),
        // The daemon's clock, not the browser's: a device with a fast clock would otherwise stamp itself past
        // breakages that have not happened yet and silence them before they arrive.
        seen: i.seen.handler(async ({ input }) => {
            const at = Date.now();
            await services.komodoStore.markSeen(input.capability, at);
            return { seenAt: at };
        }),
        action: i.action.handler(async ({ input }) => {
            const [connection, resource] = await resolve(input.capability, input.kind, input.id);
            const client = komodoClient(connection, fetchFn);
            // `pull` is two operations and they must run in order — a parallel pull+deploy would race the
            // image it is meant to be deploying.
            // Komodo addresses a deployment by `deployment` and a stack by `stack`, each accepting id or name.
            for (const operation of OPERATIONS[input.kind][input.action]) {
                await upstream(client.execute(operation, { [input.kind]: resource.name }));
            }
            return { ok: true as const };
        }),
        logs: i.logs.handler(async ({ input }) => {
            const [connection, resource] = await resolve(input.capability, input.kind, input.id);
            return upstream(komodoClient(connection, fetchFn).logs(input.kind, resource.name, LOG_TAIL));
        }),
        fix: i.fix.handler(async ({ input }) => {
            const [connection, resource] = await resolve(input.capability, input.kind, input.id);
            // Best-effort: a resource whose logs cannot be read is often exactly the broken one, and the turn
            // is still worth starting with the state and the name.
            const log = await komodoClient(connection, fetchFn)
                .logs(input.kind, resource.name, LOG_TAIL)
                .catch(() => ({ stdout: "", stderr: "" }));
            const tail = `${log.stdout}\n${log.stderr}`.trim().slice(-FIX_LOG_BYTES);
            const where = resource.server === undefined ? "" : ` on ${resource.server}`;
            const prompt = [
                `The Komodo ${input.kind} "${resource.name}"${where} is ${resource.state}${resource.status === undefined ? "" : ` (${resource.status})`}. Investigate and fix it.`,
                `Its image is ${resource.image ?? "not recorded"}. Komodo is at ${connection.baseUrl} and you have it as a capability — use it to read state and logs, and to redeploy once you have a fix.`,
                `Find the cause in this workspace's source where it is a code or config problem, fix it there, and say plainly when the cause is outside the workspace (a bad env var, a full disk, an unreachable dependency) rather than inventing a code change. You are in an isolated worktree: commit your fix and it goes through review.`,
                ...(tail !== "" ? [`--- container log tail ---\n${tail}`] : []),
            ].join("\n\n");
            const conversationId = mintFixConversationId(resource.name, Date.now());
            const turn: AgentTurn & { conversationId: string } = {
                prompt,
                conversationId,
                isolated: true,
                // One click on a broken container, with no model picker anywhere near it — `agentRunModel`
                // answers for it, the same as the CI fix this is deliberately identical to.
                unattended: true,
                title: `Fix deployment: ${resource.name}`.slice(0, TITLE_MAX),
            };
            // The same detached-run boundary as POST /agent and the CI fix — registering on the run map is what
            // gives the fix an ordinary fleet card the UI can navigate to.
            const started = await startConversationTurn(services, wake, turn);
            if (started === undefined) {
                // Minted ids are unique, so this is an invariant breach rather than a user-level busy state.
                throw new ORPCError("CONFLICT", { message: "the deployment fix conversation is already running" });
            }
            return { conversationId };
        }),
    };
};
