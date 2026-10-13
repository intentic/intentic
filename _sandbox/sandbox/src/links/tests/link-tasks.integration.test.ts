import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_MAX_HOPS, type PushNotification, type TranscriptRow } from "@intentic/sandbox-contract";
import { type LiveRun, RUNS } from "../../conversations/actor/conversation-holdings.js";
import type { Said } from "../../seams/turn-starter.js";
import { memoryFleet } from "../../testing.js";
import { opt } from "../../opt.js";
import { unstubbed } from "@intentic/testing";
import { fileInboundLinks, inboundLinksDocument, type ResolvedLink } from "../inbound-links.js";
import {
    answerTask,
    askTask,
    decideTask,
    type LinkRefusal,
    type LinkTaskDeps,
    messageTask,
    noteLinkTurnSettled,
    statusOf,
    stopTask,
} from "../link-tasks.js";

// The taking side of a link: what a task becomes here, held to the terms this sandbox's owner wrote on the link. The model
// turns are the suite's: every `say` is recorded, and the run a task parks in is held the way the turn engine holds it.

const quiet = { info: () => undefined, warn: () => undefined };

const setup = async (terms: { readonly approve?: boolean; readonly turnsPerHour?: number; readonly actsAs?: string } = {}) => {
    const links = fileInboundLinks(join(mkdtempSync(join(tmpdir(), "link-tasks-")), inboundLinksDocument.path));
    const minted = await links.mint("dev", { terms });
    const resolved = await links.resolve(minted.token);
    if (resolved === undefined) {
        throw new Error("a minted link must resolve");
    }
    const { conversations } = memoryFleet();
    const said: Said[] = [];
    const replies: unknown[] = [];
    const stops: unknown[] = [];
    const notices: PushNotification[] = [];
    const deps: LinkTaskDeps = {
        links,
        conversations,
        notify: (notice) => void notices.push(notice),
        logger: quiet,
        turns: {
            say: async (words) => {
                said.push(words);
                return { delivered: "started", run: `run-${said.length}` };
            },
            reply: async (reply) => {
                replies.push(reply);
                return "settled";
            },
            stop: async (target) => {
                stops.push(target);
                return { stopped: true };
            },
        },
    };
    // A live run of the conversation parked on these rows, as the turn engine holds it.
    const parkIn = (conversationId: string, rows: readonly TranscriptRow[]): void => {
        // statusOf reads a run's `done`, `expired` and `rows`; anything else it reached would throw by name.
        const run = unstubbed<LiveRun>("run", { id: `run-${conversationId}`, rows, done: false, expired: () => false });
        conversations.holdings(RUNS).hold(conversationId, conversationId, run);
    };
    return { deps, link: resolved, links, said, replies, stops, notices, parkIn };
};

const asked = (requestId: string, extra: { readonly hops?: number; readonly tainted?: string } = {}) => ({
    requestId,
    task: `Check the error rate for ${requestId}.`,
    title: `check ${requestId}`,
    hops: extra.hops ?? 0,
    ...opt("tainted", extra.tainted),
});

const ok = <T extends object>(value: T | LinkRefusal): T => {
    if ("refused" in value) {
        throw new Error(`refused: ${value.message}`);
    }
    return value;
};

test("a task starts at once, unattended, isolated, in the link's persona, as a program's words that carry outside content", async () => {
    const { deps, link, said } = await setup({ actsAs: "ops" });
    const status = ok(await askTask(deps, link, asked("r1", { tainted: "a Slack message" })));
    expect(status).toMatchObject({ state: "running", title: "check r1" });
    expect(status.conversationId.startsWith("link-")).toBe(true);
    const [words] = said;
    expect(words?.voice).toBe("agent");
    expect(words?.outside).toBe('the linked sandbox "dev", whose own turn had taken in a Slack message');
    expect(words?.turn).toMatchObject({
        conversationId: status.conversationId,
        unattended: true,
        isolated: true,
        runRole: "linked-task",
        actsAs: "ops",
        speaker: { kind: "program", token: "dev (linked sandbox)" },
    });
    expect(words?.turn.prompt).toContain('Task from the linked sandbox "dev"');
    expect(words?.turn.prompt).toContain("Check the error rate for r1.");
    // Asked again under the same id: the first ask's answer, and nothing said twice.
    expect(ok(await askTask(deps, link, asked("r1"))).conversationId).toBe(status.conversationId);
    expect(said).toHaveLength(1);
});

test("a link whose terms want the owner holds each task, tells the owner, and runs it only on their yes", async () => {
    const { deps, link, said, notices } = await setup({ approve: true });
    const held = ok(await askTask(deps, link, asked("r1")));
    expect(held.state).toBe("held");
    expect(said).toHaveLength(0);
    expect(notices[0]).toMatchObject({ title: "dev asks to run a task here", url: "/sandbox/access?section=links", requireInteraction: true });
    const started = await decideTask(deps, link, "r1", true);
    expect(started).toMatchObject({ state: "running" });
    expect(said[0]?.turn.prompt).toContain("Check the error rate for r1.");
    // Already answered: a second answer is refused rather than starting it twice.
    expect(await decideTask(deps, link, "r1", true)).toMatchObject({ refused: 409 });

    ok(await askTask(deps, link, asked("r2")));
    expect(await decideTask(deps, link, "r2", false)).toMatchObject({ state: "declined" });
    expect(said).toHaveLength(1);
});

