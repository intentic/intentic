import {
    InboundLinkMintSchema,
    InboundLinkTermsUpdateSchema,
    LINK_HEADER,
    LINK_MAX_HOPS,
    LinkAnswerSchema,
    type LinkHello,
    LinkMessageSchema,
    LinkRequestDecisionSchema,
    LinkTaskSchema,
} from "@intentic/sandbox-contract/schemas/links";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { ownerDenied } from "../auth/owner-gates.js";
import { opt } from "../opt.js";
import type { ResolvedLink, StoredLinkTask } from "./inbound-links.js";
import {
    answerTask,
    askTask,
    decideTask,
    type LinkRefusal,
    type LinkServices,
    type LinkTaskDeps,
    linkTaskDepsOf,
    messageTask,
    statusAfter,
    statusOf,
    stopTask,
} from "./link-tasks.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { replaceRejectedToken } from "../agent/providers/claude/claude-credentials.js";
import { resolveHarnessCredentials } from "../agent/providers/harness-credentials.js";
import { toRunnerCredential } from "../sandboxes/credential-lending.js";
import { copyOf, heldAccounts } from "./accounts/held-accounts.js";
import { createLinkAccountDoors, type LinkAccountDoors } from "./accounts/link-account-doors.js";

// The two halves of a link as routes. The owner's (`/system/links`): mint one, change its terms, revoke it, answer a task
// that waits on them; each refused to anyone below the operating tier, like a control token's. The link doors (`/link`):
// called by the asking sandbox's daemon with the link token, each answering for the conversations that link opened and
// nothing else, which is the whole of what a link reaches here.

export interface LinkRoutesDeps extends LinkTaskDeps {
    readonly auth: Services["auth"];
    // What this sandbox calls itself, told to the asking side so its agent can name where the work went.
    readonly sandboxName: () => string;
    // The personas a link's tasks may wear, by id, with the name each is shown by.
    readonly personas: () => Promise<readonly { readonly id: string; readonly label?: string | undefined }[]>;
    // The services a link's tasks may act as, by id (docs/architecture/access.md).
    readonly serviceIds?: () => Promise<readonly string[]>;
}

/** The routes' deps, read off the daemon's services. */
const linkRoutesDepsOf = (services: LinkServices & Pick<Services, "auth" | "info" | "personas">): LinkRoutesDeps => ({
    ...linkTaskDepsOf(services),
    auth: services.auth,
    sandboxName: () => services.info?.name ?? "this sandbox",
    personas: async () => (await services.personas.list()).map((persona) => ({ id: persona.id, label: persona.label })),
    serviceIds: async () => (await services.services?.list())?.map((service) => service.id) ?? [],
});

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };

// A JSON body read through its schema; a body that is not JSON reads as none, which the schema then refuses by name.
const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<Parsed<T>> => {
    // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses by name.
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(raw ?? {});
    if (parsed.success) {
        return { ok: true, value: parsed.data };
    }
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
    return { ok: false, response: c.json({ error: `${where}${issue?.message ?? "the body did not read as the route's input"}` }, 400) };
};

const refused = (c: Context<AppEnv>, refusal: LinkRefusal): Response => c.json({ error: refusal.message }, refusal.refused);

const isRefusal = <T extends object>(value: T | LinkRefusal): value is LinkRefusal => "refused" in value;

// A persona the terms name must exist: an unknown one would deny every task everything (personas.ts turnPersona), which
// reads to the asking side as a link that silently does nothing.
const unknownPersona = async (deps: LinkRoutesDeps, actsAs: string | undefined): Promise<string | undefined> => {
    if (actsAs === undefined) {
        return undefined;
    }
    const cast = await deps.personas();
    return cast.some((persona) => persona.id === actsAs) ? undefined : `no persona here is called "${actsAs}"`;
};

// A service the terms name must exist: tasks acting as one that does not would each be refused (link-tasks.ts).
const unknownService = async (deps: LinkRoutesDeps, runAs: string | null | undefined): Promise<string | undefined> => {
    if (runAs === undefined || runAs === null) {
        return undefined;
    }
    const known = (await deps.serviceIds?.()) ?? [];
    return known.includes(runAs) ? undefined : `no service here is called "${runAs}"`;
};

// What GET /link answers: the link still works, and the terms it is held to, the persona by the name it is shown by.
const helloOf = async (deps: LinkRoutesDeps, link: ResolvedLink): Promise<LinkHello> => {
    const persona = link.terms.actsAs === undefined ? undefined : (await deps.personas()).find((candidate) => candidate.id === link.terms.actsAs);
    return {
        sandbox: deps.sandboxName(),
        link: { id: link.id, label: link.label },
        terms: {
            approve: link.terms.approve,
            turnsPerHour: link.terms.turnsPerHour,
            ...opt("persona", persona === undefined ? undefined : (persona.label ?? persona.id)),
            tasks: link.terms.tasks,
            accounts: link.terms.accounts.length,
        },
        maxHops: LINK_MAX_HOPS,
    };
};

