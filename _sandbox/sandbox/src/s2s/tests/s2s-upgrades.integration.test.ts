import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { mintSandboxPass, ROUTE_SECRET_HEADER, SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import type { Capability, LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { LINK_HEADER, type LinkPeer, type LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import type { TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { signIdentity } from "@intentic/sandbox-contract/s2s";
import { S2sGrantsSchema, S2sUpgradeAnswerSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { createRouteAdmission } from "../../account-routing/admit-route.js";
import { PERSON_ROUTE_GRANTS, pairingUpgradeRoute, ROUTE_ASKER_GRANTS, upgradeRoutePairing } from "../../account-routing/messages/pairing-upgrade.js";
import { filePairingsStore, type PairingsStore } from "../../account-routing/pairings-store.js";
import { requirePairing } from "../../account-routing/require-pairing.js";
import type { RouteAnswer } from "../../account-routing/route-client.js";
import { fileRouteSecrets, type RouteSecretsStore, routeSecretsDocument } from "../../account-routing/route-secrets.js";
import { listSubagentSessions } from "../../agent/subagents/subagents.js";
import type { Caller } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { type ContactTasksStore, contactTasksDocument, fileContactTasks } from "../../links/contacts/contact-tasks-store.js";
import { createTaskPusher } from "../../links/contacts/task-push.js";
import { contactStatusOf, contactTaskBook, registerTakingKinds } from "../../links/contacts/taking.js";
import { fileInboundLinks, type InboundLinks, inboundLinksDocument } from "../../links/inbound-links.js";
import { onLinkTaskStatusNudge } from "../../links/link-task-status-wait.js";
import { type LinkTaskDeps, noteLinkTurnSettled } from "../../links/link-tasks.js";
import { createLinkedChildren, type LinkedChildren } from "../../links/linked-children.js";
import { linkedChildrenDocument } from "../../links/linked-children-store.js";
import { createLinkRoutes } from "../../links/links.routes.js";
import type { PersonTaskDeps } from "../../links/person-tasks.js";
import { filePersonTasks, personTasksDocument } from "../../links/person-tasks-store.js";
import { grantsOfTerms } from "../../links/upgrade/link-upgrade-in.js";
import { LINK_ASKER_GRANTS, upgradeLinkCard } from "../../links/upgrade/link-upgrade-out.js";
import { linkUpgradeRoute } from "../../links/upgrade/link-upgrade.routes.js";
import type { Said } from "../../seams/turn-starter.js";
import { memoryStartWindow } from "../../store/start-window.testing.js";
import type { AskerDeps } from "../askers.js";
import type { UpgradeOutcome } from "../contacts/contact-upgrade.js";
import type { ContactRow } from "../contacts/contacts-store.js";
import { type S2sDaemon, s2sDaemon, until } from "../s2s.testing.js";
import { contactSendsOf, registerAskingKinds } from "../tasks/asking.js";

// LINKS AND ROUTE PAIRINGS BECOME CONTACTS BY THEMSELVES (messages.md, "Across versions"), two daemons over HTTP, each its
// real identity, contacts, admission, inbox and outbox, the taking side its real link doors, link store, contact task book
// and status push, the asking side its real linked children over the real link wire. Only the model turns are the suite's.
// Proven here: a link with records, operate and tasks becomes a contact holding exactly those grants on one side and
// messages and wakes on the other; its token stops working everywhere; a task handed over the link before the upgrade
// still reports to the asker, pushed now as the contact's; a route pairing becomes the person's contact on both sides and
// its secret goes, and a send as that person raises no route card any more; each upgrade asked twice answers the same
// contact; and a far daemon that does not speak s2s/1 is left on the old path, card, token and secret untouched.

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const quiet = { info: () => undefined, warn: () => undefined };
const PROFILE: TurnProfile = { agent: "claude", model: "claude-opus-5-5" };
const A_ID = "aaaaaaaaaaaa";
const B_ID = "bbbbbbbbbbbb";
const OWNER = "owner@acme.test";
const ADA = "ada@acme.test";
const PARENT = { conversationId: "brave-parent-1", cwd: WORKSPACE_ROOT };
// A status push waits out its five seconds behind the last one; a wait for the next allows for it.
const PUSHED_MS = 15_000;
const TERMS: LinkTerms = { approve: false, turnsPerHour: 12, tasks: true, records: true, operate: true };

const roster = {
    [OWNER]: { email: OWNER, tier: "owner" } satisfies Caller,
    [ADA]: { email: ADA, tier: "collaborator", agents: "run" } satisfies Caller,
};
const callerOf = (email: string): Caller | undefined => Object.values(roster).find((caller) => caller.email === email.toLowerCase());

// The taking sandbox: its link doors and link store, its pairings, both upgrade doors, and its contacts' task book with
// the kinds and the status push the daemon starts at boot.
interface Taker {
    readonly made: S2sDaemon;
    // How far ahead of the wall clock the taking side's doors read the time: a repeat's window passed by moving it.
    readonly clock: { skew: number };
    readonly links: InboundLinks;
    readonly book: ContactTasksStore;
    readonly pairings: PairingsStore;
    // The task code over the contacts' book: what a turn's end moves once a task is a contact's.
    readonly contactTasks: LinkTaskDeps;
    readonly said: Said[];
    readonly stop: () => void;
}

const taker = async (): Promise<Taker> => {
    const dir = mkdtempSync(join(tmpdir(), "b-upgrade-"));
    const links = fileInboundLinks(join(dir, inboundLinksDocument.path));
    const book = fileContactTasks(join(dir, contactTasksDocument.path));
    const personTasks = filePersonTasks(join(dir, personTasksDocument.path));
    const pairings = filePairingsStore(dir);
    const said: Said[] = [];
    const clock = { skew: 0 };
    const now = (): number => Date.now() + clock.skew;
    const { conversations } = memoryFleet();
    const starts = memoryStartWindow();
    const turns = {
        say: async (words: Said) => {
            said.push(words);
            return { delivered: "started" as const, run: `run-${said.length}` };
        },
        reply: async () => "settled" as const,
        stop: async () => ({ stopped: true }),
    };
    const doors = createLinkRoutes({ links, turns, conversations, starts, notify: () => undefined, logger: quiet, auth: undefined, sandboxName: () => "b", roles: async () => [] });
    const admit = createRouteAdmission({ identityKey: async () => publicKey, self: B_ID, roster: async () => ({ callerOf }), pairings: () => pairings, now });
    const made = await s2sDaemon("b", {
        roster,
        sandbox: B_ID,
        routes: (s2s) => ({
            "GET /link": doors.hello,
            "POST /link/conversations": doors.ask,
            "GET /link/conversations/{id}": doors.status,
            "POST /link/conversations/{id}/stop": doors.stop,
            "POST /link/upgrade": linkUpgradeRoute({ core: s2s.core, links, book, logger: quiet, now }),
            "POST /account/pairings/upgrade": pairingUpgradeRoute({ core: s2s.core, pairings, now }, admit),
        }),
    });
    const contactTasks: LinkTaskDeps = { links: contactTaskBook(book, made.s2s.contacts), turns, conversations, starts, notify: () => undefined, logger: quiet };
    const person: PersonTaskDeps = { tasks: personTasks, turns, conversations, starts, personOf: async (email) => callerOf(email), logger: quiet };
    const pusher = createTaskPusher({
        contacts: made.s2s.contacts,
        book,
        personTasks,
        status: (row, task) => contactStatusOf({ link: contactTasks, person }, row, task),
        outbox: made.s2s.outbox,
        now: Date.now,
        logger: quiet,
    });
    const stops = [registerTakingKinds(made.s2s.kinds, { link: contactTasks, person, hear: made.s2s.hear, push: pusher.push }), onLinkTaskStatusNudge(pusher.nudge), pusher.start()];
    return { made, clock, links, book, pairings, contactTasks, said, stop: () => stops.forEach((stop) => stop()) };
};

// The asking sandbox: one link card to b, its linked children over the real link wire and over contacts, and what it
// would wake its parent with.
interface Asker {
    readonly made: S2sDaemon;
    readonly linked: LinkedChildren;
    readonly wakes: Said[];
    readonly roster: () => ReturnType<typeof listSubagentSessions>;
    cards: Capability[];
    readonly upgrade: (card: Capability & { readonly kind: "link" }) => Promise<UpgradeOutcome>;
}

const asker = async (): Promise<Asker> => {
    const made = await s2sDaemon("a", { roster, sandbox: A_ID });
    const { conversations } = memoryFleet();
    const wakes: Said[] = [];
    const askers: AskerDeps = { peopleOf: () => [], ownerEmail: async () => OWNER, tierOf: async (email) => callerOf(email)?.tier };
    const sends = contactSendsOf({ contacts: () => made.s2s.contacts, outbox: () => made.s2s.outbox, askers: () => askers });
    const side: Asker = {
        made,
        wakes,
        cards: [],
        roster: () => listSubagentSessions(conversations),
        linked: createLinkedChildren({
            capabilities: async () => side.cards,
            conversations,
            standingOf: () => undefined,
            entryOf: (id) => (id.endsWith("parent-1") ? { title: "Release check" } : undefined),
            profileOf: () => PROFILE,
            inboundHops: async () => undefined,
            doors: {
                turns: {
                    say: async (words) => {
                        wakes.push(words);
                        return { delivered: "started", run: "run-wake" };
                    },
                },
            },
            logger: quiet,
            historyPath: join(made.root, "history", linkedChildrenDocument.path),
            contacts: sends,
        }),
        upgrade: (card) =>
            upgradeLinkCard(
                {
                    core: made.s2s.core,
                    capabilities: {
                        remove: async (id) => {
                            side.cards = side.cards.filter((held) => held.id !== id);
                            return true;
                        },
                    },
                    children: side.linked,
                    fetch: async (url, init) => fetch(url, init),
                    logger: quiet,
                },
                card,
            ),
    };
    registerAskingKinds(made.s2s.kinds, made.s2s.outbox, sends, side.linked);
    return side;
};

let open: { readonly close: () => Promise<void> }[] = [];
afterEach(async () => {
    await Promise.all(open.map((each) => each.close()));
    open = [];
});

const both = async (): Promise<{ readonly a: Asker; readonly b: Taker }> => {
    const b = await taker();
    const a = await asker();
    open.push({
        close: async () => {
            b.stop();
            a.linked.close();
            await Promise.all([a.made.close(), b.made.close()]);
        },
    });
    return { a, b };
};

// b's owner mints a link for a (named as the sandbox it was paired with, when `from` says), and a keeps it on a card "b".
const linkCard = async (a: Asker, b: Taker, url = `http://${b.made.host}`, from?: LinkPeer): Promise<Capability & { readonly kind: "link" }> => {
    const minted = await b.links.mint("a", { terms: TERMS, from });
    const config: LinkConfig = { url, token: minted.token, name: "b" };
    const card = { id: "b", kind: "link" as const, config };
    a.cards = [card];
    return card;
};

// The one contact a side holds: an upgrade files exactly one.
const theContact = async (side: { readonly made: S2sDaemon }): Promise<ContactRow> => {
    const rows = await side.made.s2s.contacts.list();
    const [row] = rows;
    if (row === undefined || rows.length !== 1) {
        throw new Error(`${side.made.name} holds ${rows.length} contacts, not one`);
    }
    return row;
};

// A request to b under a link token, JSON both ways.
const underToken = (b: Taker, token: string, method: string, path: string, body?: object) => b.made.http(undefined, method, path, body, { [LINK_HEADER]: token });

const settled = (conversationId: string, closing: string) => ({ conversationId, run: "run-x", actor: undefined, speaker: undefined, failure: undefined, closing });

test("a link with records, operate and tasks becomes a contact holding them; its token stops working; a task in flight still reports to the asker", async () => {
    const { a, b } = await both();
    const card = await linkCard(a, b);
    const delegated = await a.linked.delegate(PARENT, { to: "b", task: "What is the p99 on the checkout API?", description: "p99" });
    if (!delegated.ok) {
        throw new Error(delegated.message);
    }
    await until("b starts the task over the link", () => b.said.length === 1);
    const remote = b.said[0]?.turn.conversationId ?? "";
    await until("a follows it running", () => a.roster()[0]?.status === "running");

    expect(await a.upgrade(card)).toEqual({ kind: "upgraded", contact: expect.any(String) });

    // Each side holds the other as an accepted sandbox-scoped contact made by the upgrade: b gives a the link's terms
    // under their own names, a gives b messages and wakes, so a task's report wakes it.
    const atA = await theContact(a);
    const atB = await theContact(b);
    expect(atA).toMatchObject({ name: "b", scope: { kind: "sandbox" }, state: "accepted", origin: "link-upgrade", grants: LINK_ASKER_GRANTS, theirGrants: grantsOfTerms(TERMS) });
    expect(atB).toMatchObject({ name: "a", scope: { kind: "sandbox" }, state: "accepted", origin: "link-upgrade", grants: grantsOfTerms(TERMS), theirGrants: LINK_ASKER_GRANTS });
    expect(atB.grants).toEqual(
        S2sGrantsSchema.parse({ message: true, task: { approve: false, turnsPerHour: 12 }, records: true, operate: true, wake: true }),
    );
    expect([atA.document.fingerprint, atB.document.fingerprint]).toEqual([(await b.made.identity().document()).fingerprint, (await a.made.identity().document()).fingerprint]);
    // Each holds the other's wake secret.
    expect([await a.made.s2s.secrets.theirs(atA.id), await b.made.s2s.secrets.theirs(atB.id)]).toEqual([expect.any(String), expect.any(String)]);

    // The card is retired here; over there the link's record stays, marked with the contact it became, and its token
    // opens no door.
    expect(a.cards).toEqual([]);
    expect((await b.links.list())[0]?.upgraded).toEqual({ contact: atB.id, at: expect.any(Number) });
    expect((await b.links.resolveUpgraded(card.config.token))?.upgraded).toEqual({ contact: atB.id, at: expect.any(Number), fingerprint: atB.document.fingerprint });
    expect((await underToken(b, card.config.token, "GET", "/link")).status).toBe(401);
    expect((await underToken(b, card.config.token, "GET", `/link/conversations/${remote}`)).status).toBe(401);

    // The task the link opened is the contact's now, on both sides.
    expect(await b.book.task(atB.id, { conversationId: remote })).toMatchObject({ requestId: delegated.id, state: "running" });
    expect(a.roster()[0]).toMatchObject({ id: delegated.id, status: "running", linked: { link: `contact:${atA.id}`, contact: atA.id } });

    // Its turn over there ends: the report is pushed as a contact's status, settling the child and waking the parent.
    await noteLinkTurnSettled({ links: b.contactTasks.links, logger: quiet }, settled(remote, "p99 is 210ms."));
    await until("the child settles from the pushed report", () => a.roster()[0]?.status === "completed", PUSHED_MS);
    expect(a.linked.report(delegated.id)).toBe("p99 is 210ms.");
    await until("the parent is woken with the report", () => a.wakes.length === 1);
    expect(a.wakes[0]?.turn.prompt).toContain("p99 is 210ms.");
    // A hang bound, not a latency: the report waits out a status push's five seconds (PUSHED_MS) behind a long poll.
}, 60_000);

test("a link upgraded twice answers the same contact on both sides, and files nothing new", async () => {
    const { a, b } = await both();
    const card = await linkCard(a, b);
    const first = await a.upgrade(card);
    expect(first.kind).toBe("upgraded");

    // The asking side asks again under the same token (it never heard the first answer): the same contact, the link's
    // token still refused at every other door.
    const document = await a.made.identity().document();
    const again = await underToken(b, card.config.token, "POST", "/link/upgrade", { document, grants: LINK_ASKER_GRANTS, wake: "w".repeat(43) });
    expect(again.status).toBe(200);
    expect(S2sUpgradeAnswerSchema.parse(again.body)).toMatchObject({ contact: (await theContact(b)).id, grants: grantsOfTerms(TERMS) });
    expect((await underToken(b, card.config.token, "GET", "/link")).status).toBe(401);

    // And the whole asking side again, the card put back: the same contact here too.
    a.cards = [card];
    expect(await a.upgrade(card)).toEqual(first);
    expect([(await a.made.s2s.contacts.list()).length, (await b.made.s2s.contacts.list()).length]).toEqual([1, 1]);
});

// Past the fifteen minutes a retired credential reads its upgrade's answer again for.
const PAST_REPEAT_MS = 16 * 60 * 1000;

test("a retired link token only reads its answer again, for the same key and fifteen minutes, changing nothing; then it opens no door", async () => {
    const { a, b } = await both();
    const card = await linkCard(a, b);
    expect((await a.upgrade(card)).kind).toBe("upgraded");
    const atB = await theContact(b);
    // b's owner takes operating back since: a repeat must not hand it out again.
    expect((await b.made.http(OWNER, "POST", `/s2s/contacts/${atB.id}`, { grants: { operate: false } })).status).toBe(200);
    const asking = async (document: object) => underToken(b, card.config.token, "POST", "/link/upgrade", { document, grants: LINK_ASKER_GRANTS });
    const document = await a.made.identity().document();

    const again = await asking(document);
    expect(again.status).toBe(200);
    expect(S2sUpgradeAnswerSchema.parse(again.body)).toMatchObject({ contact: atB.id, grants: { operate: false, records: true } });
    expect((await theContact(b)).grants.operate).toBe(false);

    // Anyone else's identity under the retired token files nothing.
    const other = signIdentity({ sandbox: "cccccccccccc", name: "c", host: a.made.host, domains: [], issuedAt: Date.now() }, keySetFor("c"));
    expect(await asking(other)).toEqual({
        status: 409,
        body: { error: "this credential was already upgraded into a contact for another key: pair the two sandboxes again", code: "not_contact" },
    });
    expect((await b.made.s2s.contacts.list()).map((row) => row.id)).toEqual([atB.id]);

    // The contact removed: the token brings it back no more.
    expect((await b.made.http(OWNER, "DELETE", `/s2s/contacts/${atB.id}`)).status).toBe(200);
    expect((await asking(document)).status).toBe(409);
    expect(await b.made.s2s.contacts.list()).toEqual([]);

    // Past the window, the upgrade door refuses it as every other does.
    b.clock.skew = PAST_REPEAT_MS;
    expect((await asking(document)).status).toBe(401);
    expect(await b.made.s2s.contacts.list()).toEqual([]);
});

test("a link minted for one sandbox upgrades into that sandbox only, which the contact records as vouched for", async () => {
    const { a, b } = await both();
    const card = await linkCard(a, b, `http://${b.made.host}`, { sandboxId: A_ID, url: `http://${a.made.host}` });
    const other = signIdentity({ sandbox: "cccccccccccc", name: "c", host: a.made.host, domains: [], issuedAt: Date.now() }, keySetFor("c"));
    expect(await underToken(b, card.config.token, "POST", "/link/upgrade", { document: other, grants: LINK_ASKER_GRANTS })).toEqual({
        status: 403,
        body: { error: `that identity is cccccccccccc, not ${A_ID}, the sandbox this link was minted for`, code: "unconfirmed" },
    });
    expect(await b.made.s2s.contacts.list()).toEqual([]);
    expect((await b.links.list())[0]?.upgraded).toBeUndefined();

    expect((await a.upgrade(card)).kind).toBe("upgraded");
    expect(await theContact(b)).toMatchObject({ vouchedSandbox: A_ID, document: { sandbox: A_ID } });
});

// a holds ada's route pairing into b: the secret she minted there, and the platform's read pass naming her.
const routePairing = async (a: Asker, b: Taker): Promise<{ readonly secrets: RouteSecretsStore; readonly secret: string; readonly locate: () => Promise<RouteAnswer> }> => {
    const secrets = fileRouteSecrets(join(a.made.root, "auth", routeSecretsDocument.path));
    const { secret } = await b.pairings.mint({ from: A_ID, fromName: "a", person: ADA }, Date.now());
    await secrets.put(B_ID, ADA, secret, Date.now());
    const locate = async (): Promise<RouteAnswer> => ({
        ok: true,
        value: {
            sandboxId: B_ID,
            name: "b",
            address: `http://${b.made.host}`,
            pass: mintSandboxPass(privateKey, { from: A_ID, fromName: "a", to: B_ID, scope: "read", person: ADA, issuedAtMs: Date.now() }),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
    });
    return { secrets, secret, locate };
};

test("a route pairing becomes the person's contact on both sides, its secret gone; asked twice it answers the same contact", async () => {
    const { a, b } = await both();
    const { secrets, secret, locate } = await routePairing(a, b);
    const upgradeDeps = { core: a.made.s2s.core, secrets, locate, fetch: async (url: string, init: RequestInit) => fetch(url, init), logger: quiet };

    expect(await upgradeRoutePairing(upgradeDeps, { target: B_ID, person: ADA })).toEqual({ kind: "upgraded", contact: expect.any(String) });

    const atA = await theContact(a);
    const atB = await theContact(b);
    expect(atA).toMatchObject({ scope: { kind: "person", person: ADA }, state: "accepted", origin: "pairing-upgrade", grants: ROUTE_ASKER_GRANTS, theirGrants: PERSON_ROUTE_GRANTS });
    expect(atB).toMatchObject({ scope: { kind: "person", person: ADA }, state: "accepted", origin: "pairing-upgrade", grants: PERSON_ROUTE_GRANTS, theirGrants: ROUTE_ASKER_GRANTS });
    // A person's route never operates a sandbox.
    expect(atB.grants.operate).toBe(false);

    // The secret is gone here, and over there the pairing admits nothing and is listed nowhere.
    expect([await secrets.secretFor(B_ID, ADA), await secrets.list()]).toEqual([undefined, []]);
    expect([await b.pairings.verify(A_ID, ADA, secret), await b.pairings.list()]).toEqual([false, []]);

    // Asked again under the same pass and secret (the answer was lost): the same contact, nothing new filed.
    const pass = mintSandboxPass(privateKey, { from: A_ID, fromName: "a", to: B_ID, scope: "read", person: ADA, issuedAtMs: Date.now() });
    const again = await b.made.http(
        undefined,
        "POST",
        "/account/pairings/upgrade",
        { document: await a.made.identity().document(), grants: ROUTE_ASKER_GRANTS },
        { [SANDBOX_PASS_HEADER]: pass, [ROUTE_SECRET_HEADER]: secret },
    );
    expect([again.status, S2sUpgradeAnswerSchema.parse(again.body).contact]).toEqual([200, atB.id]);
    await secrets.put(B_ID, ADA, secret, Date.now());
    expect(await upgradeRoutePairing(upgradeDeps, { target: B_ID, person: ADA })).toEqual({ kind: "upgraded", contact: atA.id });
    expect([(await a.made.s2s.contacts.list()).length, (await b.made.s2s.contacts.list()).length, await secrets.secretFor(B_ID, ADA)]).toEqual([1, 1, undefined]);

    // A send as ada into b raises no route card now: it is told to go over her contact (needs would throw if asked).
    const services = {
        config: unstubbed<Services["config"]>("config", { agentAuthDir: join(a.made.root, "auth") }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: a.made.root }),
        needs: unstubbed<Services["needs"]>("needs", {}),
        s2s: a.made.s2s,
    };
    const target = { sandboxId: B_ID, name: "b", address: `http://${b.made.host}`, pass: "", expiresAt: "" };
    const pairing = await requirePairing(services, { conversationId: "ada-1", target, person: ADA, scopes: ["drop"] });
    expect(pairing).toEqual({ contact: atA.id, refused: expect.stringContaining("through a contact of their own here") });
});

test("a far daemon that does not speak s2s/1 is left on the old path: its card, token and route secret untouched", async () => {
    const { a, b } = await both();
    // b as a build from before contacts: its own identity door answers the bare "unauthorized" of a route it does not know.
    a.made.intercept = (url) => (url.endsWith("/s2s/identity") ? Response.json({ error: "unauthorized" }, { status: 401 }) : undefined);
    const card = await linkCard(a, b);
    expect(await a.upgrade(card)).toEqual({ kind: "old", why: expect.any(String) });
    expect(a.cards).toEqual([card]);
    expect((await underToken(b, card.config.token, "GET", "/link")).status).toBe(200);
    expect((await b.links.list())[0]?.upgraded).toBeUndefined();

    const { secrets, secret, locate } = await routePairing(a, b);
    const outcome = await upgradeRoutePairing({ core: a.made.s2s.core, secrets, locate, fetch: async (url, init) => fetch(url, init), logger: quiet }, { target: B_ID, person: ADA });
    expect(outcome.kind).toBe("old");
    expect([await secrets.secretFor(B_ID, ADA), await b.pairings.verify(A_ID, ADA, secret)]).toEqual([secret, true]);
    expect([(await a.made.s2s.contacts.list()).length, (await b.made.s2s.contacts.list()).length]).toEqual([0, 0]);
    // Nothing was posted to either upgrade door.
    expect(a.made.sent.filter((url) => url.includes("/upgrade"))).toEqual([]);
});

test("a retired route pairing only reads its answer again for fifteen minutes, changing nothing; then its secret opens nothing", async () => {
    const { a, b } = await both();
    const { secrets, secret, locate } = await routePairing(a, b);
    const upgradeDeps = { core: a.made.s2s.core, secrets, locate, fetch: async (url: string, init: RequestInit) => fetch(url, init), logger: quiet };
    expect((await upgradeRoutePairing(upgradeDeps, { target: B_ID, person: ADA })).kind).toBe("upgraded");
    const atB = await theContact(b);
    expect(atB.vouchedSandbox).toBe(A_ID);
    expect((await theContact(a)).vouchedSandbox).toBe(B_ID);
    // Ada takes records back on her own contact there.
    expect((await b.made.http(ADA, "POST", `/s2s/contacts/${atB.id}`, { grants: { records: false } })).status).toBe(200);

    const repeat = async () =>
        b.made.http(
            undefined,
            "POST",
            "/account/pairings/upgrade",
            { document: await a.made.identity().document(), grants: ROUTE_ASKER_GRANTS },
            {
                [SANDBOX_PASS_HEADER]: mintSandboxPass(privateKey, { from: A_ID, fromName: "a", to: B_ID, scope: "read", person: ADA, issuedAtMs: Date.now() + b.clock.skew }),
                [ROUTE_SECRET_HEADER]: secret,
            },
        );
    const again = await repeat();
    expect([again.status, S2sUpgradeAnswerSchema.parse(again.body).grants.records]).toEqual([200, false]);
    expect((await theContact(b)).grants.records).toBe(false);

    b.clock.skew = PAST_REPEAT_MS;
    expect((await repeat()).status).toBe(403);
    expect(await b.pairings.verify(A_ID, ADA, secret, { upgraded: Date.now() + b.clock.skew })).toBe(false);
});
