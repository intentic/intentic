import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import { type LinkTaskStatus, LinkTaskStatusSchema } from "@intentic/sandbox-contract/schemas/links";
import { S2sContactSchema, S2sContactTaskSchema, S2sContactTasksSchema, S2sPairingAnswerSchema, type S2sTaskGrant } from "@intentic/sandbox-contract/schemas/s2s";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { listSubagentSessions } from "../../agent/subagents/subagents.js";
import type { Caller } from "../../auth/auth.js";
import { type LiveRun, RUNS } from "../../conversations/actor/conversation-holdings.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { serveRawRoutes } from "../../http/raw-route-server.js";
import { onLinkTaskStatusNudge } from "../../links/link-task-status-wait.js";
import { type LinkTaskDeps, noteLinkTurnAwaiting, noteLinkTurnSettled } from "../../links/link-tasks.js";
import { createLinkedChildren, type LinkedChildren } from "../../links/linked-children.js";
import { linkedChildrenDocument } from "../../links/linked-children-store.js";
import { notePersonTurnSettled, type PersonTaskDeps } from "../../links/person-tasks.js";
import { filePersonTasks, type PersonTasksStore, personTasksDocument } from "../../links/person-tasks-store.js";
import type { Said } from "../../seams/turn-starter.js";
import { memoryStartWindow } from "../../store/start-window.testing.js";
import { opt } from "../../opt.js";
import type { AskerDeps } from "../askers.js";
import { type S2sDaemon, s2sDaemon, until } from "../s2s.testing.js";
import { contactSendsOf, registerAskingKinds } from "../tasks/asking.js";
import { contactTasksRoutesOf } from "../../links/contacts/contact-tasks.routes.js";
import { type ContactTasksStore, contactTasksDocument, fileContactTasks } from "../../links/contacts/contact-tasks-store.js";
import { createTaskPusher, type TaskPusher } from "../../links/contacts/task-push.js";
import { contactStatusOf, contactTaskBook, decideContactTask, registerTakingKinds } from "../../links/contacts/taking.js";
import { taskCallHandlers } from "../../links/contacts/contact-calls.js";

// TASKS BETWEEN TWO SANDBOXES AS MESSAGES (messages.md, "Tasks"), each sandbox its real identity, contacts, admission,
// inbox and outbox on a port, its real task books on its history volume, the taking side's kinds and status push, and the
// asking side's roster records. Only the model turns are the suite's: the taking side records each turn it would start,
// and the suite ends it as the turn engine announces an end. Proven here: a task handed over runs and its report comes
// back pushed, settling the child and waking its parent; one waiting for the owner runs once they allow it on the
// contact; follow-ups, a question and its answer, and a stop; a person's own task; the hourly turns, the hops and a
// repeated request; and the taking side restarting mid-task.

const quiet = { info: () => undefined, warn: () => undefined };
const PROFILE: TurnProfile = { agent: "claude", model: "claude-opus-5-5" };
const OWNER_A = "owner@a.test";
const OWNER_B = "owner@b.test";
const ADA = "ada@acme.test";
const PARENT = { conversationId: "brave-parent-1", cwd: WORKSPACE_ROOT };
const ADA_PARENT = { conversationId: "ada-parent-1", cwd: WORKSPACE_ROOT };
// The conversations a turn acts for, by id; any other acts for the owner.
const PEOPLE = { [ADA_PARENT.conversationId]: [ADA] } satisfies Readonly<Record<string, readonly string[]>>;
const ADA_PEOPLE: readonly string[] = [ADA];
// A status push waits out its five seconds behind the last one; a wait for the next allows for it.
const PUSHED_MS = 15_000;

const rosterOf = (owner: string) => ({
    [owner]: { email: owner, tier: "owner" } satisfies Caller,
    [ADA]: { email: ADA, tier: "collaborator", agents: "run" } satisfies Caller,
});

// A roster's person by email, or nobody.
const callerOf = (callers: ReturnType<typeof rosterOf>, email: string): Caller | undefined => Object.values(callers).find((caller) => caller.email === email.toLowerCase());
const peopleOf = (conversationId: string): readonly string[] => (conversationId === ADA_PARENT.conversationId ? ADA_PEOPLE : []);

