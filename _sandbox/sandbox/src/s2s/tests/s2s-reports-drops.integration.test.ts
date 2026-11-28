import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintSandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import type { ReceivedDrop } from "@intentic/sandbox-contract/schemas/account-routes";
import type { AccountProblem, AccountReportFiled } from "@intentic/sandbox-contract/schemas/issues";
import { S2sContactSchema, S2sMessageSendOutcomeSchema, S2sPairingAnswerSchema, S2sThreadSchema, S2sThreadsListSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { createAccountOutbox, reportDeliveryOf } from "../../account-routing/account-outbox.js";
import { createRouteAdmission } from "../../account-routing/admit-route.js";
import { contactBootstrapRoute } from "../../account-routing/messages/contact-bootstrap.routes.js";
import { type DropAsMessageDeps, dropAsMessage } from "../../account-routing/messages/drop-as-message.js";
import { dropsIntoThreadsStep, fileLegacyDrop, legacyMessageIdOf } from "../../account-routing/messages/drop-threads.js";
import { filePairingsStore } from "../../account-routing/pairings-store.js";
import { createReportIntake, type Filing } from "../../account-routing/messages/report-intake.js";
import { registerReportKind } from "../../account-routing/messages/report-kind.js";
import { reportOverS2s } from "../../account-routing/messages/report-over-s2s.js";
import { createRouteClient } from "../../account-routing/route-client.js";
import type { Caller } from "../../auth/auth.js";
import { jsonAnswer } from "../../http/cli-answer.js";
import type { StepPlan } from "../../store/evolution/state-steps.js";
import type { S2sAsker } from "../askers.js";
import { fileThreadsStore } from "../messages/threads-store.js";
import { type S2sDaemon, s2sDaemon, until } from "../s2s.testing.js";

// REPORTS AND DROPS ONTO CONTACTS AND MESSAGES, two daemons over HTTP: the first report from one of an owner's sandboxes to
// another that holds no contact for it goes through the introduction (`POST /account/contact-bootstrap` under a report
// pass) and arrives at the issues inbox's fire; the next goes straight as a message; with no issues inbox it waits in the
// messages outbox, repeats of it counting in the account outbox, and both arrive once the inbox is there. A drop to a
// sandbox held as a person's contact goes as a message with its files whole; a drop from a build before contacts shows as
// a thread for its person, and nothing is sent back over it; the drops waiting in the old inbox move into threads once.

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const A_ID = "aaaaaaaaaaaa";
const B_ID = "bbbbbbbbbbbb";
const OWNER = "owner@acme.test";
const ADA = "ada@acme.test";
const GUS = "gus@acme.test";
const PROJECT = "github.com/acme/app";
const quiet = { info: () => undefined, warn: () => undefined };

const roster = {
    [OWNER]: { email: OWNER, tier: "owner" } satisfies Caller,
    [ADA]: { email: ADA, tier: "collaborator", agents: "run" } satisfies Caller,
    [GUS]: { email: GUS, tier: "collaborator", agents: "run" } satisfies Caller,
};
const callerOf = (email: string): Caller | undefined => Object.values(roster).find((caller) => caller.email === email.toLowerCase());

let open: S2sDaemon[] = [];
afterEach(async () => {
    await Promise.all(open.map((made) => made.close()));
    open = [];
});

const problem = (message = "GET /api/orders answered 500 for order 81231"): AccountProblem => ({ kind: "detection", message });

// The issues extension's fire handler on b: what it took, and whether it is switched on.
const issuesInbox = () => {
    const filed: AccountReportFiled[] = [];
    const inbox = {
        on: true,
        filed,
        file: async (report: AccountReportFiled): Promise<Filing> => {
            if (!inbox.on) {
                return { kind: "later", why: "this sandbox has no issues inbox switched on (the Issues extension)" };
            }
            filed.push(report);
            return { kind: "taken", id: `issue-${filed.length}` };
        },
    };
    return inbox;
};

// b: the introduction door under the platform's pass, and the `report` kind handing reports to its issues inbox.
const receiver = async (inbox: ReturnType<typeof issuesInbox>): Promise<S2sDaemon> => {
    const admit = createRouteAdmission({
        identityKey: async () => publicKey,
        self: B_ID,
        roster: async () => ({ callerOf }),
        pairings: () => filePairingsStore(mkdtempSync(join(tmpdir(), "b-pairings-"))),
    });
    const made = await s2sDaemon("b", { roster, sandbox: B_ID, routes: (s2s) => ({ "POST /account/contact-bootstrap": contactBootstrapRoute(s2s.core, admit) }) });
    open.push(made);
    registerReportKind(made.s2s, { intake: createReportIntake({ file: inbox.file, now: Date.now }), logger: quiet });
    return made;
};

// a: its account outbox, routed by a platform that names b as the project's claimant and signs a report pass for it.
const sender = async (b: S2sDaemon) => {
    const a = await s2sDaemon("a", { roster, sandbox: A_ID });
    open.push(a);
    let clock = Date.now();
    const introductions: string[] = [];
    const route = createRouteClient({
        call: async () =>
            jsonAnswer(200, {
                scope: "report",
                project: PROJECT,
                sandboxId: B_ID,
                name: "b",
                // The platform names a sandbox by its https address; the edge ends TLS, which a's fetch below stands in for.
                address: `https://${b.host}`,
                pass: mintSandboxPass(privateKey, { from: A_ID, fromName: "a", to: B_ID, project: PROJECT, issuedAtMs: Date.now() }),
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
            }),
    });
    const overS2s = reportOverS2s({
        s2s: a.s2s,
        fetch: async (url, init) => {
            introductions.push(url);
            return fetch(url.replace(/^https:\/\/127\.0\.0\.1:/u, "http://127.0.0.1:"), init);
        },
        logger: quiet,
        firstTryMs: 5_000,
    });
    const outbox = createAccountOutbox({
        dir: join(a.root, "history", "account-outbox"),
        logger: quiet,
        route,
        deliver: { report: reportDeliveryOf(overS2s) },
        now: () => clock,
    });
    return { a, outbox, introductions, advance: (ms: number) => void (clock += ms) };
};

test("a first report introduces the sender and reaches the issues inbox as a message; the next goes straight as one", async () => {
    const inbox = issuesInbox();
    const b = await receiver(inbox);
    const { a, outbox, introductions } = await sender(b);

    expect(await outbox.send(PROJECT, problem(), { conversationId: "brave-fox" })).toEqual({ state: "delivered", to: "b", id: expect.any(String) });
    expect(introductions).toEqual([`https://${b.host}/account/contact-bootstrap`]);
    // b holds a for reports only; a holds b as granting it reports, and lets it do nothing here.
    const [theirs, ...moreThere] = await b.s2s.contacts.list();
    expect(moreThere).toEqual([]);
    expect(theirs).toMatchObject({ address: a.host, scope: { kind: "sandbox" }, state: "accepted", origin: "report-bootstrap" });
    expect(theirs?.grants).toEqual({ message: false, report: true, records: false, operate: false, wake: false });
    const [ours, ...moreHere] = await a.s2s.contacts.list();
    expect(moreHere).toEqual([]);
    expect(ours).toMatchObject({ address: b.host, state: "accepted", origin: "report-bootstrap", theirGrants: { report: true } });
    expect(ours?.grants).toEqual({ message: false, report: false, records: false, operate: false, wake: false });
    expect(inbox.filed).toEqual([
        { report: problem(), times: 1, sender: { sandboxId: A_ID, sandboxName: "a", address: a.host, project: PROJECT, conversationId: "brave-fox" } },
    ]);
    await until("b's automations hear the report", () => b.heard.length === 1);
    expect(b.heard.map((event) => [event.event, event.contact.address])).toEqual([["report", a.host]]);

    // The next report, another problem, goes over the contact with no introduction.
    const other = problem("the nightly export never finished");
    expect(await outbox.send(PROJECT, other)).toEqual({ state: "delivered", to: "b", id: expect.any(String) });
    expect(introductions).toHaveLength(1);
    expect(inbox.filed.map((filed) => filed.report)).toEqual([problem(), other]);
    expect(await outbox.list()).toEqual([]);
});

test("with no issues inbox a report waits as a message, a repeat counts beside it, and both arrive once the inbox is there", async () => {
    const inbox = issuesInbox();
    inbox.on = false;
    const b = await receiver(inbox);
    const { a, outbox, advance } = await sender(b);

    const first = await outbox.send(PROJECT, problem());
    expect(first).toMatchObject({ state: "queued", to: "b", times: 1, reason: expect.stringContaining("no issues inbox switched on") });
    expect(await outbox.list()).toEqual([]);
    const [waiting, ...more] = await a.s2s.outbox.list();
    expect(more).toEqual([]);
    expect(waiting).toMatchObject({ state: "waiting", payload: { kind: "report", project: PROJECT, times: 1 }, lastError: expect.stringContaining("no issues inbox") });

    // The same problem again: it counts in the account outbox while the first waits as a message.
    expect(await outbox.send(PROJECT, problem("GET /api/orders answered 500 for order 7"))).toMatchObject({
        state: "queued",
        times: 1,
        reason: expect.stringContaining("an earlier report of this problem still waits in the messages outbox"),
    });
    expect(await outbox.send(PROJECT, problem("GET /api/orders answered 500 for order 9"))).toMatchObject({ state: "queued", times: 2 });
    expect((await a.s2s.outbox.list()).filter((entry) => entry.state === "waiting")).toHaveLength(1);

    // The inbox comes on: the waiting message lands, then the count goes as one more message.
    inbox.on = true;
    await a.s2s.outbox.kickContact(waiting?.contact ?? "");
    await until("the first report lands", () => inbox.filed.length === 1);
    advance(2 * 60 * 60 * 1000);
    await outbox.drain();
    await until("the counted repeat lands", () => inbox.filed.length === 2);
    expect(inbox.filed.map((filed) => filed.times)).toEqual([1, 2]);
    expect(await outbox.list()).toEqual([]);
});

// A person-scoped contact for Ada between a and b, made by her pairing (both sandboxes hers to sign in to).
const pairAda = async (a: S2sDaemon, b: S2sDaemon) => {
    const answer = S2sPairingAnswerSchema.parse((await b.http(ADA, "POST", "/s2s/pairings", { document: await a.identity().document(), scope: "person", grants: {} })).body);
    return S2sContactSchema.parse((await a.http(ADA, "POST", "/s2s/contacts/paired", { answer, scope: "person", grants: {} })).body);
};

const adaTurn: S2sAsker = { kind: "turn", conversationId: "ada-talk", people: [ADA], maintainer: false };
const base64 = (bytes: Buffer | string): string => Buffer.from(bytes).toString("base64");

test("a drop to a sandbox held as the person's contact arrives as a message in a thread, its files whole", async () => {
    const a = await s2sDaemon("a", { roster, sandbox: A_ID });
    const b = await s2sDaemon("b", { roster, sandbox: B_ID });
    open.push(a, b);
    await pairAda(a, b);
    const held: string[] = [];
    // The platform names b at its address when asked for "b"; for anything else it says nothing.
    const located: string[] = [];
    const platform = async (person: string, sandbox: string) => {
        located.push(`${person}:${sandbox}`);
        return sandbox === "b" ? { sandboxId: B_ID, name: "b", address: `https://${b.host}`, pass: "", expiresAt: "" } : undefined;
    };
    const deps = (refusal?: string, locate = platform): DropAsMessageDeps => ({
        s2s: a.s2s,
        guard: { refusal: async () => refusal, record: (_asker, _row, text) => void held.push(text) },
        locate,
        owner: async () => OWNER,
        firstTryMs: 5_000,
    });
    const binary = Buffer.from([0, 255, 1, 254, 127, 128, 10, 13]);
    const files = [
        { name: "app.log", data: base64("boom") },
        { name: "core.bin", data: base64(binary) },
    ];

    const outcome = await dropAsMessage(deps(), adaTurn, ADA, { sandbox: "b", note: "the logs you asked for", files });
    expect(outcome).toEqual({ state: "delivered", to: "b", id: expect.any(String) });
    expect(held).toEqual(["the logs you asked for"]);
    const { threads } = S2sThreadsListSchema.parse((await b.http(ADA, "GET", "/s2s/threads")).body);
    expect(threads).toMatchObject([{ scope: { kind: "person", person: ADA }, contactName: "a", unread: 1 }]);
    const { messages } = S2sThreadSchema.parse((await b.http(ADA, "GET", `/s2s/threads/${threads[0]?.id ?? ""}`)).body);
    expect(messages).toMatchObject([
        {
            direction: "in",
            text: "the logs you asked for",
            as: ADA,
            attachments: [
                { name: "app.log", size: 4 },
                { name: "core.bin", size: 8 },
            ],
        },
    ]);
    const bytes = await fetch(`http://${b.host}/s2s/messages/${messages[0]?.id ?? ""}/files/core.bin`, { headers: { "x-test-as": ADA } });
    expect(Buffer.from(await bytes.arrayBuffer()).equals(binary)).toBe(true);
    // The sender's thread holds it as sent.
    const [mine] = S2sThreadsListSchema.parse((await a.http(ADA, "GET", "/s2s/threads")).body).threads;
    expect(S2sThreadSchema.parse((await a.http(ADA, "GET", `/s2s/threads/${mine?.id ?? ""}`)).body).messages).toMatchObject([
        { direction: "out", delivery: { state: "sent" } },
    ]);

    expect(located).toEqual([`${ADA}:b`]);

    // With the platform silent, a name the contact goes by finds nothing; the sandbox id the pairing vouched for does.
    const silent = async (): Promise<undefined> => undefined;
    expect(await dropAsMessage(deps(undefined, silent), adaTurn, ADA, { sandbox: "b", note: "by name", files: [] })).toBeUndefined();
    expect(await dropAsMessage(deps(undefined, silent), adaTurn, ADA, { sandbox: B_ID, note: "by id", files: [] })).toEqual({ state: "delivered", to: "b", id: expect.any(String) });

    // The old way instead: --wake, someone with no contact there, a turn that does not act for the contact's person.
    expect(await dropAsMessage(deps(), adaTurn, ADA, { sandbox: "b", note: "say it", files: [], wake: "ada-talk" })).toBeUndefined();
    expect(await dropAsMessage(deps(), { ...adaTurn, people: [GUS] }, GUS, { sandbox: "b", note: "hi", files: [] })).toBeUndefined();
    expect(await dropAsMessage(deps(), adaTurn, ADA, { sandbox: "elsewhere", note: "hi", files: [] })).toBeUndefined();
    // The owner's rules hold it: nothing goes.
    expect(await dropAsMessage(deps("held: messages need the owner's approval"), adaTurn, ADA, { sandbox: "b", note: "again", files: [] })).toEqual({
        state: "refused",
        reason: "held: messages need the owner's approval",
    });
    const previews = S2sThreadsListSchema.parse((await b.http(ADA, "GET", "/s2s/threads")).body).threads.map((thread) => thread.last?.preview);
    expect(previews.toSorted()).toEqual(["by id", "the logs you asked for"]);
});

test("a contact that only says it is the report's target, by its document's sandbox id and the grants it claims, is never sent the report", async () => {
    const inbox = issuesInbox();
    const b = await receiver(inbox);
    const { a, outbox, introductions } = await sender(b);
    // c names itself b's sandbox id in its own document, and says it takes a's reports.
    const c = await s2sDaemon("c", { roster, sandbox: B_ID });
    open.push(c);
    const added = S2sContactSchema.parse((await a.http(OWNER, "POST", "/s2s/contacts", { address: c.host })).body);
    await until("c files a's request", async () => (await c.s2s.contacts.list()).length === 1);
    const [request] = await c.s2s.contacts.list();
    expect((await c.http(OWNER, "POST", `/s2s/contacts/${request?.id ?? ""}/accept`, { grants: { report: true } })).status).toBe(200);
    await until("a hears c accept", async () => (await a.s2s.contacts.get(added.id))?.theirGrants?.report === true);
    expect((await a.s2s.contacts.get(added.id))?.document.sandbox).toBe(B_ID);

    expect(await outbox.send(PROJECT, problem())).toEqual({ state: "delivered", to: "b", id: expect.any(String) });
    expect(introductions).toEqual([`https://${b.host}/account/contact-bootstrap`]);
    expect(inbox.filed).toHaveLength(1);
    expect(c.heard.map((event) => event.event)).toEqual(["contact.request"]);
    expect((await a.s2s.outbox.list()).filter((entry) => entry.contact === added.id && entry.payload.kind === "report")).toEqual([]);
    // b's contact here is the one the platform's pass vouched for.
    expect((await a.s2s.contacts.list()).find((row) => row.address === b.host)?.vouchedSandbox).toBe(B_ID);
});

const dropFrom = (id: string, over: Partial<ReceivedDrop> = {}): ReceivedDrop => ({
    id: `${A_ID}-${id}`,
    from: { sandboxId: A_ID, sandboxName: "ops" },
    person: ADA,
    note: `note ${id}`,
    files: [{ name: "app.log", size: 4 }],
    receivedAt: 1_800_000_000_000,
    ...over,
});

test("a drop through the old door shows as a thread for its person, once, and nothing is sent back over it", async () => {
    const b = await s2sDaemon("b", { roster, sandbox: B_ID });
    open.push(b);
    const drop = dropFrom("drop0001");
    const filed = await fileLegacyDrop(b.s2s.threads, drop, [{ name: "app.log", bytes: Buffer.from("boom") }]);
    expect(filed).toMatchObject({ kind: "filed", message: legacyMessageIdOf(drop.id) });
    // Its retry lands once.
    await fileLegacyDrop(b.s2s.threads, drop, [{ name: "app.log", bytes: Buffer.from("boom") }]);

    const { threads } = S2sThreadsListSchema.parse((await b.http(ADA, "GET", "/s2s/threads")).body);
    expect(threads).toMatchObject([{ contactName: "ops", scope: { kind: "person", person: ADA }, unread: 1, messages: 1, last: { preview: "note drop0001" } }]);
    // Another member does not see it; a maintainer reads it.
    expect(S2sThreadsListSchema.parse((await b.http(GUS, "GET", "/s2s/threads")).body).threads).toEqual([]);
    expect(S2sThreadsListSchema.parse((await b.http(OWNER, "GET", "/s2s/threads")).body).threads).toHaveLength(1);
    const file = await fetch(`http://${b.host}/s2s/messages/${legacyMessageIdOf(drop.id)}/files/app.log`, { headers: { "x-test-as": ADA } });
    expect(await file.text()).toBe("boom");

    const answer = await b.http(ADA, "POST", "/s2s/messages", { to: threads[0]?.contact ?? "", text: "thanks", thread: threads[0]?.id ?? "" });
    expect(S2sMessageSendOutcomeSchema.parse(answer.body)).toEqual({
        state: "refused",
        reason: `ops runs a build from before contacts, so it takes no messages: answer with \`sandboxes send ops\` from a conversation acting for ${ADA}, which goes there as a drop`,
    });
});

// The boot step's plan read off the disk, as the boot step reads it, and applied as it would.
const onDisk = (history: string) => ({
    roots: { history, workspace: join(history, "..", "workspace"), auth: join(history, "..", "auth") },
    read: async (path: string) => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined),
    list: async (dir: string) => (existsSync(dir) ? readdirSync(dir) : []),
    kind: async (path: string) => (existsSync(path) ? (statSync(path).isDirectory() ? ("directory" as const) : ("file" as const)) : undefined),
});
const apply = (plan: StepPlan | undefined): void => {
    for (const [from, to] of plan?.renames ?? []) {
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
    }
    for (const [path, text] of plan?.writes ?? []) {
        if (text === undefined) {
            rmSync(path, { force: true });
        } else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, text);
        }
    }
};
// A drop as the old inbox kept it: its manifest and its files.
const waitingDrop = (history: string, drop: ReceivedDrop, bytes: string): void => {
    const dir = join(history, "account-inbox", drop.id);
    mkdirSync(join(dir, "files"), { recursive: true });
    writeFileSync(join(dir, "drop.json"), JSON.stringify(drop));
    writeFileSync(join(dir, "files", "app.log"), bytes);
};