// The link this request presents, or the refusal: a token nothing here was minted as, or one since revoked, reads the
// same, since telling them apart would tell a stranger which tokens once worked.
const presentedLink = async (deps: Pick<LinkRoutesDeps, "links" | "logger">, c: Context<AppEnv>): Promise<ResolvedLink | Response> => {
    const link = await deps.links.resolve(c.req.header(LINK_HEADER) ?? "");
    if (link === undefined) {
        return c.json({ error: "This link is not one this sandbox holds: it was revoked, or never minted here. Its owner can link the two sandboxes again." }, 401);
    }
    void deps.links.touch(link.id).catch((error: Error) => deps.logger.warn({ err: error, link: link.id }, "link: last use not recorded"));
    return link;
};

export const createLinkRoutes = (deps: LinkRoutesDeps) => {
    const linkOf = (c: Context<AppEnv>): Promise<ResolvedLink | Response> => presentedLink(deps, c);
    // The task this link opened under the path's conversation id; any other conversation is answered as no such task.
    const taskOf = async (c: Context<AppEnv>, link: ResolvedLink): Promise<StoredLinkTask | Response> => {
        const task = await deps.links.task(link.id, { conversationId: c.req.param("id") ?? "" });
        return task ?? c.json({ error: "This link opened no conversation by that id." }, 404);
    };
    const owner = async (c: Context<AppEnv>): Promise<Response | undefined> => ownerDenied({ auth: deps.auth }, c);

    return {
        /* The owner's half. */

        /** GET /system/links */
        list: async (c: Context<AppEnv>): Promise<Response> => (await owner(c)) ?? c.json({ links: await deps.links.list() }),
        /** POST /system/links */
        mint: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await owner(c);
            if (denied !== undefined) {
                return denied;
            }
            const body = await bodyOf(c, InboundLinkMintSchema);
            if (!body.ok) {
                return body.response;
            }
            const missing = (await unknownPersona(deps, body.value.terms?.actsAs)) ?? (await unknownService(deps, body.value.terms?.runAs));
            if (missing !== undefined) {
                return c.json({ error: missing }, 400);
            }
            // The minter is who the middleware verified for this request, never a field of the body.
            const createdBy = c.get("identity")?.email;
            const minted = await deps.links.mint(body.value.label, { from: body.value.from, terms: body.value.terms, createdBy });
            deps.logger.info({ link: minted.id, label: body.value.label, by: createdBy }, "link: minted");
            return c.json(minted);
        },
        /** POST /system/links/{id} */
        update: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await owner(c);
            if (denied !== undefined) {
                return denied;
            }
            const body = await bodyOf(c, InboundLinkTermsUpdateSchema);
            if (!body.ok) {
                return body.response;
            }
            const missing = (await unknownPersona(deps, body.value.actsAs ?? undefined)) ?? (await unknownService(deps, body.value.runAs));
            if (missing !== undefined) {
                return c.json({ error: missing }, 400);
            }
            const summary = await deps.links.update(c.req.param("id") ?? "", body.value);
            return summary === undefined ? c.json({ error: "no such link" }, 404) : c.json(summary);
        },
        /** DELETE /system/links/{id} */
        revoke: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await owner(c);
            if (denied !== undefined) {
                return denied;
            }
            const id = c.req.param("id") ?? "";
            if (!(await deps.links.revoke(id))) {
                return c.json({ error: "no such link" }, 404);
            }
            // Conversations it opened stay: they are this sandbox's now, and only the asking side loses its way to them.
            deps.logger.info({ link: id }, "link: revoked");
            return c.json({ ok: true });
        },
        /** POST /system/links/{id}/requests/{request} */
        decide: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await owner(c);
            if (denied !== undefined) {
                return denied;
            }
            const body = await bodyOf(c, LinkRequestDecisionSchema);
            if (!body.ok) {
                return body.response;
            }
            const summary = await deps.links.summary(c.req.param("id") ?? "");
            if (summary === undefined) {
                return c.json({ error: "no such link" }, 404);
            }
            const decided = await decideTask(deps, { id: summary.id, label: summary.label, terms: summary.terms }, c.req.param("request") ?? "", body.value.approve);
            if (isRefusal(decided)) {
                return refused(c, decided);
            }
            return c.json((await deps.links.summary(summary.id)) ?? summary);
        },

        /* The link doors. */

        /** GET /link */
        hello: async (c: Context<AppEnv>): Promise<Response> => {
            const link = await linkOf(c);
            if (link instanceof Response) {
                return link;
            }
            return c.json(await helloOf(deps, link));
        },
        /** POST /link/conversations */
        ask: async (c: Context<AppEnv>): Promise<Response> => {
            const link = await linkOf(c);
            if (link instanceof Response) {
                return link;
            }
            const body = await bodyOf(c, LinkTaskSchema);
            if (!body.ok) {
                return body.response;
            }
            const answer = await askTask(deps, link, body.value);
            return isRefusal(answer) ? refused(c, answer) : c.json(answer);
        },
        /** GET /link/conversations/{id}?after=<version>&wait=<seconds> */
        status: async (c: Context<AppEnv>): Promise<Response> => {
            const link = await linkOf(c);
            if (link instanceof Response) {
                return link;
            }
            const after = Number.parseInt(c.req.query("after") ?? "", 10);
            const wait = Number.parseInt(c.req.query("wait") ?? "", 10);
            const status = await statusAfter(
                deps,
                link,
                c.req.param("id") ?? "",
                Number.isFinite(after) ? after : undefined,
                Number.isFinite(wait) ? wait : 0,
                c.req.raw.signal,
            );
            return status === undefined ? c.json({ error: "This link opened no conversation by that id." }, 404) : c.json(status);
        },
        /** POST /link/conversations/{id}/messages */
        message: async (c: Context<AppEnv>): Promise<Response> => {
            const link = await linkOf(c);
            if (link instanceof Response) {
                return link;
            }
            const task = await taskOf(c, link);
            if (task instanceof Response) {
                return task;
            }
            const body = await bodyOf(c, LinkMessageSchema);
            if (!body.ok) {
                return body.response;
            }
            const receipt = await messageTask(deps, link, task, body.value);
            return isRefusal(receipt) ? refused(c, receipt) : c.json(receipt);
        },
        /** POST /link/conversations/{id}/answer */
        answer: async (c: Context<AppEnv>): Promise<Response> => {
            const link = await linkOf(c);
            if (link instanceof Response) {
                return link;
            }
            const task = await taskOf(c, link);
            if (task instanceof Response) {
                return task;
            }
            const body = await bodyOf(c, LinkAnswerSchema);
            if (!body.ok) {
                return body.response;
            }
            const unanswered = await answerTask(deps, task, body.value);
            return unanswered === undefined ? c.json({ ok: true }) : refused(c, unanswered);
        },
        /** POST /link/conversations/{id}/stop */
        stop: async (c: Context<AppEnv>): Promise<Response> => {
            const link = await linkOf(c);
            if (link instanceof Response) {
                return link;
            }
            const task = await taskOf(c, link);
            if (task instanceof Response) {
                return task;
            }
            return c.json(statusOf(deps, await stopTask(deps, link, task)));
        },
    };
};

