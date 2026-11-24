import { LinkAnswerSchema, LinkMessageSchema, LinkTaskSchema } from "@intentic/sandbox-contract/schemas/links";
import type { Context } from "hono";
import { type AdmitRoute, routeAdmissionOf } from "../account-routing/admit-route.js";
import type { AppEnv } from "../app-env.js";
import type { Caller } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import type { StoredLinkTask } from "./inbound-links.js";
import { linkBody as bodyOf } from "./link-door.js";
import { answerTask, heldStatus, type LinkRefusal } from "./link-tasks.js";
import { askPersonTask, messagePersonTask, type PersonTaskDeps, personStatusOf, personTaskDepsOf, stopPersonTask } from "./person-tasks.js";
import type { PersonRouteKey } from "./person-tasks-store.js";

// THE `task` SCOPE'S DOORS (2026-11-24, docs/architecture/account-routing.md): the link doors (links.routes.ts) for a
// sandbox routing as one of its people instead of over a link. Each request is admitted afresh (admit-route.ts: the pass
// for this door's scope, the sender's minute, the person on the roster now and above the task floor, their pairing), so
// a revoked pairing or a person removed stops the very next call, not only the next start. What it reaches is the task
// list of that (asking sandbox, person) pair alone: the same person asking from another sandbox, or another person from
// the same one, is answered as no such task.

export interface PersonTaskRoutesDeps extends PersonTaskDeps {
    readonly admit: AdmitRoute;
}

interface Admitted {
    readonly key: PersonRouteKey;
    readonly person: Caller;
}

const refused = (c: Context<AppEnv>, refusal: LinkRefusal): Response => c.json({ error: refusal.message }, refusal.refused);
const isRefusal = <T extends object>(value: T | LinkRefusal): value is LinkRefusal => "refused" in value;
const NO_SUCH_TASK = "This sandbox holds no task by that id that your sandbox opened for this person.";

export const createPersonTaskRoutes = (deps: PersonTaskRoutesDeps) => {
    const admitted = async (c: Context<AppEnv>): Promise<Admitted | Response> => {
        const admission = await deps.admit(c, "task");
        if (admission instanceof Response) {
            return admission;
        }
        // A task pass always names its person (sandbox-pass.ts), and admission refuses one this roster does not know.
        const { pass, person } = admission;
        if (person === undefined) {
            return c.json({ error: "this pass names no person: resolve it again", code: "pass" }, 401);
        }
        return { key: { from: pass.from, fromName: pass.fromName, person: person.email.toLowerCase() }, person };
    };
    // The task this pair opened under the path's conversation id; any other conversation is answered as none.
    const taskOf = async (c: Context<AppEnv>, key: PersonRouteKey): Promise<StoredLinkTask | Response> =>
        (await deps.tasks.task(key, { conversationId: c.req.param("id") ?? "" })) ?? c.json({ error: NO_SUCH_TASK }, 404);
    // Admission and the task together, for every door below the start.
    const reach = async (c: Context<AppEnv>): Promise<(Admitted & { readonly task: StoredLinkTask }) | Response> => {
        const who = await admitted(c);
        if (who instanceof Response) {
            return who;
        }
        const task = await taskOf(c, who.key);
        return task instanceof Response ? task : { ...who, task };
    };

    return {
        /** POST /account/task */
        ask: async (c: Context<AppEnv>): Promise<Response> => {
            const who = await admitted(c);
            if (who instanceof Response) {
                return who;
            }
            const body = await bodyOf(c, LinkTaskSchema);
            if (!body.ok) {
                return body.response;
            }
            const answer = await askPersonTask(deps, who.key, who.person, body.value);
            return isRefusal(answer) ? refused(c, answer) : c.json(answer);
        },
        /** GET /account/task/{id}?after=<version>&wait=<seconds> */
        status: async (c: Context<AppEnv>): Promise<Response> => {
            const who = await admitted(c);
            if (who instanceof Response) {
                return who;
            }
            const after = Number.parseInt(c.req.query("after") ?? "", 10);
            const wait = Number.parseInt(c.req.query("wait") ?? "", 10);
            const id = c.req.param("id") ?? "";
            const status = await heldStatus(
                deps,
                () => deps.tasks.task(who.key, { conversationId: id }),
                id,
                { after: Number.isFinite(after) ? after : undefined, waitS: Number.isFinite(wait) ? wait : 0, waitsFor: `${who.key.person}, who is in this sandbox` },
                c.req.raw.signal,
            );
            return status === undefined ? c.json({ error: NO_SUCH_TASK }, 404) : c.json(status);
        },
        /** POST /account/task/{id}/messages */
        message: async (c: Context<AppEnv>): Promise<Response> => {
            const reached = await reach(c);
            if (reached instanceof Response) {
                return reached;
            }
            const body = await bodyOf(c, LinkMessageSchema);
            if (!body.ok) {
                return body.response;
            }
            const receipt = await messagePersonTask(deps, reached.key, reached.person, reached.task, body.value);
            return isRefusal(receipt) ? refused(c, receipt) : c.json(receipt);
        },
        /** POST /account/task/{id}/answer: a plain question only; any other card is the person's, here. */
        answer: async (c: Context<AppEnv>): Promise<Response> => {
            const reached = await reach(c);
            if (reached instanceof Response) {
                return reached;
            }
            const body = await bodyOf(c, LinkAnswerSchema);
            if (!body.ok) {
                return body.response;
            }
            const unanswered = await answerTask(deps, reached.task, body.value);
            return unanswered === undefined ? c.json({ ok: true }) : refused(c, unanswered);
        },
        /** POST /account/task/{id}/stop */
        stop: async (c: Context<AppEnv>): Promise<Response> => {
            const reached = await reach(c);
            if (reached instanceof Response) {
                return reached;
            }
            return c.json(personStatusOf(deps, reached.key, await stopPersonTask(deps, reached.task)));
        },
    };
};

export const personTaskRawRoutes = defineRawRoutes((services: Services) => {
    const routes = createPersonTaskRoutes({ ...personTaskDepsOf(services), admit: routeAdmissionOf(services) });
    return {
        "POST /account/task": routes.ask,
        "GET /account/task/{id}": routes.status,
        "POST /account/task/{id}/messages": routes.message,
        "POST /account/task/{id}/answer": routes.answer,
        "POST /account/task/{id}/stop": routes.stop,
    };
});
