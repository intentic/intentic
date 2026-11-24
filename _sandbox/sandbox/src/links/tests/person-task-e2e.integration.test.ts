import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import { mintSandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { createRouteAdmission } from "../../account-routing/admit-route.js";
import { filePairingsStore, type PairingsStore } from "../../account-routing/pairings-store.js";
import type { RouteTarget } from "../../account-routing/route-client.js";
import { listSubagentSessions } from "../../agent/subagents/subagents.js";
import type { Caller } from "../../auth/auth.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import type { Said } from "../../seams/turn-starter.js";
import { memoryStartWindow } from "../../store/start-window.testing.js";
import { linkAnswer, linkAsk, linkHello, linkMessage, linkStatus, linkStop } from "../../sandboxes/link-client.js";
import { createLinkedChildren, type LinkedChildren, type LinkWire } from "../linked-children.js";
import { linkedChildrenDocument } from "../linked-children-store.js";
import type { PersonRoutes } from "../linked-destinations.js";
import { createPersonTaskRoutes } from "../person-task.routes.js";
import { notePersonTurnSettled, startUnstartedPersonTasks } from "../person-tasks.js";
import { filePersonTasks, type PersonTasksStore, personTasksDocument } from "../person-tasks-store.js";

// TWO SANDBOXES, ONE PERSON, NO LINK, OVER HTTP: the asking side's real follower and wire against the taking side's real
// `/account/task` doors and admission, served on a port. The platform is the suite's: it signs task passes with a key
// the taking side trusts. What is proven: the pairing card before anything goes, the task running as the person (their
// owner, their fence, drawn as the asking sandbox's words), its report coming back, the floor, a revoked pairing, hops
// counted across links and person routes alike, and a restart between filing and asking.

const quiet = { info: () => undefined, warn: () => undefined };
const PROFILE: TurnProfile = { agent: "claude", model: "claude-opus-5-5" };
const PARENT = { conversationId: "brave-parent-1", cwd: WORKSPACE_ROOT };
const DEV = "dddddddddddd";
const OPS = "aaaaaaaaaaaa";
const ADA = "ada@acme.test";

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ROSTER = {
    [ADA]: { email: ADA, name: "Ada", tier: "collaborator", agents: "run", areas: ["web"] },
    "gus@acme.test": { email: "gus@acme.test", tier: "guest", agents: "chat" },
} as const satisfies Readonly<Record<string, Caller>>;
const onRoster = (email: string): Caller | undefined => Object.entries(ROSTER).find(([held]) => held === email.toLowerCase())?.[1];

interface Ops {
    readonly url: string;
    readonly tasks: PersonTasksStore;
    readonly pairings: PairingsStore;
    readonly said: Said[];
    readonly server: ServerType;
}

// The taking sandbox: its admission, its pairings, its task book and doors on a port, and a turn port recording turns.
const opsSandbox = async (): Promise<Ops> => {
    const history = mkdtempSync(join(tmpdir(), "ops-"));
    const tasks = filePersonTasks(join(history, personTasksDocument.path));
    const pairings = filePairingsStore(history);
    const said: Said[] = [];
    const routes = createPersonTaskRoutes({
        tasks,
        conversations: memoryFleet().conversations,
        starts: memoryStartWindow(),
        personOf: async (email) => onRoster(email),
        logger: quiet,
        turns: {
            say: async (words) => {
                said.push(words);
                return { delivered: "started", run: `run-${said.length}` };
            },
            reply: async () => "settled",
            stop: async () => ({ stopped: true }),
        },
        admit: createRouteAdmission({
            identityKey: async () => publicKey,
            self: OPS,
            roster: async () => ({ callerOf: (email) => onRoster(email) }),
            pairings: () => pairings,
        }),
    });
    const app = new Hono<AppEnv>();
    app.post("/account/task", routes.ask);
    app.get("/account/task/:id", routes.status);
    app.post("/account/task/:id/messages", routes.message);
    app.post("/account/task/:id/answer", routes.answer);
    app.post("/account/task/:id/stop", routes.stop);
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    // SAFETY: a server listening on a TCP host and port answers its address as AddressInfo, never as a pipe's name.
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, tasks, pairings, said, server };
};

interface Dev {
    readonly linked: LinkedChildren;
    readonly roster: () => ReturnType<typeof listSubagentSessions>;
    readonly cards: string[];
    readonly secrets: Map<string, string>;
}

