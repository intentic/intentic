import type { ExtensionServerApi, ExtensionServerContext } from "@intentic/extension-api";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import type { DeployResource } from "../contract.js";
import { komodoContract } from "./contract.js";
import { discoverRepoDirs, readFileOrUndefined } from "./discover.js";
import { type FetchFn, komodoClient, type KomodoConnection } from "./komodo-client.js";
import { deployAlerts, deploymentResource, serverEntry, stackResource } from "./komodo-overview.js";
import { repoLinks } from "./komodo-repos.js";
import { fileKomodoStore, komodoStorePath } from "./komodo-store.js";
import { plainText } from "./plain-text.js";

/* The Deployments rail view's whole backend, over one connected `komodo` capability, ext-deployments' server
 * half, moved out of the daemon core. The credential still never reaches a browser: the backend reads it
 * through the daemon's connection route (declared in permissions.daemon, refused to any signed-in caller) and
 * dials Komodo from inside the sandbox, so the view's calls carry no key in either direction.
 *
 * The two halves behave differently on failure, on purpose:
 *   • `overview` DEGRADES. A Komodo that does not answer resolves with `reachable: false` and an empty board,
 *     because "we cannot see production" is a state to render, not an error that blanks the view. The rail
 *     reads that as a `warning`, never a `danger`.
 *   • the ACTIONS propagate. A refused deploy is an upstream answer the operator needs verbatim, so it becomes
 *     a BAD_GATEWAY carrying Komodo's own words. */

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
 * exist once. `pull` is the only composite: pull the newest image, THEN deploy it, the routine version bump
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

export const activateServer = (api: ExtensionServerApi, _context: ExtensionServerContext, fetchFn: FetchFn = fetch): void => {
    const i = implement(komodoContract);
    const store = fileKomodoStore(komodoStorePath(api.workspaceRoot));

    /* The daemon's connection read, resolved per call so a rotated key applies on the next click. The kind and
     * provider are re-checked here: the route hands back whatever capability the id names, and dialling a
     * non-Komodo capability's config at a Komodo would send somebody's OTHER credential to the wrong host. */
    const connect = async (capability: string): Promise<KomodoConnection> => {
        const connection = await api.daemon
            .json<{ kind: string; config: Record<string, string | undefined> }>(`/capabilities/${encodeURIComponent(capability)}/connection`)
            .catch(() => undefined);
        const { provider, url, apiKey, apiSecret } = connection?.config ?? {};
        if (connection?.kind !== "cli" || provider !== "komodo" || url === undefined || apiKey === undefined || apiSecret === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no connected Komodo capability "${capability}"` });
        }
        return { capability, baseUrl: url.replace(/\/+$/, ""), apiKey, apiSecret };
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

    const router = i.router({
        overview: i.overview.handler(async ({ input }) => {
            const connection = await connect(input.capability);
            const client = komodoClient(connection, fetchFn);
            const seenAt = await store.seenAt(input.capability);
            const seen = seenAt === undefined ? {} : { seenAt };
            // The repo half does not depend on Komodo answering. A workspace with a compose file and nothing
            // linked yet is exactly the state where the owner most needs to see what this view is for, so it
            // is computed outside the try and survives an unreachable Komodo (with no suggestions, since
            // there are no stack names to suggest from).
            const scan = { root: api.workspaceRoot, read: readFileOrUndefined };
            const links = await store.links(input.capability);
            const repoDirs = await discoverRepoDirs(api.workspaceRoot);
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
                api.log(`overview unreachable for "${input.capability}": ${reason}`);
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
            await store.link(input.capability, input.repo, input.stack);
            return { ok: true as const };
        }),
        // The backend's clock, not the browser's: a device with a fast clock would otherwise stamp itself past
        // breakages that have not happened yet and silence them before they arrive.
        seen: i.seen.handler(async ({ input }) => {
            const at = Date.now();
            await store.markSeen(input.capability, at);
            return { seenAt: at };
        }),
        action: i.action.handler(async ({ input }) => {
            const [connection, resource] = await resolve(input.capability, input.kind, input.id);
            const client = komodoClient(connection, fetchFn);
            // `pull` is two operations and they must run in order, a parallel pull+deploy would race the
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
            // A container's log is written for a terminal (an app's colour, a progress line rewriting itself), so
            // it is reduced to plain text before the cap, the budget then buys failure, not escape codes.
            const tail = plainText(`${log.stdout}\n${log.stderr}`).trim().slice(-FIX_LOG_BYTES);
            const where = resource.server === undefined ? "" : ` on ${resource.server}`;
            const prompt = [
                `The Komodo ${input.kind} "${resource.name}"${where} is ${resource.state}${resource.status === undefined ? "" : ` (${resource.status})`}. Investigate and fix it.`,
                `Its image is ${resource.image ?? "not recorded"}. Komodo is at ${connection.baseUrl} and you have it as a capability: use it to read state and logs, and to redeploy once you have a fix.`,
                `Find the cause in this workspace's source where it is a code or config problem, fix it there, and say plainly when the cause is outside the workspace (a bad env var, a full disk, an unreachable dependency) rather than inventing a code change. You are in an isolated worktree: commit your fix and it goes through review.`,
                ...(tail !== "" ? [`--- container log tail ---\n${tail}`] : []),
            ].join("\n\n");
            const conversationId = mintFixConversationId(resource.name, Date.now());
            /* POST /agent, the same detached-run boundary the core route used to reach in-process, now as the
             * declared daemon call it always morally was. Registering on the run map is what gives the fix an
             * ordinary fleet card the UI can navigate to; `unattended` lets the sandbox's agent-run list answer
             * for a click nobody chose a model for, unless they did, using the caret beside the button, in
             * which case the pair rides on here and the daemon's fill step leaves it alone. */
            await api.daemon
                .json(`/agent`, {
                    method: "POST",
                    body: JSON.stringify({
                        prompt,
                        conversationId,
                        isolated: true,
                        unattended: true,
                        ...(input.pick !== undefined ? { agent: input.pick.agent, model: input.pick.model } : {}),
                        title: `Fix deployment: ${resource.name}`.slice(0, TITLE_MAX),
                    }),
                })
                .catch((error: unknown) => {
                    throw new ORPCError("CONFLICT", { message: error instanceof Error ? error.message : String(error) });
                });
            return { conversationId };
        }),
    });

    const handler = new OpenAPIHandler(router);
    api.routes.mount(async (request) => {
        const { matched, response } = await handler.handle(request, { prefix: "/" });
        return matched ? response : undefined;
    });
};