// An accounts link's doors (accounts/link-account-doors.ts), each behind the link the request presents.
export const linkAccountRoutes = (deps: Pick<LinkRoutesDeps, "links" | "logger">, doors: LinkAccountDoors) => {
    const behindLink =
        (door: (c: Context<AppEnv>, link: ResolvedLink) => Promise<Response>) =>
        async (c: Context<AppEnv>): Promise<Response> => {
            const link = await presentedLink(deps, c);
            return link instanceof Response ? link : await door(c, link);
        };
    return {
        "GET /link/accounts": behindLink(doors.accounts),
        "POST /link/accounts/copy": behindLink(doors.copy),
        "POST /link/credentials": behindLink(doors.credential),
        "POST /link/credentials/refresh": behindLink(doors.refresh),
    };
};

// What the account doors read of the daemon: what it holds, and how its own turns resolve a credential.
const linkAccountDoorsOf = (services: Services): LinkAccountDoors =>
    createLinkAccountDoors({
        logger: services.logger,
        held: () => heldAccounts(services),
        copyOf: (ref) => copyOf(services, ref),
        // "" for the container's own credential: that is this sandbox's, and never lent to another.
        credential: async (input) => toRunnerCredential(await resolveHarnessCredentials(services, input), services.config.translator.url, ""),
        remint: (account, rejected) => replaceRejectedToken(services.claudeStore, account, rejected),
    });

// Linked sandboxes: the owner's links for other sandboxes of theirs (mint, terms, revoke, a waiting task's answer), and
// the doors those sandboxes hand tasks through, each reaching only the conversations its own link opened, and the
// accounts doors an accounts link borrows through.
export const linkRawRoutes = defineRawRoutes((services: Services) => {
    const deps = linkRoutesDepsOf(services);
    const links = createLinkRoutes(deps);
    return {
        ...linkAccountRoutes(deps, linkAccountDoorsOf(services)),
        "GET /system/links": links.list,
        "POST /system/links": links.mint,
        "POST /system/links/{id}": links.update,
        "DELETE /system/links/{id}": links.revoke,
        "POST /system/links/{id}/requests/{request}": links.decide,
        "GET /link": links.hello,
        "POST /link/conversations": links.ask,
        "GET /link/conversations/{id}": links.status,
        "POST /link/conversations/{id}/messages": links.message,
        "POST /link/conversations/{id}/answer": links.answer,
        "POST /link/conversations/{id}/stop": links.stop,
    };
});