// The asking sandbox: no link card at all, the person routes standing in for the platform and the secret store.
const devSandbox = (
    ops: Ops,
    options: { readonly person?: string; readonly history?: string; readonly ask?: LinkWire["ask"]; readonly hops?: number; readonly secrets?: Map<string, string> } = {},
): Dev => {
    const { conversations } = memoryFleet();
    const cards: string[] = [];
    const secrets = options.secrets ?? new Map<string, string>();
    const person = options.person ?? ADA;
    const route = (): RouteTarget => ({
        sandboxId: OPS,
        name: "ops",
        address: ops.url,
        pass: mintSandboxPass(privateKey, { from: DEV, fromName: "dev", to: OPS, scope: "task", person, issuedAtMs: Date.now() }),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const personRoutes: PersonRoutes = {
        personOf: async () => ({ person }),
        routeTo: async (_person, sandbox) => (sandbox === "ops" || sandbox === OPS ? { ok: true, value: route() } : { ok: false, status: 404, message: "no such sandbox" }),
        pairing: async (conversationId, target, who) => {
            const secret = secrets.get(`${target.sandboxId}:${who}`);
            if (secret !== undefined) {
                return { secret };
            }
            cards.push(conversationId);
            return { asked: `${who} has not allowed this sandbox to act as them in ${target.name}: a card asks them now.`, needId: `need-${cards.length}` };
        },
        secretFor: async (sandboxId, who) => secrets.get(`${sandboxId}:${who}`),
        forget: async (sandboxId, who) => {
            secrets.delete(`${sandboxId}:${who}`);
        },
    };
    const linked = createLinkedChildren({
        capabilities: async () => [],
        conversations,
        standingOf: () => undefined,
        entryOf: (conversationId) => (conversationId.startsWith("brave-parent") || conversationId.startsWith("route-") || conversationId.startsWith("link-") ? { title: "Release check" } : undefined),
        profileOf: () => PROFILE,
        inboundHops: async () => options.hops,
        doors: { turns: { say: async () => ({ delivered: "started", run: "run-wake" }) } },
        logger: quiet,
        historyPath: join(options.history ?? mkdtempSync(join(tmpdir(), "dev-")), linkedChildrenDocument.path),
        wire: { hello: linkHello, ask: options.ask ?? linkAsk, status: linkStatus, message: linkMessage, answer: linkAnswer, stop: linkStop },
        personRoutes,
    });
    return { linked, roster: () => listSubagentSessions(conversations), cards, secrets };
};

// The person's press on the card: minted over there, kept here.
const allow = async (ops: Ops, dev: Dev, person = ADA): Promise<void> => {
    const { secret } = await ops.pairings.mint({ from: DEV, fromName: "dev", person }, Date.now());
    dev.secrets.set(`${OPS}:${person}`, secret);
};

const until = async (what: string, check: () => boolean, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`never: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

let ops: Ops;
let dev: Dev | undefined;

beforeEach(async () => {
    ops = await opsSandbox();
});

afterEach(async () => {
    dev?.linked.close();
    dev = undefined;
    await new Promise((resolve) => ops.server.close(resolve));
});

test("with no pairing, a hand-over raises the person's card and sends nothing", async () => {
    dev = devSandbox(ops);
    const handed = await dev.linked.delegate(PARENT, { to: "ops", via: "person", task: "Check the build." });
    expect(handed).toEqual({ ok: false, message: `${ADA} has not allowed this sandbox to act as them in ops: a card asks them now.`, open: "need-1" });
    expect(dev.cards).toEqual([PARENT.conversationId]);
    expect(ops.said).toHaveLength(0);
    expect(dev.roster()).toEqual([]);
});

test("paired, the task runs there as the person, and its report comes back to the parent", async () => {
    dev = devSandbox(ops);
    await allow(ops, dev);
    const handed = await dev.linked.delegate(PARENT, { to: "ops", via: "person", task: "What is the p99 on the checkout API?", description: "p99 check" });
    if (!handed.ok) {
        throw new Error(handed.message);
    }
    expect(handed.note).toContain(`for ${ADA}, who reads it there`);
    expect(ops.said).toHaveLength(1);
    const said = ops.said[0];
    const remote = said?.turn.conversationId ?? "";
    expect(remote.startsWith("route-")).toBe(true);
    // The person's: their owner row, their fence, held for a maintainer since a collaborator does not land, and drawn
    // as the asking sandbox's words.
    expect(said?.turn).toMatchObject({
        owner: { email: ADA, name: "Ada" },
        areas: ["web"],
        unattended: true,
        isolated: true,
        conversationAutoLand: false,
        speaker: { kind: "program", token: `dev for ${ADA}` },
    });
    expect(said?.turn.runAs).toBeUndefined();
    expect(said?.voice).toBe("agent");
    expect(said?.outside).toBe(`the sandbox "dev", acting for ${ADA}`);
    expect(dev.roster()).toEqual([
        expect.objectContaining({
            id: handed.id,
            kind: "linked",
            status: "running",
            linked: { link: `route:${OPS}`, sandbox: "ops", sandboxId: OPS, conversationId: remote, via: "person" },
        }),
    ]);

    await notePersonTurnSettled({ tasks: ops.tasks }, { conversationId: remote, run: "run-1", actor: undefined, speaker: undefined, failure: undefined, closing: "p99 is 210ms." });
    await until("the child settles", () => dev?.roster()[0]?.status === "completed");
    expect(dev.linked.report(handed.id)).toBe("p99 is 210ms.");

    // A follow-up reaches the same conversation, still as the person.
    expect(await dev.linked.send(PARENT, handed.id, "And the p50?")).toMatchObject({ ok: true });
    expect(ops.said[1]?.turn).toMatchObject({ conversationId: remote, owner: { email: ADA } });
});

test("a person below the task floor there is refused, and nothing runs", async () => {
    dev = devSandbox(ops, { person: "gus@acme.test" });
    await allow(ops, dev, "gus@acme.test");
    const handed = await dev.linked.delegate(PARENT, { to: "ops", via: "person", task: "Check the build." });
    expect(handed).toMatchObject({ ok: false, message: expect.stringContaining("gus@acme.test may not task here: not open to a guest member") });
    expect(ops.said).toHaveLength(0);
});

test("a pairing the person took back stops the next start, and the secret here goes so the card can ask again", async () => {
    dev = devSandbox(ops);
    await allow(ops, dev);
    expect(await dev.linked.delegate(PARENT, { to: "ops", via: "person", task: "First." })).toMatchObject({ ok: true });
    expect(await ops.pairings.revoke(DEV, ADA)).toBe(true);
    const refused = await dev.linked.delegate(PARENT, { to: "ops", via: "person", task: "Second." });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining(`${ADA} has not allowed dev to task here as them, or took it back`) });
    expect(ops.said).toHaveLength(1);
    expect(dev.secrets.size).toBe(0);
    expect(await dev.linked.delegate(PARENT, { to: "ops", via: "person", task: "Third." })).toMatchObject({ ok: false, open: "need-1" });
});

test("hops count across links and person routes: work routed in as a person is handed on once more at most", async () => {
    // Asking side: a family opened here as a person, itself one hop in, may not hand on again.
    dev = devSandbox(ops, { hops: 1 });
    await allow(ops, dev);
    const deep = await dev.linked.delegate({ conversationId: "route-came-in", cwd: WORKSPACE_ROOT }, { to: "ops", via: "person", task: "Pass it on." });
    expect(deep).toMatchObject({ ok: false, message: expect.stringContaining("never handed on past 2") });
    // Through a link the same: a link task's family counts the same way.
    const viaLink = await dev.linked.delegate({ conversationId: "link-came-in", cwd: WORKSPACE_ROOT }, { to: "ops", via: "person", task: "Pass it on." });
    expect(viaLink).toMatchObject({ ok: false, message: expect.stringContaining("never handed on past 2") });
    expect(ops.said).toHaveLength(0);
    // Taking side: an ask that already crossed as many as allowed is refused before anything is filed.
    const pass = mintSandboxPass(privateKey, { from: DEV, fromName: "dev", to: OPS, scope: "task", person: ADA, issuedAtMs: Date.now() });
    const secret = dev.secrets.get(`${OPS}:${ADA}`) ?? "";
    const target = { id: `route:${OPS}`, config: { url: ops.url, token: "" }, pass, secret, doors: "account" as const };
    expect(await linkAsk(target, { requestId: "linked-x", task: "Round again.", hops: 2 })).toMatchObject({ ok: false, status: 409 });
    expect(ops.said).toHaveLength(0);
});

const died = (): never => {
    throw new Error("the daemon stopped");
};

test("a restart between filing and asking neither orphans nor duplicates the task", async () => {
    const history = mkdtempSync(join(tmpdir(), "dev-"));
    const secrets = new Map<string, string>();
    // The ask reaches the far side, and the daemon dies before its answer is filed here.
    const before = devSandbox(ops, {
        history,
        secrets,
        ask: async (target, task) => {
            await linkAsk(target, task);
            return died();
        },
    });
    await allow(ops, before);
    await expect(before.linked.delegate(PARENT, { to: "ops", via: "person", task: "Count the open incidents." })).rejects.toThrow("the daemon stopped");
    before.linked.close();
    expect(ops.said).toHaveLength(1);

    dev = devSandbox(ops, { history, secrets });
    await dev.linked.resume();
    await until("the task is followed again", () => dev?.roster()[0]?.status === "running");
    expect(ops.said).toHaveLength(1);
    expect(dev.roster()[0]?.linked).toMatchObject({ conversationId: ops.said[0]?.turn.conversationId, via: "person" });
});

test("a task filed over there but never started before its restart starts at boot, once, as the person", async () => {
    const filed = await ops.tasks.addTask(
        { from: DEV, fromName: "dev", person: ADA },
        { requestId: "linked-boot", conversationId: "route-otter-kmpq", task: "Count them.", hops: 0, held: false },
    );
    const said: Said[] = [];
    const deps = {
        tasks: ops.tasks,
        conversations: memoryFleet().conversations,
        starts: memoryStartWindow(),
        personOf: async (email: string) => onRoster(email),
        logger: quiet,
        turns: {
            say: async (words: Said) => {
                said.push(words);
                return { delivered: "started" as const, run: "run-boot" };
            },
            reply: async () => "settled" as const,
            stop: async () => ({ stopped: true }),
        },
    };
    expect(await startUnstartedPersonTasks(deps)).toBe(1);
    expect(said).toEqual([expect.objectContaining({ turn: expect.objectContaining({ conversationId: filed.conversationId, messageId: "route-linked-boot", owner: { email: ADA, name: "Ada" } }) })]);
    // Started and its words forgotten: a second boot starts nothing.
    expect(await startUnstartedPersonTasks(deps)).toBe(0);
});
