import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { listSubagentSessions } from "../../agent/subagents/subagents.js";
import type { Said } from "../../seams/turn-starter.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { memoryStartWindow } from "../../store/start-window.testing.js";
import { fileInboundLinks, type InboundLinks, inboundLinksDocument } from "../inbound-links.js";
import { createLinkedChildren, type LinkedChildren, type LinkWire } from "../linked-children.js";
import { linkedChildrenDocument } from "../linked-children-store.js";
import { linkAnswer, linkAsk, linkHello, linkMessage, linkStatus, linkStop } from "../../sandboxes/link-client.js";
import { createLinkRoutes } from "../links.routes.js";
import { noteLinkTurnSettled } from "../link-tasks.js";

// TWO SANDBOXES, ONE LINK, OVER HTTP: the asking side's real wire and follower against the taking side's real link
// doors, served on a port. Only the model turns are the suite's: the taking side records each turn it would start, and
// the suite ends it the way the turn engine announces a turn's end. What is proven here is the whole protocol between
// two daemons: the hand-over, the long poll, the report waking the parent, follow-ups, stops and a revoke.

const quiet = { info: () => undefined, warn: () => undefined };
const PROFILE: TurnProfile = { agent: "claude", model: "claude-opus-5-5" };
const PARENT = { conversationId: "brave-parent-1", cwd: WORKSPACE_ROOT };

interface Ops {
    readonly url: string;
    readonly links: InboundLinks;
    readonly said: Said[];
    readonly stopped: string[];
    readonly server: ServerType;
}

// The taking sandbox: its link store, its link doors on a port, and a turn port that records what it would run.
const opsSandbox = async (): Promise<Ops> => {
    const links = fileInboundLinks(join(mkdtempSync(join(tmpdir(), "ops-")), inboundLinksDocument.path));
    const said: Said[] = [];
    const stopped: string[] = [];
    const routes = createLinkRoutes({
        links,
        conversations: memoryFleet().conversations,
        starts: memoryStartWindow(),
        notify: () => undefined,
        logger: quiet,
        auth: undefined,
        sandboxName: () => "ops",
        personas: async () => [{ id: "oncall", label: "On call" }],
        turns: {
            say: async (words) => {
                said.push(words);
                return { delivered: "started", run: `run-${said.length}` };
            },
            reply: async () => "settled",
            stop: async (target) => {
                stopped.push(target.conversationId ?? "");
                return { stopped: true };
            },
        },
    });
    const app = new Hono<AppEnv>();
    app.get("/link", routes.hello);
    app.post("/link/conversations", routes.ask);
    app.get("/link/conversations/:id", routes.status);
    app.post("/link/conversations/:id/messages", routes.message);
    app.post("/link/conversations/:id/answer", routes.answer);
    app.post("/link/conversations/:id/stop", routes.stop);
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    // SAFETY: a server listening on a TCP host and port answers its address as AddressInfo, never as a pipe's name.
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, links, said, stopped, server };
};

interface Dev {
    readonly linked: LinkedChildren;
    readonly wakes: Said[];
    readonly roster: () => ReturnType<typeof listSubagentSessions>;
}