test("a task that has crossed as many links as allowed is refused before anything is filed", async () => {
    const { deps, link, links, said } = await setup();
    expect(await askTask(deps, link, asked("deep", { hops: LINK_MAX_HOPS }))).toMatchObject({ refused: 409 });
    expect(await links.task(link.id, { requestId: "deep" })).toBeUndefined();
    expect(said).toHaveLength(0);
    // One link short of the ceiling is still taken, and its turn is told how far the work has come.
    ok(await askTask(deps, link, asked("near", { hops: LINK_MAX_HOPS - 1 })));
    expect(said[0]?.turn.prompt).toContain("1 link before this one");
});

test("the hourly allowance stops new turns; words into a turn already running are not counted", async () => {
    const { deps, link, parkIn } = await setup({ turnsPerHour: 1 });
    const first = ok(await askTask(deps, link, asked("r1")));
    expect(await askTask(deps, link, asked("r2"))).toMatchObject({ refused: 429 });
    const task = await deps.links.task(link.id, { requestId: "r1" });
    if (task === undefined) {
        throw new Error("the first task was filed");
    }
    parkIn(first.conversationId, []);
    expect(await messageTask(deps, link, task, { message: "also the p99" })).toEqual({ delivered: "started" });
});

test("a parked question reads as blocked with the question, which the asking side may answer; any other card is the owner's", async () => {
    const { deps, link, replies, parkIn } = await setup();
    const status = ok(await askTask(deps, link, asked("r1")));
    const task = await deps.links.task(link.id, { requestId: "r1" });
    if (task === undefined) {
        throw new Error("filed");
    }
    const question = {
        requestId: "q1",
        status: "pending" as const,
        questions: [{ question: "Which region?", header: "Region", multiSelect: false, options: [{ label: "eu", description: "Europe" }] }],
    };
    parkIn(status.conversationId, [{ role: "assistant", text: "", question }]);
    const blocked = statusOf(deps, task);
    expect(blocked).toMatchObject({ state: "blocked", question: { requestId: "q1" } });
    expect(blocked.version).toBe(task.version * 4 + 1);
    expect(await answerTask(deps, task, { requestId: "q1", answers: { "Which region?": ["eu"] } })).toBeUndefined();
    expect(replies).toEqual([{ kind: "question", requestId: "q1", answers: { "Which region?": ["eu"] } }]);

    const stuckBrowser: TranscriptRow = {
        role: "assistant",
        text: "",
        browserHelp: { requestId: "p1", session: "s1", account: "ops-db", message: "a captcha", status: "pending" },
    };
    parkIn(status.conversationId, [stuckBrowser]);
    expect(statusOf(deps, task)).toMatchObject({ state: "blocked", waitingOn: expect.stringContaining("owner") });
    expect(await answerTask(deps, task, { requestId: "p1", answers: {} })).toMatchObject({ refused: 409 });
});

test("a linked turn's ending is its report; a task its asker stopped stays stopped", async () => {
    const { deps, link, stops } = await setup();
    const status = ok(await askTask(deps, link, asked("r1")));
    await noteLinkTurnSettled(deps, { conversationId: status.conversationId, actor: undefined, speaker: undefined, failure: undefined, closing: "p99 is 210ms" });
    expect(await deps.links.task(link.id, { requestId: "r1" })).toMatchObject({ state: "finished", report: "p99 is 210ms" });

    const other = ok(await askTask(deps, link, asked("r2")));
    const running = await deps.links.task(link.id, { requestId: "r2" });
    if (running === undefined) {
        throw new Error("filed");
    }
    expect(await stopTask(deps, link, running)).toMatchObject({ state: "stopped" });
    expect(stops).toEqual([{ conversationId: other.conversationId, live: true }]);
    await noteLinkTurnSettled(deps, { conversationId: other.conversationId, actor: undefined, speaker: undefined, failure: undefined, closing: "half done" });
    expect(await deps.links.task(link.id, { requestId: "r2" })).toMatchObject({ state: "stopped", report: "half done" });
    // A conversation no link opened is none of this module's business.
    await noteLinkTurnSettled(deps, { conversationId: "brave-otter-1", actor: undefined, speaker: undefined, failure: undefined, closing: "x" });
});

test("a link reaches only its own tasks, by the store's own key", async () => {
    const { deps, link, links } = await setup();
    const status = ok(await askTask(deps, link, asked("r1")));
    const other = await links.mint("other", {});
    const otherLink: ResolvedLink | undefined = await links.resolve(other.token);
    expect(otherLink).toMatchObject({ id: other.id, label: "other" });
    expect(await links.task(other.id, { conversationId: status.conversationId })).toBeUndefined();
});