interface Side {
    readonly made: S2sDaemon;
    // Turns the taking side would start, answers it relayed to a run, and runs it stopped.
    readonly said: Said[];
    readonly replies: unknown[];
    readonly stopped: string[];
    // What woke a parent conversation on the asking side.
    readonly wakes: Said[];
    readonly linked: LinkedChildren;
    readonly roster: () => ReturnType<typeof listSubagentSessions>;
    readonly book: ContactTasksStore;
    readonly personTasks: PersonTasksStore;
    readonly link: LinkTaskDeps;
    readonly askers: AskerDeps;
    readonly parkIn: (conversationId: string, rows: readonly TranscriptRow[]) => void;
    // The taking side's in-memory half started again, as a daemon's boot starts it on the same history.
    readonly restart: () => Promise<void>;
    readonly close: () => void;
}

let open: Side[] = [];

const side = async (name: string, owner: string): Promise<Side> => {
    const callers = rosterOf(owner);
    const made = await s2sDaemon(name, { roster: callers, people: PEOPLE });
    const history = join(made.root, "history");
    const { conversations } = memoryFleet();
    const said: Said[] = [];
    const replies: unknown[] = [];
    const stopped: string[] = [];
    const wakes: Said[] = [];
    const turns = {
        say: async (words: Said) => {
            said.push(words);
            return { delivered: "started" as const, run: `run-${said.length}` };
        },
        reply: async (reply: unknown) => {
            replies.push(reply);
            return "settled" as const;
        },
        stop: async (target: { readonly conversationId?: string }) => {
            stopped.push(target.conversationId ?? "");
            return { stopped: true };
        },
    };
    const book = fileContactTasks(join(history, contactTasksDocument.path));
    const personTasks = filePersonTasks(join(history, personTasksDocument.path));
    const starts = memoryStartWindow();
    const link: LinkTaskDeps = { links: contactTaskBook(book, made.s2s.contacts), turns, conversations, starts, notify: () => undefined, logger: quiet };
    const person: PersonTaskDeps = { tasks: personTasks, turns, conversations, starts, personOf: async (email) => callerOf(callers, email), logger: quiet };
    const startTaking = () => {
        const pusher = createTaskPusher({
            contacts: made.s2s.contacts,
            book,
            personTasks,
            status: (row, task) => contactStatusOf({ link, person }, row, task),
            outbox: made.s2s.outbox,
            now: Date.now,
            logger: quiet,
        });
        const stops = [registerTakingKinds(made.s2s.kinds, { link, person, hear: made.s2s.hear, push: pusher.push }), onLinkTaskStatusNudge(pusher.nudge), pusher.start()];
        return { pusher, stop: () => stops.forEach((stop) => stop()) } satisfies { readonly pusher: TaskPusher; readonly stop: () => void };
    };
    let taking = startTaking();
    const askers: AskerDeps = { peopleOf: (id) => peopleOf(id), ownerEmail: async () => owner, tierOf: async (email) => callerOf(callers, email)?.tier };
    const sends = contactSendsOf({ contacts: () => made.s2s.contacts, outbox: () => made.s2s.outbox, askers: () => askers });
    const linked = createLinkedChildren({
        capabilities: async () => [],
        conversations,
        standingOf: () => undefined,
        entryOf: (id) => (id.endsWith("parent-1") || id.startsWith("link-") ? { title: "Release check" } : undefined),
        profileOf: () => PROFILE,
        inboundHops: async (id) => ((await book.linkOf(id)) ?? (await personTasks.ownerOf(id)))?.task.hops,
        doors: {
            turns: {
                say: async (words) => {
                    wakes.push(words);
                    return { delivered: "started", run: "run-wake" };
                },
            },
        },
        logger: quiet,
        historyPath: join(history, linkedChildrenDocument.path),
        contacts: sends,
    });
    registerAskingKinds(made.s2s.kinds, made.s2s.outbox, sends, linked);
    // What a contact's `task.watch` call answers here (links/contacts/contact-calls.ts).
    const unserve = made.s2s.calls.door.serve(taskCallHandlers({ link, person }));
    const built: Side = {
        made,
        said,
        replies,
        stopped,
        wakes,
        linked,
        roster: () => listSubagentSessions(conversations),
        book,
        personTasks,
        link,
        askers,
        parkIn: (conversationId, rows) => {
            // statusOf reads a run's `done`, `expired` and `rows`; anything else it reached would throw by name.
            conversations.holdings(RUNS).hold(conversationId, conversationId, unstubbed<LiveRun>("run", { id: `run-${conversationId}`, rows, done: false, expired: () => false }));
        },
        restart: async () => {
            taking.stop();
            taking = startTaking();
            await taking.pusher.sweep(true);
        },
        close: () => {
            taking.stop();
            unserve();
            linked.close();
        },
    };
    open.push(built);
    return built;
};

