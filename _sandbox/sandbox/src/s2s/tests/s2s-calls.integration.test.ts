import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmsSession, openSession, sealCall, type SessionKey } from "@intentic/sandbox-contract/s2s";
import { ConversationBundleSchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import {
    S2S_SESSION_HEADER,
    S2sContactSchema,
    S2sPairingAnswerSchema,
    S2sRefusalSchema,
    S2sSessionAnswerSchema,
    type S2sGrantsInput,
} from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import { createApp } from "../../app.js";
import { testConfig } from "../../env.config.testing.js";
import type { Caller } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import { clientFor, proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryMembersStore } from "../../harness/route-stores.testing.js";
import { runAgentTurn } from "../../harness/route-turns.testing.js";
import { operateCallHandlers, recordsCallHandlers } from "../../links/contacts/contact-calls.js";
import { createOperator } from "../../links/link-operate.js";
import { fleetReadAs, sandboxReader } from "../../links/link-records.js";
import { type S2sDaemon, s2sDaemon } from "../s2s.testing.js";
import type { ContactRow } from "../contacts/contacts-store.js";

// CALLS BETWEEN TWO SANDBOXES (messages.md, "Calls"), each its real identity, contacts and calls door on a port. The
// callee answers records from a whole daemon's fleet reads (two conversations Ada opened there, one of them private to
// her) and operates in a temp workspace where a person's shell would run; the caller reaches it with its session client,
// with `agents … --on` and `diagnostics --on` through its own daemon, and by hand where a suite plays the attacker. Proven
// here: a session opens with one signature, proves its key, and carries many calls; records and operating are refused in
// words without their grant and answered with it; a person's contact reads only what that person may read, diagnostics as
// a maintainer only, and never operates; a replayed call, a stale one and one sealed for another session or method are
// refused; and a key rotated on either side opens a new session.

const quiet = { info: () => undefined, warn: () => undefined };
const OWNER_A = "owner@a.test";
const OWNER_B = "owner@b.test";
const MAX = "max@acme.test";
const ADA = "ada@acme.test";
const AGENT = { "x-intentic-agent": "agent-secret" };

// Max maintains both sandboxes and Ada collaborates on both, so each can pair a route of their own.
const rosterOf = (owner: string) => ({
    [owner]: { email: owner, tier: "owner" } satisfies Caller,
    [MAX]: { email: MAX, tier: "maintainer" } satisfies Caller,
    [ADA]: { email: ADA, tier: "collaborator", agents: "run" } satisfies Caller,
});

const membersOf = () =>
    memoryMembersStore([
        { email: MAX, tier: "maintainer" },
        { email: ADA, tier: "collaborator" },
    ]);

// A whole daemon's services over a sandbox's s2s side, on a history volume of its own: what the fleet's reads and `--on`
// stand on.
const wholeOf = (made: S2sDaemon, owner: string): Services =>
    services({
        config: { ...testConfig, historyRoot: join(made.root, "history") },
        s2s: made.s2s,
        auth: { authorize: async () => proven(ADA, "collaborator") },
        members: membersOf(),
        ownerEmail: async () => owner,
        // Each author chooses, so a conversation opened private is born sealed to its author.
        sealHouse: unstubbed<Services["sealHouse"]>("sealHouse", { read: async () => ({ mode: "chooses" as const, defaults: {} }) }),
        turnCheckpoints: { record: async () => {}, of: async () => undefined, all: async () => new Map(), truncate: async () => {} },
        async *agent() {
            yield { kind: "session", sessionId: "sess-calls" };
            yield { kind: "done" };
        },
        sessions: { list: async () => [], read: async () => [{ role: "user" as const, text: "plan the release" }], readTail: async () => [], search: async () => [], exists: async () => true },
    });

interface Pair {
    readonly a: S2sDaemon;
    readonly b: S2sDaemon;
    // b's workspace, where its operated commands run.
    readonly root: string;
    // Each side as a whole daemon: b's answers records, a's relays `--on`.
    readonly taking: Services;
    readonly asking: Services;
}

let open: S2sDaemon[] = [];
afterEach(async () => {
    await Promise.all(open.map((made) => made.close()));
    open = [];
});

// Two sandboxes; the callee holding two conversations Ada opened (one private, so each sandbox's turns would need a jail
// this machine may not build: they end failed, which the reads below show as they would any), and serving every call method.
const sandboxes = async (): Promise<Pair> => {
    const a = await s2sDaemon("a", { roster: rosterOf(OWNER_A) });
    const b = await s2sDaemon("b", { roster: rosterOf(OWNER_B) });
    open.push(a, b);
    const taking = wholeOf(b, OWNER_B);
    const app = createApp(taking);
    await runAgentTurn(clientFor(app), { prompt: "plan the release", conversationId: "open-talk", isolated: true });
    await runAgentTurn(clientFor(app), { prompt: "my review notes", conversationId: "sealed-talk", isolated: true, private: true });
    const root = join(b.root, "workspace", "main");
    mkdirSync(root, { recursive: true });
    b.s2s.calls.door.serve({ ...recordsCallHandlers(taking), ...operateCallHandlers(createOperator({ logger: quiet, root, place: async () => ({ jailed: false }) })) });
    return { a, b, root, taking, asking: wholeOf(a, OWNER_A) };
};

// b grants a what `grants` says, paired by its owner or, for a person's own route, by that person on both sides; answers
// a's row for b and b's row id for a.
const pair = async ({ a, b }: Pair, grants: S2sGrantsInput, as?: string): Promise<{ readonly row: ContactRow; readonly theirs: string }> => {
    const scope = as === undefined ? "sandbox" : "person";
    const document = await a.identity().document();
    const answered = await b.http(as ?? b.owner, "POST", "/s2s/pairings", { document, scope, grants });
    expect(answered.status).toBe(200);
    const answer = S2sPairingAnswerSchema.parse(answered.body);
    const made = S2sContactSchema.parse((await a.http(as ?? a.owner, "POST", "/s2s/contacts/paired", { answer, scope, grants: {} })).body);
    const row = await a.s2s.contacts.get(made.id);
    if (row === undefined) {
        throw new Error("a filed no contact for b");
    }
    return { row, theirs: answer.contact };
};

const AgentsSchema = z.looseObject({ agents: z.array(z.looseObject({ id: z.string() })) });

// One conversation with its transcript, as b's own link doors read it.
const doorsRead = async ({ taking }: Pair, handle: string) =>
    z.looseObject({}).parse((await fleetReadAs(taking, sandboxReader(taking), { handle, query: { transcript: "1" } })).body);
const idsOf = (value: unknown): string[] => AgentsSchema.parse(value).agents.map((agent) => agent.id).toSorted();

describe("a session", () => {
    test("opens with one signature, proves it derived the same key, and carries many calls", async () => {
        const pairing = await sandboxes();
        const { a, b } = pairing;
        const { row } = await pair(pairing, { records: true });

        // By hand, as the client does it: the callee's confirm is an HMAC under the very key the caller derived.
        const opened = openSession({ from: a.host, to: b.host, caller: await a.identity().current(), callee: row.document.keys, now: Date.now() });
        expect((await b.http(undefined, "POST", "/s2s/session", { v: 1 })).status).toBe(400);
        const session = await fetch(`http://${b.host}/s2s/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opened.request) });
        expect(session.status).toBe(200);
        const answer = S2sSessionAnswerSchema.parse(await session.json());
        expect(confirmsSession(opened.key, answer.session, answer.confirm)).toBe(true);
        expect(confirmsSession(new Uint8Array(32), answer.session, answer.confirm)).toBe(false);
        // The same request again is a replay, refused in words.
        const again = await fetch(`http://${b.host}/s2s/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opened.request) });
        expect(again.status).toBe(409);
        expect(S2sRefusalSchema.parse(await again.json())).toMatchObject({ code: "replay" });

        // Through the client: one session for ten calls, so one signature.
        for (let call = 0; call < 10; call += 1) {
            expect(await a.s2s.calls.client.call(row, "records.diagnostics", { query: "restarts" })).toMatchObject({ ok: true, value: { text: expect.any(String) } });
        }
        expect(a.s2s.calls.client.opened()).toBe(1);
        expect(b.s2s.calls.door.held()).toBe(2);
    });

    test("is refused to a sandbox that is not a contact, and to a request signed outside the clock's window", async () => {
        const pairing = await sandboxes();
        const { a, b } = pairing;
        const { row } = await pair(pairing, { records: true });
        const stranger = await s2sDaemon("c", { roster: rosterOf("owner@c.test") });
        open.push(stranger);
        const asked = async (from: S2sDaemon, at: number) => {
            const request = openSession({ from: from.host, to: b.host, caller: await from.identity().current(), callee: row.document.keys, now: at }).request;
            const response = await fetch(`http://${b.host}/s2s/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
            return { status: response.status, body: S2sRefusalSchema.parse(await response.json()) };
        };
        expect(await asked(stranger, Date.now())).toMatchObject({ status: 403, body: { code: "not_contact" } });
        expect(await asked(a, Date.now() - 5 * 60_000)).toMatchObject({ status: 409, body: { code: "replay", error: expect.stringContaining("stale") } });
    });
});

describe("records", () => {
    test("are refused in words without the grant, and answered as the link doors answer with it", async () => {
        const pairing = await sandboxes();
        const { a, b } = pairing;
        const { row, theirs } = await pair(pairing, {});
        const refused = await a.s2s.calls.client.call(row, "records.fleet", {});
        expect(refused).toEqual({ ok: false, status: 403, message: "this sandbox has not granted yours records: its owner can, on the contact", code: "grant" });

        await b.s2s.contacts.change(theirs, (held) => ({ ...held, grants: { ...held.grants, records: true } }));
        const { client } = a.s2s.calls;
        const roster = await client.call(row, "records.fleet", {});
        // A private conversation is read by its readers alone: the sandbox's own reads pass none.
        expect(roster.ok ? idsOf(roster.value) : roster).toEqual(["open-talk"]);
        // The very answer b's link doors give the same read.
        const linkDoors = await doorsRead(pairing, "open-talk");
        expect(linkDoors).toMatchObject({ agent: { id: "open-talk" }, transcript: { total: expect.any(Number) } });
        expect(await client.call(row, "records.show", { handle: "open-talk", query: { transcript: "1" } })).toEqual({ ok: true, value: linkDoors });
        expect(await client.call(row, "records.show", { handle: "sealed-talk" })).toMatchObject({ ok: false, status: 404, body: { message: expect.stringContaining("No conversation answers") } });
        const bundle = await client.call(row, "records.bundle", { handle: "open-talk" });
        expect(ConversationBundleSchema.parse(bundle.ok ? bundle.value : bundle)).toMatchObject({ kind: "intentic.conversation-bundle", conversation: "open-talk" });
        expect(await client.call(row, "records.diagnostics", { query: "timeline", conversationId: "open-talk" })).toMatchObject({
            ok: true,
            value: { text: expect.stringContaining("open-talk"), sandbox: expect.any(String) },
        });
    });

    test("a person's contact reads only what that person may read there, and diagnostics only as a maintainer", async () => {
        const pairing = await sandboxes();
        const { a } = pairing;
        const max = (await pair(pairing, { records: true }, MAX)).row;
        const ada = (await pair(pairing, { records: true }, ADA)).row;
        const { client } = a.s2s.calls;
        const maxRoster = await client.call(max, "records.fleet", {});
        expect(maxRoster.ok ? idsOf(maxRoster.value) : maxRoster).toEqual(["open-talk"]);
        expect(await client.call(max, "records.show", { handle: "sealed-talk" })).toMatchObject({ ok: false, status: 404 });
        // Ada reads her own private conversation as its reader.
        const adaRoster = await client.call(ada, "records.fleet", {});
        expect(adaRoster.ok ? idsOf(adaRoster.value) : adaRoster).toEqual(["open-talk", "sealed-talk"]);
        expect(await client.call(ada, "records.show", { handle: "sealed-talk" })).toMatchObject({ ok: true, value: { agent: { id: "sealed-talk" } } });
        expect(await client.call(max, "records.diagnostics", { query: "restarts" })).toMatchObject({ ok: true });
        expect(await client.call(ada, "records.diagnostics", { query: "restarts" })).toMatchObject({
            ok: false,
            status: 403,
            code: "floor",
            message: `${ADA} may not read this sandbox's diagnostics: they are for its owner and its maintainers`,
        });
    });

    test("`agents --on` and `diagnostics --on` go to a contact by its name before any link", async () => {
        const pairing = await sandboxes();
        const { b } = pairing;
        const { theirs } = await pair(pairing, {});
        const app = createApp(pairing.asking);
        const read = async (path: string, init: RequestInit = {}) => {
            const response = await app.request(`http://sandbox.test${path}`, { ...init, headers: { ...AGENT, "content-type": "application/json" } });
            return { status: response.status, body: z.looseObject({}).parse(await response.json()) };
        };
        // Named, but not granted: b's own words, said as b's.
        expect(await read("/fleet?on=b")).toEqual({ status: 403, body: { ok: false, message: '"b": this sandbox has not granted yours records: its owner can, on the contact' } });

        await b.s2s.contacts.change(theirs, (held) => ({ ...held, grants: { ...held.grants, records: true } }));
        expect(idsOf((await read("/fleet?on=b")).body)).toEqual(["open-talk"]);
        expect(await read("/fleet/open-talk?on=b&transcript=1")).toEqual({ status: 200, body: await doorsRead(pairing, "open-talk") });
        expect(await read("/fleet/nobody-here?on=b")).toMatchObject({ status: 404, body: { message: expect.stringContaining("No conversation answers") } });
        expect(await read("/fleet/open-talk/bundle?on=b")).toMatchObject({ status: 200, body: { kind: "intentic.conversation-bundle", conversation: "open-talk" } });
        const timeline = await read("/diagnostics", { method: "POST", body: JSON.stringify({ query: "timeline", conversationId: "open-talk", on: "b" }) });
        expect(timeline).toMatchObject({ status: 200, body: { sandbox: "b", text: expect.stringContaining("open-talk") } });

        // A link card the owner holds by that name keeps it: the contact named "b" no longer answers for "b", only by its id.
        await pairing.asking.capabilities.upsert({ id: "b", kind: "link", config: { url: `http://${b.host}`, token: "ilk_not-a-token" } });
        // (The card's own door here is no link door, so it answers 404: what matters is that the card was asked.)
        expect(await read("/fleet?on=b")).toEqual({ status: 404, body: { ok: false, message: "it answered 404" } });
        const [contact] = await pairing.a.s2s.contacts.list();
        expect(idsOf((await read(`/fleet?on=${contact?.id ?? ""}`)).body)).toEqual(["open-talk"]);
    });
});

describe("operating", () => {
    test("with the grant runs commands, reads and writes where a person's shell runs, each command the contact's own", async () => {
        const pairing = await sandboxes();
        const { a, root } = pairing;
        const { row } = await pair(pairing, { operate: true });
        const { client } = a.s2s.calls;
        expect(await client.call(row, "operate.exec", { command: "pwd; echo out; exit 3", waitS: 10 })).toMatchObject({
            ok: true,
            value: { state: "exited", exitCode: 3, stdout: `${root}\nout\n`, jailed: false },
        });
        const long = await client.call(row, "operate.exec", { command: "sleep 30", waitS: 0 });
        const id = long.ok ? long.value.id : "";
        expect(await client.call(row, "operate.status", { id })).toMatchObject({ ok: true, value: { state: "running" } });
        expect(await client.call(row, "operate.stop", { id })).toMatchObject({ ok: true, value: { state: "stopped" } });
        expect(await client.call(row, "operate.status", { id: "op-nobody" })).toMatchObject({ ok: false, status: 404, message: expect.stringContaining("This contact started no command") });
        expect(await client.call(row, "operate.write", { path: "notes/a.txt", content: "one\ntwo\n" })).toEqual({ ok: true, value: { path: join(root, "notes", "a.txt"), bytes: 8, jailed: false } });
        expect(readFileSync(join(root, "notes", "a.txt"), "utf8")).toBe("one\ntwo\n");
        expect(await client.call(row, "operate.read", { path: "notes/a.txt", offset: 2, limit: 1 })).toMatchObject({ ok: true, value: { kind: "file", content: "two\n", lines: 2 } });
    });

    test("is refused without the grant, and to a person's own contact whatever it was given", async () => {
        const pairing = await sandboxes();
        const { a } = pairing;
        const plain = (await pair(pairing, { records: true })).row;
        const max = (await pair(pairing, { records: true, operate: true }, MAX)).row;
        const { client } = a.s2s.calls;
        const ungranted = { ok: false, status: 403, code: "grant", message: "this sandbox has not granted yours operate: its owner can, on the contact" } as const;
        for (const row of [plain, max]) {
            expect(await client.call(row, "operate.exec", { command: "id" })).toEqual(ungranted);
            expect(await client.call(row, "operate.read", { path: "." })).toEqual(ungranted);
            expect(await client.call(row, "operate.write", { path: "x", content: "y" })).toEqual(ungranted);
        }
    });
});

describe("a call", () => {
    // A session opened by hand, as an attacker holding a recorded call would see one.
    const byHand = async ({ a, b }: Pair, row: ContactRow): Promise<{ readonly session: string; readonly key: SessionKey }> => {
        const opened = openSession({ from: a.host, to: b.host, caller: await a.identity().current(), callee: row.document.keys, now: Date.now() });
        const response = await fetch(`http://${b.host}/s2s/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opened.request) });
        return { session: S2sSessionAnswerSchema.parse(await response.json()).session, key: opened.key };
    };
    const post = async (b: S2sDaemon, session: string, method: string, body: object) => {
        const response = await fetch(`http://${b.host}/s2s/call/${method}`, { method: "POST", headers: { "content-type": "application/json", [S2S_SESSION_HEADER]: session }, body: JSON.stringify(body) });
        const answered: unknown = await response.json();
        return { status: response.status, body: answered };
    };

    test("replayed, stale, or sealed for another session or method is refused", async () => {
        const pairing = await sandboxes();
        const { b } = pairing;
        const { row } = await pair(pairing, { records: true });
        const first = await byHand(pairing, row);
        const second = await byHand(pairing, row);
        const sealed = sealCall(first.key, { session: first.session, method: "records.fleet", leg: { direction: "call" } }, {}, Date.now());
        expect(await post(b, first.session, "records.fleet", sealed)).toMatchObject({ status: 200 });
        expect(await post(b, first.session, "records.fleet", sealed)).toMatchObject({ status: 409, body: { code: "replay", error: expect.stringContaining("seen before") } });
        const stale = sealCall(first.key, { session: first.session, method: "records.fleet", leg: { direction: "call" } }, {}, Date.now() - 5 * 60_000);
        expect(await post(b, first.session, "records.fleet", stale)).toMatchObject({ status: 409, body: { code: "replay", error: expect.stringContaining("stale") } });
        const fresh = () => sealCall(first.key, { session: first.session, method: "records.fleet", leg: { direction: "call" } }, {}, Date.now());
        expect(await post(b, first.session, "records.show", fresh())).toMatchObject({ status: 403, body: { code: "signature" } });
        expect(await post(b, second.session, "records.fleet", fresh())).toMatchObject({ status: 403, body: { code: "signature" } });
        expect(await post(b, "cs-nobody", "records.fleet", fresh())).toMatchObject({ status: 409, body: { code: "session" } });
        expect(await post(b, first.session, "records.everything", fresh())).toMatchObject({ status: 422, body: { code: "unknown_kind" } });
    });

    test("a key rotated on either side opens a new session, and the call goes through on it", async () => {
        const pairing = await sandboxes();
        const { a, b } = pairing;
        const { row, theirs } = await pair(pairing, { records: true });
        const { client } = a.s2s.calls;
        expect(await client.call(row, "records.diagnostics", { query: "restarts" })).toMatchObject({ ok: true });
        expect(client.opened()).toBe(1);

        // The caller rotates: its sessions end, and the next is signed by the new key, which b takes as a vouched rotation.
        const rotated = (await a.identity().rotate()).document.fingerprint;
        expect(await client.call(row, "records.diagnostics", { query: "restarts" })).toMatchObject({ ok: true });
        expect(client.opened()).toBe(2);
        expect((await b.s2s.contacts.get(theirs))?.document.fingerprint).toBe(rotated);

        // The callee rotates: it forgets every session, the caller hears so and opens one more.
        await b.identity().rotate();
        expect(b.s2s.calls.door.held()).toBe(0);
        expect(await client.call(row, "records.diagnostics", { query: "restarts" })).toMatchObject({ ok: true });
        expect(client.opened()).toBe(3);
    });
});