// The asking sandbox: one link card pointing at ops, and a turn port that records what wakes its conversations.
// `restart` puts it on an earlier daemon's history volume, and `ask` stands in for the wire's ask (a daemon that dies
// around handing a task over).
const devSandbox = (
    card: Capability,
    hops?: number,
    restart: { readonly history?: string; readonly ask?: LinkWire["ask"]; readonly status?: LinkWire["status"] } = {},
): Dev => {
    const { conversations } = memoryFleet();
    const wakes: Said[] = [];
    const linked = createLinkedChildren({
        capabilities: async () => [card],
        conversations,
        standingOf: () => undefined,
        entryOf: (conversationId) => (conversationId.startsWith("brave-parent") || conversationId.startsWith("link-") ? { title: "Release check" } : undefined),
        profileOf: () => PROFILE,
        inboundHops: async () => hops,
        doors: {
            turns: {
                say: async (words) => {
                    wakes.push(words);
                    return { delivered: "started", run: "run-wake" };
                },
            },
        },
        logger: quiet,
        historyPath: join(restart.history ?? mkdtempSync(join(tmpdir(), "dev-")), linkedChildrenDocument.path),
        wire: { hello: linkHello, ask: restart.ask ?? linkAsk, status: restart.status ?? linkStatus, message: linkMessage, answer: linkAnswer, stop: linkStop },
    });
    return { linked, wakes, roster: () => listSubagentSessions(conversations) };
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

const cardFor = async (terms: { readonly approve?: boolean } = {}): Promise<Capability> => {
    const minted = await ops.links.mint("dev", { terms: { actsAs: "oncall", ...terms } });
    return { id: "ops", kind: "link", config: { url: ops.url, token: minted.token, name: "ops" } };
};

test("a task handed over runs there, its report comes back as the parent's wake, and a follow-up reopens it", async () => {
    dev = devSandbox(await cardFor());
    const handed = await dev.linked.delegate(PARENT, { to: "ops", task: "What is the p99 on the checkout API?", description: "p99 check" });
    if (!handed.ok) {
        throw new Error(handed.message);
    }
    expect(handed.id.startsWith("linked-")).toBe(true);
    // Over there: one turn, in the link's persona, unattended, marked as outside words.
    expect(ops.said).toHaveLength(1);
    expect(ops.said[0]?.turn).toMatchObject({ actsAs: "oncall", unattended: true, isolated: true });
    const remote = ops.said[0]?.turn.conversationId ?? "";
    // Here: a linked child under its parent, naming where it runs.
    expect(dev.roster()).toEqual([
        expect.objectContaining({
            id: handed.id,
            kind: "linked",
            conversationId: PARENT.conversationId,
            status: "running",
            linked: { link: "ops", sandbox: "ops", conversationId: remote },
        }),
    ]);

    // The turn over there ends; the follower's long poll hears it and the parent is woken with the report.
    await noteLinkTurnSettled({ links: ops.links, logger: quiet }, { conversationId: remote, actor: undefined, speaker: undefined, failure: undefined, closing: "p99 is 210ms." });
    await until("the child settles", () => dev?.roster()[0]?.status === "completed");
    expect(dev.linked.report(handed.id)).toBe("p99 is 210ms.");
    await until("the parent is woken", () => (dev?.wakes.length ?? 0) > 0);
    const wake = dev.wakes[0];
    expect(wake?.turn.conversationId).toBe(PARENT.conversationId);
    expect(wake?.turn.prompt).toContain("p99 is 210ms.");
    expect(wake?.turn.prompt).toContain('Its work stays in the sandbox "ops"');
    expect(wake?.outside).toBe('the report of a task the linked sandbox "ops" ran');

    // A follow-up: a second turn over there, and the record is live again.
    const sent = await dev.linked.send(PARENT, handed.id, "And the p50?");
    expect(sent).toMatchObject({ ok: true });
    expect(ops.said[1]?.turn.prompt).toContain("And the p50?");
    await until("the child is running again", () => dev?.roster()[0]?.status === "running");

    // Stopped from here: stopped over there, and killed here.
    expect(await dev.linked.cancel(PARENT, handed.id)).toMatchObject({ ok: true });
    expect(ops.stopped).toEqual([remote]);
    await until("the child ends killed", () => dev?.roster()[0]?.status === "killed");
});

test("a follower backing off from a far side that stopped answering asks again the moment another call on the link is answered", async () => {
    let down = false;
    const status: LinkWire["status"] = async (...args) =>
        down ? { ok: false, status: 0, message: "it is not online" } : await linkStatus(...args);
    dev = devSandbox(await cardFor(), undefined, { status });
    down = true;
    const handed = await dev.linked.delegate(PARENT, { to: "ops", task: "Count the open incidents." });
    if (!handed.ok) {
        throw new Error(handed.message);
    }
    await until("the follower misses", () => dev?.roster()[0]?.summary?.includes("did not answer") === true);
    const remote = ops.said[0]?.turn.conversationId ?? "";
    await noteLinkTurnSettled({ links: ops.links, logger: quiet }, { conversationId: remote, actor: undefined, speaker: undefined, failure: undefined, closing: "Seven." });
    down = false;
    // The agent listing its links is an answered call on this one: the follower's five-second backoff ends there.
    const started = Date.now();
    expect(await dev.linked.links(PARENT.conversationId)).toEqual([expect.objectContaining({ to: "ops", online: true })]);
    await until("the child settles", () => dev?.roster()[0]?.status === "completed", 4_000);
    expect(Date.now() - started).toBeLessThan(3_000);
});

test("a task the owner over there must allow waits as pending; their yes starts it there", async () => {
    dev = devSandbox(await cardFor({ approve: true }));
    const handed = await dev.linked.delegate(PARENT, { to: "ops", task: "Rotate the staging key." });
    if (!handed.ok) {
        throw new Error(handed.message);
    }
    expect(handed.note).toContain("waits for that sandbox's owner");
    expect(ops.said).toHaveLength(0);
    expect(dev.roster()[0]?.status).toBe("pending");
});

test("a revoked link ends the task here as failed, and the links listing says the sandbox no longer answers", async () => {
    const card = await cardFor();
    dev = devSandbox(card);
    const handed = await dev.linked.delegate(PARENT, { to: "ops", task: "Count the open incidents." });
    if (!handed.ok) {
        throw new Error(handed.message);
    }
    const [link] = await ops.links.list();
    await ops.links.revoke(link?.id ?? "");
    await until("the child fails", () => dev?.roster()[0]?.status === "failed", 40_000);
    expect(dev.roster()[0]?.error).toContain("no longer answers");
    const [listed] = await dev.linked.links(PARENT.conversationId);
    expect(listed).toMatchObject({ to: "ops", online: false, why: expect.stringContaining("revoked") });
}, 60_000);

test("the links listing names each linked sandbox with the terms it holds its tasks to", async () => {
    dev = devSandbox(await cardFor({ approve: true }));
    expect(await dev.linked.links(PARENT.conversationId)).toEqual([
        { to: "ops", sandbox: "ops", online: true, persona: "On call", approve: true, turnsPerHour: 20 },
    ]);
});

test("work that already came over a link is handed on once more at most, and never to a card that is not there", async () => {
    dev = devSandbox(await cardFor(), 1);
    const deep = await dev.linked.delegate({ conversationId: "link-came-in", cwd: WORKSPACE_ROOT }, { to: "ops", task: "Pass it on." });
    expect(deep).toMatchObject({ ok: false, message: expect.stringContaining("never handed on past 2") });
    expect(ops.said).toHaveLength(0);
    expect(await dev.linked.delegate(PARENT, { to: "nowhere", task: "x" })).toMatchObject({ ok: false, message: expect.stringContaining("Linked here: ops") });
});

// A RESTART on the asking side is a second follower on the same history volume, with nothing of the first one's memory.

const died = (): never => {
    throw new Error("the daemon stopped");
};

test("a task filed here but never asked before the daemon stopped is asked at boot, once, and followed", async () => {
    const card = await cardFor();
    const history = mkdtempSync(join(tmpdir(), "dev-"));
    const before = devSandbox(card, undefined, { history, ask: async () => died() });
    await expect(before.linked.delegate(PARENT, { to: "ops", task: "Count the open incidents." })).rejects.toThrow("the daemon stopped");
    before.linked.close();
    expect(ops.said).toHaveLength(0);

    dev = devSandbox(card, undefined, { history });
    await dev.linked.resume();
    await until("the task is followed again", () => dev?.roster()[0]?.status === "running");
    expect(ops.said).toHaveLength(1);
    const [child] = dev.roster();
    expect(child?.linked?.conversationId).toBe(ops.said[0]?.turn.conversationId);
    expect(dev.linked.owns(child?.id ?? "")).toBe(true);
});

test("a task the far side took before the daemon stopped, unfiled here, is not asked twice: the re-ask finds it", async () => {
    const card = await cardFor();
    const history = mkdtempSync(join(tmpdir(), "dev-"));
    // The ask reaches the far side, and the daemon dies before its answer is filed here.
    const before = devSandbox(card, undefined, { history, ask: async (target, task) => {
            await linkAsk(target, task);
            return died();
        },
    });
    await expect(before.linked.delegate(PARENT, { to: "ops", task: "Count the open incidents." })).rejects.toThrow("the daemon stopped");
    before.linked.close();
    expect(ops.said).toHaveLength(1);

    dev = devSandbox(card, undefined, { history });
    await dev.linked.resume();
    await until("the task is followed again", () => dev?.roster()[0]?.status === "running");
    // The same task over there, followed here: one turn, never a second.
    expect(ops.said).toHaveLength(1);
    expect(dev.roster()[0]?.linked?.conversationId).toBe(ops.said[0]?.turn.conversationId);
    await noteLinkTurnSettled({ links: ops.links, logger: quiet }, { conversationId: ops.said[0]?.turn.conversationId ?? "", actor: undefined, speaker: undefined, failure: undefined, closing: "Three." });
    await until("the child settles", () => dev?.roster()[0]?.status === "completed");
});

test("a task that settled before the daemon stopped still hands its report after it", async () => {
    const card = await cardFor();
    const history = mkdtempSync(join(tmpdir(), "dev-"));
    const before = devSandbox(card, undefined, { history });
    const handed = await before.linked.delegate(PARENT, { to: "ops", task: "What is the p99?" });
    if (!handed.ok) {
        throw new Error(handed.message);
    }
    await noteLinkTurnSettled({ links: ops.links, logger: quiet }, { conversationId: ops.said[0]?.turn.conversationId ?? "", actor: undefined, speaker: undefined, failure: undefined, closing: "p99 is 210ms." });
    await until("the child settles", () => before.roster()[0]?.status === "completed");
    before.linked.close();

    dev = devSandbox(card, undefined, { history });
    await dev.linked.resume();
    expect(dev.linked.owns(handed.id)).toBe(true);
    expect(dev.linked.report(handed.id)).toBe("p99 is 210ms.");
    // Settled: nothing is asked or followed again.
    expect(ops.said).toHaveLength(1);
});