afterEach(async () => {
    for (const each of open) {
        each.close();
    }
    await Promise.all(open.map((each) => each.made.close()));
    open = [];
});

// The taking side's owner (or `as`, for a person's own route) pairs the asking side in with a task grant; answers each
// side's contact id for the other.
const pair = async (asking: Side, taking: Side, task: Partial<S2sTaskGrant>, as?: string) => {
    const scope = as === undefined ? "sandbox" : "person";
    const document = await asking.made.identity().document();
    const answered = await taking.made.http(as ?? taking.made.owner, "POST", "/s2s/pairings", { document, scope, grants: { task } });
    expect(answered.status).toBe(200);
    const answer = S2sPairingAnswerSchema.parse(answered.body);
    const out = S2sContactSchema.parse((await asking.made.http(as ?? asking.made.owner, "POST", "/s2s/contacts/paired", { answer, scope, grants: {} })).body);
    return { askingContact: out.id, takingContact: answer.contact };
};

const handed = async (asking: Side, parent: typeof PARENT, task: string, via?: "person"): Promise<string> => {
    const result = await asking.linked.delegate(parent, { to: "b", task, description: task.slice(0, 40), ...opt("via", via) });
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result.id;
};

const settled = (conversationId: string, closing: string) => ({ conversationId, run: "run-x", actor: undefined, speaker: undefined, failure: undefined, closing });

// The task-routes table on a port-less app, its person named by `x-test-as` as the s2s harness names one.
const routesOf = (taking: Side) => {
    const app = new Hono<AppEnv>();
    const callers = rosterOf(taking.made.owner);
    app.use(async (c, next) => {
        const caller = callerOf(callers, c.req.header("x-test-as") ?? "");
        if (caller !== undefined) {
            c.set("identity", { ...caller, methods: ["google"] });
        }
        await next();
    });
    serveRawRoutes(
        app,
        contactTasksRoutesOf({
            contacts: taking.made.s2s.contacts,
            book: taking.book,
            personTasks: taking.personTasks,
            askers: taking.askers,
            decide: (row, requestId, approve) => decideContactTask({ link: taking.link }, row, requestId, approve),
            watch: (row, input, signal) => taking.made.s2s.calls.client.call(row, "task.watch", input, signal),
        }),
    );
    return async (as: string, method: string, path: string, body?: object) => {
        const response = await app.request(path, { method, headers: { "content-type": "application/json", "x-test-as": as }, ...opt("body", body === undefined ? undefined : JSON.stringify(body)) });
        const answered: unknown = await response.json();
        return { status: response.status, body: answered };
    };
};