test("the drops waiting in the old inbox move into their sender's thread once, files and all", async () => {
    const history = join(mkdtempSync(join(tmpdir(), "drops-move-")), "history");
    const first = dropFrom("drop0001", { receivedAt: 1_800_000_000_000 });
    const second = dropFrom("drop0002", { receivedAt: 1_800_000_060_000, note: "the second" });
    waitingDrop(history, first, "boom");
    waitingDrop(history, second, "bang");

    const plan = await dropsIntoThreadsStep.plan(onDisk(history));
    expect(plan?.changes).toEqual(["moves 2 drop(s) from account-inbox/ into 1 Messages thread(s)"]);
    apply(plan);
    const threads = fileThreadsStore(history);
    const [thread, ...more] = await threads.list();
    expect(more).toEqual([]);
    expect(thread).toMatchObject({ legacy: { sandboxId: A_ID, sandboxName: "ops", person: ADA } });
    expect(thread?.messages.map((message) => [message.id, message.text, message.read])).toEqual([
        [legacyMessageIdOf(first.id), "note drop0001", false],
        [legacyMessageIdOf(second.id), "the second", false],
    ]);
    expect((await threads.fileOf(legacyMessageIdOf(second.id), "app.log"))?.toString()).toBe("bang");
    expect(existsSync(join(history, "account-inbox", first.id, "drop.json"))).toBe(false);
    // Moved: nothing is left to move again.
    expect(await dropsIntoThreadsStep.plan(onDisk(history))).toBeUndefined();

    // A drop an older build filed in the old inbox after a rollback joins the same thread, the moved ones once each.
    waitingDrop(history, dropFrom("drop0003", { receivedAt: 1_800_000_120_000 }), "late");
    apply(await dropsIntoThreadsStep.plan(onDisk(history)));
    const [after, ...extra] = await threads.list();
    expect(extra).toEqual([]);
    expect(after?.id).toBe(thread?.id);
    expect(after?.messages).toHaveLength(3);
});
