import { type S2sCallInput, type S2sContactTask, S2sContactTaskDecisionSchema } from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import type { StoredLinkTask } from "../inbound-links.js";
import type { LinkRefusal } from "../link-tasks.js";
import type { PersonTasksStore } from "../person-tasks-store.js";
import { opt } from "../../opt.js";
import { type AskerDeps, askerOf, mayUse } from "../../s2s/askers.js";
import type { CallResult } from "../../s2s/calls/call-client.js";
import type { ContactRow, ContactsStore } from "../../s2s/contacts/contacts-store.js";
import { askerDepsOf } from "../../s2s/s2s-wiring.js";
import { type ContactTaskServices, takingCodeOf } from "./contact-tasks.js";
import type { ContactTasksStore } from "./contact-tasks-store.js";
import { CONTACT_ROUTE_PREFIX, decideContactTask } from "./taking.js";

// The tasks contacts handed this sandbox, as the Messages tab reads them (RAW_ROUTES, schemas/s2s.ts): each shown to
// whoever may use its contact (askers.ts mayUse), and a waiting one allowed or declined on its contact, by the owner or a
// maintainer (the route's floor), as a link's waiting task was on Access ▸ Programs. And the other way: a task this
// sandbox handed a contact, its live status asked of that contact by a `task.watch` call, for a person watching it here.

// How much of a waiting task's words the list carries.
const WORDS_SHOWN = 2_000;

export interface ContactTasksRouteDeps {
    readonly contacts: Pick<ContactsStore, "list" | "get">;
    readonly book: Pick<ContactTasksStore, "list">;
    readonly personTasks: Pick<PersonTasksStore, "list">;
    readonly askers: AskerDeps;
    readonly decide: (row: ContactRow, requestId: string, approve: boolean) => Promise<StoredLinkTask | LinkRefusal>;
    // A `task.watch` call to the contact (s2s/calls/call-client.ts).
    readonly watch: (row: ContactRow, input: S2sCallInput<"task.watch">, signal: AbortSignal) => Promise<CallResult<"task.watch">>;
}

// How long a watch may be held: the method's own ceiling (S2sTaskWatchInputSchema).
const WATCH_WAIT_MAX_S = 25;

// A number a query names, or undefined.
const counted = (raw: string | undefined): number | undefined => {
    const value = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
};

// A JSON answer at the status the far side gave, which Hono's typed `c.json` will not take as a plain number.
const json = (body: { readonly error: string }, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const viewOf = (row: ContactRow, task: StoredLinkTask): S2sContactTask => ({
    contact: row.id,
    contactName: row.name ?? row.document.name,
    requestId: task.requestId,
    conversationId: task.conversationId,
    ...opt("title", task.title),
    ...opt("task", task.task?.slice(0, WORDS_SHOWN)),
    state: task.state,
    askedAt: task.askedAt,
    updatedAt: task.updatedAt,
});

// Waiting ones first, then the newest.
const order = (left: S2sContactTask, right: S2sContactTask): number =>
    Number(right.state === "held") - Number(left.state === "held") || right.updatedAt - left.updatedAt;

export const contactTasksRoutesOf = (deps: ContactTasksRouteDeps) => ({
    "GET /s2s/tasks": async (c: Context<AppEnv>) => {
        const asker = await askerOf(deps.askers, c);
        const rows = new Map((await deps.contacts.list()).filter((row) => mayUse(asker, row.scope)).map((row) => [row.id, row]));
        const own = (await deps.book.list()).map((entry) => ({ row: rows.get(entry.contact), tasks: entry.tasks }));
        const routed = (await deps.personTasks.list())
            .filter((entry) => entry.key.from.startsWith(CONTACT_ROUTE_PREFIX))
            .map((entry) => ({ row: rows.get(entry.key.from.slice(CONTACT_ROUTE_PREFIX.length)), tasks: entry.tasks }));
        const tasks = [...own, ...routed].flatMap(({ row, tasks: held }) => (row === undefined ? [] : held.map((task) => viewOf(row, task))));
        return c.json({ tasks: tasks.toSorted(order) });
    },
    "POST /s2s/contacts/{id}/tasks/{request}": async (c: Context<AppEnv>) => {
        const id = c.req.param("id") ?? "";
        const [row, asker] = await Promise.all([deps.contacts.get(id), askerOf(deps.askers, c)]);
        if (row === undefined || !mayUse(asker, row.scope)) {
            return c.json({ error: `no contact ${id} here you may change` }, 404);
        }
        // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses.
        const body = S2sContactTaskDecisionSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.json({ error: "answer with {approve: true} to start it, or {approve: false} to decline it" }, 400);
        }
        const decided = await deps.decide(row, c.req.param("request") ?? "", body.data.approve);
        return "refused" in decided ? c.json({ error: decided.message }, decided.refused) : c.json(viewOf(row, decided));
    },
    // `?after=<version>` holds the answer until the status moves past it, `?wait=<seconds>` (at most 25) for how long.
    "GET /s2s/contacts/{id}/tasks/{request}/watch": async (c: Context<AppEnv>) => {
        const id = c.req.param("id") ?? "";
        const [row, asker] = await Promise.all([deps.contacts.get(id), askerOf(deps.askers, c)]);
        if (row?.state !== "accepted" || !mayUse(asker, row.scope)) {
            return c.json({ error: `no contact ${id} here you may use` }, 404);
        }
        const wait = counted(c.req.query("wait"));
        const input = { task: c.req.param("request") ?? "", ...opt("after", counted(c.req.query("after"))), ...opt("waitS", wait === undefined ? undefined : Math.min(wait, WATCH_WAIT_MAX_S)) };
        const watched = await deps.watch(row, input, c.req.raw.signal);
        if (watched.ok) {
            return c.json(watched.value);
        }
        return json({ error: `"${row.name ?? row.document.name}": ${watched.message}` }, watched.status === 0 ? 502 : watched.status);
    },
});

// Each seam read as a request is answered, never as the table is built: a composition may serve it with no s2s at all.
export const s2sContactTasksRawRoutes = defineRawRoutes((services: ContactTaskServices) =>
    contactTasksRoutesOf({
        contacts: { list: () => services.s2s.contacts.list(), get: (id) => services.s2s.contacts.get(id) },
        book: { list: () => services.contactTasks.list() },
        personTasks: { list: () => services.personTasks.list() },
        askers: askerDepsOf(services),
        decide: (row, requestId, approve) => decideContactTask(takingCodeOf(services), row, requestId, approve),
        watch: (row, input, signal) => services.s2s.calls.client.call(row, "task.watch", input, signal),
    }),
);