test("a task handed to a contact runs there; its report comes back pushed, settling the child and waking the parent; a follow-up reopens it and a stop ends it", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    const { askingContact, takingContact } = await pair(a, b, { approve: false });
    const id = await handed(a, PARENT, "What is the p99 on the checkout API?");
    expect(id.startsWith("linked-")).toBe(true);

    // Over there: one turn, unattended in its own worktree, drawn as the contact's and carrying its words as outside content.
    await until("b starts the task", () => b.said.length === 1);
    const remote = b.said[0]?.turn.conversationId ?? "";
    expect(remote.startsWith("link-")).toBe(true);
    expect(b.said[0]?.turn).toMatchObject({ unattended: true, isolated: true, messageId: `contact-${id}` });
    expect(b.said[0]?.turn.prompt).toContain(`Task from "a" (${a.made.host}), a sandbox this one keeps as a contact`);
    expect(b.said[0]?.outside).toBe(`the contact "a" (${a.made.host})`);
    expect(await b.book.task(takingContact, { requestId: id })).toMatchObject({ conversationId: remote, state: "running", hops: 0 });

    // Here: a linked child under its parent, naming the contact and the conversation over there once the first update says it.
    await until("the child runs, naming the conversation over there", () => a.roster()[0]?.status === "running" && a.roster()[0]?.linked?.conversationId === remote);
    expect(a.roster()).toEqual([
        expect.objectContaining({ id, kind: "linked", conversationId: PARENT.conversationId, linked: { link: `contact:${askingContact}`, sandbox: "b", conversationId: remote, contact: askingContact } }),
    ]);

    // The turn over there ends: the update is pushed at once, settling the child and waking the parent with the report.
    await noteLinkTurnSettled({ links: b.link.links, logger: quiet }, settled(remote, "p99 is 210ms."));
    await until("the child settles", () => a.roster()[0]?.status === "completed", PUSHED_MS);
    expect(a.linked.report(id)).toBe("p99 is 210ms.");
    await until("the parent is woken", () => a.wakes.length > 0);
    expect(a.wakes[0]?.turn.conversationId).toBe(PARENT.conversationId);
    expect(a.wakes[0]?.turn.prompt).toContain("p99 is 210ms.");
    expect(a.wakes[0]?.outside).toBe('the report of a task the contact "b" ran');

    // A follow-up: a second turn over there, and the record is live again.
    expect(await a.linked.send(PARENT, id, "And the p50?")).toMatchObject({ ok: true, note: expect.stringContaining("Sent") });
    expect(b.said[1]?.turn.prompt).toContain("And the p50?");
    expect(b.said[1]?.turn.prompt).toContain(`Follow-up from the contact "a" (${a.made.host})`);
    await until("the child runs again", () => a.roster()[0]?.status === "running", PUSHED_MS);

    // Stopped from here: stopped over there, and killed here once the stop is pushed back.
    expect(await a.linked.cancel(PARENT, id)).toMatchObject({ ok: true });
    expect(b.stopped).toEqual([remote]);
    await until("the child ends killed", () => a.roster()[0]?.status === "killed", PUSHED_MS);
});

test("a person here watches a task's live status over there by call, held until it moves; another person's or an unknown task is refused", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    const { askingContact } = await pair(a, b, { approve: false });
    const id = await handed(a, PARENT, "Count the open incidents.");
    await until("b starts the task", () => b.said.length === 1);
    const remote = b.said[0]?.turn.conversationId ?? "";

    const call = routesOf(a);
    const watched = await call(OWNER_A, "GET", `/s2s/contacts/${askingContact}/tasks/${id}/watch`);
    expect(watched.status).toBe(200);
    const status = LinkTaskStatusSchema.parse(watched.body);
    expect(status).toMatchObject({ conversationId: remote, state: "running" });

    // Held past the version it has: answered once the turn over there ends.
    const held = call(OWNER_A, "GET", `/s2s/contacts/${askingContact}/tasks/${id}/watch?after=${status.version}&wait=20`);
    await noteLinkTurnSettled({ links: b.link.links, logger: quiet }, settled(remote, "Four."));
    const moved = await held;
    expect(LinkTaskStatusSchema.parse(moved.body)).toMatchObject({ conversationId: remote, state: "finished", report: "Four." });

    // A sandbox's own contact is a maintainer's to use; a task it never handed over is the far side's 404, in its words.
    expect((await call(ADA, "GET", `/s2s/contacts/${askingContact}/tasks/${id}/watch`)).status).toBe(404);
    const unknown = await call(OWNER_A, "GET", `/s2s/contacts/${askingContact}/tasks/never-asked/watch`);
    expect(unknown).toEqual({ status: 404, body: { error: '"b": This sandbox holds no task by that id that your sandbox handed it.' } });
});

test("a task the contact's owner must allow waits as pending here; their Allow on the contact starts it there", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    const { takingContact } = await pair(a, b, { approve: true });
    const handover = await a.linked.delegate(PARENT, { to: "b", task: "Rotate the staging key." });
    expect(handover).toMatchObject({ ok: true, note: expect.stringContaining("holds it for its owner to allow") });
    const id = handover.ok ? handover.id : "";
    await until("the child waits, pending", () => a.roster()[0]?.status === "pending" && a.roster()[0]?.linked?.conversationId !== "");
    expect(b.said).toEqual([]);

    // On the taking side, the Messages tab lists it waiting, to the owner; a collaborator may not use the contact.
    const call = routesOf(b);
    const listed = S2sContactTasksSchema.parse((await call(OWNER_B, "GET", "/s2s/tasks")).body);
    expect(listed.tasks).toEqual([expect.objectContaining({ contact: takingContact, contactName: "a", requestId: id, state: "held", task: "Rotate the staging key." })]);
    expect((await call(ADA, "GET", "/s2s/tasks")).body).toEqual({ tasks: [] });
    expect((await call(ADA, "POST", `/s2s/contacts/${takingContact}/tasks/${id}`, { approve: true })).status).toBe(404);

    const allowed = await call(OWNER_B, "POST", `/s2s/contacts/${takingContact}/tasks/${id}`, { approve: true });
    expect(allowed.status).toBe(200);
    expect(S2sContactTaskSchema.parse(allowed.body)).toMatchObject({ requestId: id, state: "running" });
    expect(b.said).toHaveLength(1);
    await until("the child runs", () => a.roster()[0]?.status === "running", PUSHED_MS);
    expect((await call(OWNER_B, "POST", `/s2s/contacts/${takingContact}/tasks/${id}`, { approve: true })).status).toBe(409);
});

test("a question the task parks on over there reaches the parent, and its answer reaches the run", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    await pair(a, b, { approve: false });
    const id = await handed(a, PARENT, "Deploy the release.");
    await until("b starts the task", () => b.said.length === 1);
    const remote = b.said[0]?.turn.conversationId ?? "";
    await until("the child runs", () => a.roster()[0]?.status === "running");

    const question = {
        requestId: "q1",
        status: "pending" as const,
        questions: [{ question: "Which region?", header: "Region", multiSelect: false, options: [{ label: "eu", description: "Europe" }] }],
    };
    b.parkIn(remote, [{ role: "assistant", text: "", question }]);
    noteLinkTurnAwaiting({ conversationId: remote, awaiting: "question", requestId: "q1" });
    await until("the child is blocked on the question", () => a.roster()[0]?.status === "blocked", PUSHED_MS);
    expect(a.linked.pendingQuestion(id)).toMatchObject({ kind: "question", requestId: "q1" });
    await until("the parent hears the question", () => a.wakes.some((wake) => wake.turn.prompt.includes("Which region?")));

    expect(await a.linked.answer(PARENT, id, { "Which region?": ["eu"] })).toMatchObject({ ok: true });
    await until("the run over there is answered", () => b.replies.length === 1);
    expect(b.replies).toEqual([{ kind: "question", requestId: "q1", answers: { "Which region?": ["eu"] } }]);
});

test("a person-scoped contact's task runs as that person's own conversation over there", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    const { takingContact } = await pair(a, b, {}, ADA);
    // The owner's turn may not use Ada's own route: it hands nothing over as her.
    expect(await a.linked.delegate(PARENT, { to: "b", task: "x" })).toMatchObject({ ok: false });
    const id = await handed(a, ADA_PARENT, "Tidy my notes folder.", "person");
    await until("b starts the task", () => b.said.length === 1);
    const remote = b.said[0]?.turn.conversationId ?? "";
    expect(remote.startsWith("route-")).toBe(true);
    expect(b.said[0]?.turn.owner).toEqual({ email: ADA });
    expect(b.said[0]?.turn.prompt).toContain(`You work for ${ADA} here`);
    expect(await b.personTasks.task({ from: `contact:${takingContact}`, fromName: "a", person: ADA }, { requestId: id })).toMatchObject({ state: "running" });

    await until("the child runs", () => a.roster()[0]?.status === "running");
    await notePersonTurnSettled({ tasks: b.personTasks }, settled(remote, "Tidied."));
    await until("the child settles", () => a.roster()[0]?.status === "completed", PUSHED_MS);
    expect(a.linked.report(id)).toBe("Tidied.");
});

test("past the grant's turns an hour the task is refused in words, and nothing runs", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    await pair(a, b, { approve: false, turnsPerHour: 1 });
    await handed(a, PARENT, "First.");
    const second = await a.linked.delegate(PARENT, { to: "b", task: "Second." });
    expect(second).toEqual({
        ok: false,
        message:
            '"b" did not take the task: Your sandbox has started 1 turns here in the last hour, which is all the task grant this sandbox gives it allows. Wait, or ask this sandbox\'s owner to raise the grant\'s turns an hour. (task)',
    });
    expect(b.said).toHaveLength(1);
    expect(a.roster()).toHaveLength(1);
});

test("a task that came in over hand-overs goes no further: the asking side refuses before sending, the taking side past the hops", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    const { askingContact } = await pair(a, b, { approve: false });
    // A conversation here that a contact's task opened, itself one hand-over deep: handing on would be the third.
    await a.book.addTask("some-contact", { requestId: "r-deep", conversationId: "link-came-in", task: "x", hops: 1, held: false });
    expect(await a.linked.delegate({ conversationId: "link-came-in", cwd: WORKSPACE_ROOT }, { to: "b", task: "Pass it on." })).toMatchObject({
        ok: false,
        message: expect.stringContaining("never handed on past 2"),
    });

    // Sent anyway, past the hops: refused over there in words, and nothing runs.
    const row = await a.made.s2s.contacts.get(askingContact);
    if (row === undefined) {
        throw new Error("no contact");
    }
    await a.made.s2s.outbox.enqueue({ contact: row, payload: { kind: "task.request", requestId: "linked-deep", task: "Pass it on.", hops: 2 }, hops: 2 });
    await until("the request is refused", async () => (await a.made.s2s.outbox.list()).some((entry) => entry.state === "undelivered"));
    expect((await a.made.s2s.outbox.list()).find((entry) => entry.state === "undelivered")?.lastError).toContain("(hops)");
    expect(b.said).toEqual([]);
});

test("a request asked again under the same id answers the task already taken: one turn, one task", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    const { askingContact, takingContact } = await pair(a, b, { approve: false });
    const row = await a.made.s2s.contacts.get(askingContact);
    if (row === undefined) {
        throw new Error("no contact");
    }
    const request = { kind: "task.request" as const, requestId: "linked-twice", task: "Count the incidents.", hops: 0 };
    await a.made.s2s.outbox.enqueue({ contact: row, payload: request });
    await until("b starts the task", () => b.said.length === 1);
    await a.made.s2s.outbox.enqueue({ contact: row, payload: request });
    await until("both requests are delivered", async () => (await a.made.s2s.outbox.list()).every((entry) => entry.payload.kind !== "task.request"));
    expect(b.said).toHaveLength(1);
    expect((await b.book.list()).flatMap((entry) => entry.tasks)).toEqual([expect.objectContaining({ requestId: "linked-twice" })]);
    expect(await b.book.task(takingContact, { requestId: "linked-twice" })).toMatchObject({ state: "running" });
});

test("the taking side restarting mid-task still pushes the task's ending, which settles the child", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    await pair(a, b, { approve: false });
    const id = await handed(a, PARENT, "Run the nightly report.");
    await until("b starts the task", () => b.said.length === 1);
    const remote = b.said[0]?.turn.conversationId ?? "";
    await until("the child runs", () => a.roster()[0]?.status === "running");

    // A restart: what was pushed is forgotten, and the boot pushes every live task's status again, which moves nothing here.
    await b.restart();
    await noteLinkTurnSettled({ links: b.link.links, logger: quiet }, settled(remote, "Report sent."));
    await until("the child settles", () => a.roster()[0]?.status === "completed", PUSHED_MS);
    expect(a.linked.report(id)).toBe("Report sent.");
    await until("the parent is woken once", () => a.wakes.length === 1);
});

test("an update for a version already taken moves nothing: a settled child is not woken twice", async () => {
    const a = await side("a", OWNER_A);
    const b = await side("b", OWNER_B);
    const { askingContact } = await pair(a, b, { approve: false });
    const id = await handed(a, PARENT, "Count the incidents.");
    await until("b starts the task", () => b.said.length === 1);
    await noteLinkTurnSettled({ links: b.link.links, logger: quiet }, settled(b.said[0]?.turn.conversationId ?? "", "Seven."));
    await until("the parent is woken", () => a.wakes.length === 1, PUSHED_MS);
    const status: LinkTaskStatus = { conversationId: b.said[0]?.turn.conversationId ?? "", state: "finished", report: "Seven.", version: 12, updatedAt: Date.now() };
    await a.linked.heard(askingContact, id, status);
    expect(a.wakes).toHaveLength(1);
});
