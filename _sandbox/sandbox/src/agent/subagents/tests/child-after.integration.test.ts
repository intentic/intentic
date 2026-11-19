import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { unstubbed } from "@intentic/testing";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Services } from "../../../composition.js";
import { spawnServices } from "../../../harness/spawn-services.testing.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { conversationEntry, isolatedAgent } from "../../../conversations/registry/agents-store.testing.js";
import type { PersistedAgent } from "../../../conversations/registry/agents-store.js";
import type { LandStanding } from "../../../conversations/land/standing.js";
import { childActor } from "../../../auth/principal.js";
import { drivenBy } from "../../../seams/turn-starter.testing.js";
import type { TurnInput, TurnStarter } from "../../../seams/turn-starter.js";
import { readKinds, RESUMES } from "../../../seams/restart/in-flight.testing.js";
import { opt } from "../../../opt.js";
import { listSubagentSessions, openSpawnedChild, resetSubagents, settleSpawnedChild, waitForSubagent } from "../subagents.js";
import { cancelChild, type ChildSpawnResult, resetChildrenForTest, sendToChild, spawnChild } from "../children.js";
import { AFTER_SKIPPED, afterLanded, afterMoved, afterRefusal, afterSummary, prerequisiteOf } from "../starting/child-after.js";
import { withBrief } from "../starting/child-brief.js";
import { CHILDREN } from "../child-records.js";
import { childRecordOf } from "../child-spec.js";
import { cutChildrenInFlight, spawnedChildrenInFlight } from "../child-restore.js";
import { spawnedChildren } from "../spawned-children.js";

// A spawn naming siblings in `after` (child-after.ts), driven through the spawn engine's real entry points: what a
// parent sees (the spawn's answer, the roster row its wait and `agents show` read, what it is told) and when each
// child's turn starts, which is when its conversation, and so its worktree, is cut.

const actors = memoryFleet().conversations;
const parent = { conversationId: "conv-parent", cwd: WORKSPACE_ROOT };
const SONNET = { provider: "claude", model: "claude-sonnet-4-6" } as const;

// Every child's turn says it is at work (which proves its lane to the fan-out governor), then waits for its own gate, so
// a case decides when, and how, each sibling ends.
const gatedTurns = () => {
    const turns: TurnInput[] = [];
    const gates = new Map<string, PromiseWithResolvers<readonly AgentEvent[]>>();
    const gate = (id: string): PromiseWithResolvers<readonly AgentEvent[]> => {
        const held = gates.get(id) ?? Promise.withResolvers<readonly AgentEvent[]>();
        gates.set(id, held);
        return held;
    };
    const body: TurnStarter["stream"] = async function* gated(input) {
        turns.push(input);
        yield { kind: "delta", text: "On it." };
        yield* await gate(input.conversationId ?? "").promise;
    };
    const DONE: readonly AgentEvent[] = [{ kind: "delta", text: " Done." }, { kind: "text_end" }, { kind: "done" }];
    return { turns, body, end: (id: string, events: readonly AgentEvent[] = DONE) => gate(id).resolve(events) };
};

// The daemon a parent spawns on: the registry answers for the parent and for whatever entries a case gives its children,
// with the land standings a case sets, and the parent's live turn hears what it is told.
const daemonOver = (body: TurnStarter["stream"], entries: Map<string, PersistedAgent> = new Map(), standings: Map<string, LandStanding> = new Map()) => {
    const told: string[] = [];
    const driven = drivenBy(spawnServices({}, [], actors), body);
    const services = unstubbed<Services>("services", {
        ...driven,
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id: string) => (id === parent.conversationId ? conversationEntry({ id }) : entries.get(id)),
            standingOf: (id: string) => standings.get(id) ?? "idle",
        }),
        turns: {
            ...driven.turns,
            say: async (said) => {
                told.push(said.turn.prompt);
                return { delivered: "steered", run: "run-parent" };
            },
        },
    });
    return { services, told };
};

const idOf = (result: ChildSpawnResult): string => {
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result.id;
};

const rowOf = (id: string) => listSubagentSessions(actors).find((session) => session.id === id);
const finished = (id: string) => waitForSubagent(actors, parent.conversationId, { target: id, until: ["finished"], timeoutMs: 5_000 });
// Long enough for a sibling's ending to have been looked at by whoever waits after it, which is a microtask away.
const looked = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
const started = (turns: readonly TurnInput[]): (string | undefined)[] => turns.map((turn) => turn.conversationId);

beforeEach(() => {
    resetSubagents(actors);
    resetChildrenForTest(actors);
});

describe("a spawn that names siblings in after", () => {
    it("is filed at once, pending after them, and starts only once its sibling has finished with its work in", async () => {
        const { turns, body, end } = gatedTurns();
        const { services, told } = daemonOver(body);
        const parser = idOf(await spawnChild(services, parent, { prompt: "Write the parser", description: "parser", ...SONNET }));
        const lexer = await spawnChild(services, parent, { prompt: "Build the lexer on the parser", description: "lexer", ...SONNET, after: [parser] });

        expect(lexer).toEqual({ ok: true, id: expect.stringMatching(/^sub-/u), held: true, note: afterSummary([parser]) });
        const lexerId = idOf(lexer);
        // What its parent's wait and `agents show` read: pending after the sibling, by id.
        expect(rowOf(lexerId)).toMatchObject({ status: "pending", description: "lexer", summary: afterSummary([parser]) });
        expect(afterSummary([parser])).toStartWith(`Waiting after \`${parser}\`: it starts by itself`);
        await waitFor(() => expect(started(turns)).toEqual([parser]), SETTLES);

        end(parser);
        await finished(parser);
        await waitFor(() => expect(started(turns)).toEqual([parser, lexerId]), SETTLES);
        expect(turns[1]).toMatchObject({ prompt: "Build the lexer on the parser", isolated: true, unattended: true });
        // Its opening note says their work is in its checkout (child-preamble.ts).
        expect(actors.holdings(CHILDREN).get(lexerId)?.after).toEqual([parser]);
        end(lexerId);
        await expect(finished(lexerId)).resolves.toMatchObject({ outcome: "finished", matched: { status: "completed" } });
        expect(told).toEqual([]);
    });

    it("waits for every sibling it names, whichever finishes first", async () => {
        const { turns, body, end } = gatedTurns();
        const { services } = daemonOver(body);
        const parser = idOf(await spawnChild(services, parent, { prompt: "Write the parser", ...SONNET }));
        const types = idOf(await spawnChild(services, parent, { prompt: "Write the type checker", ...SONNET }));
        const codegen = idOf(await spawnChild(services, parent, { prompt: "Generate code from both", ...SONNET, after: [types, parser, types] }));
        await waitFor(() => expect(started(turns)).toEqual([parser, types]), SETTLES);

        end(types);
        await finished(types);
        await looked();
        expect(started(turns)).toEqual([parser, types]);
        // Named once each, in the order given.
        expect(rowOf(codegen)).toMatchObject({ status: "pending", summary: afterSummary([types, parser]) });

        end(parser);
        await finished(parser);
        await waitFor(() => expect(started(turns)).toEqual([parser, types, codegen]), SETTLES);
    });

    it("refuses an id that is not a subagent this parent spawned, and starts nothing", async () => {
        const { turns, body } = gatedTurns();
        const { services } = daemonOver(body);
        const stranger = idOf(await spawnChild(services, { conversationId: "conv-other", cwd: WORKSPACE_ROOT }, { prompt: "Someone else's", ...SONNET }));
        await waitFor(() => expect(started(turns)).toEqual([stranger]), SETTLES);
        const before = listSubagentSessions(actors).length;

        expect(await spawnChild(services, parent, { prompt: "Build on it", ...SONNET, after: ["sub-nowhere"] })).toEqual({
            ok: false,
            message:
                "Nothing was started: `after` names `sub-nowhere`, which is not a subagent you spawned in this sandbox. Name only your own subagents' ids, as spawn returned them (`list` shows them).",
        });
        expect(await spawnChild(services, parent, { prompt: "Build on it", ...SONNET, after: [stranger, "sub-gone"] })).toMatchObject({
            ok: false,
            message: expect.stringContaining(`names \`${stranger}\`, \`sub-gone\`, which are not subagents you spawned`),
        });
        expect(listSubagentSessions(actors)).toHaveLength(before);
        expect(started(turns)).toEqual([stranger]);
    });

    it("refuses a wait that would go round in a circle", () => {
        const records = actors.holdings(CHILDREN);
        records.hold(parent.conversationId, "sub-a", { ...childRecordOf(parent, { prompt: "a", ...SONNET }, 1, "after"), after: ["sub-b"] }, "sub-a");
        records.hold(parent.conversationId, "sub-b", { ...childRecordOf(parent, { prompt: "b", ...SONNET }, 1, "after"), after: ["sub-a"] }, "sub-b");

        expect(afterRefusal(actors, parent.conversationId, ["sub-a"])).toBe("Nothing was started: `after` would wait in a circle (`sub-a` waits after `sub-b` waits after `sub-a`), which never starts.");
        expect(afterRefusal(actors, parent.conversationId, undefined)).toBeUndefined();
    });

    it("stays waiting on a sibling that failed, tells its parent once, and starts on a message, its task first", async () => {
        const { turns, body, end } = gatedTurns();
        const { services, told } = daemonOver(body);
        const parser = idOf(await spawnChild(services, parent, { prompt: "Write the parser", description: "parser", ...SONNET }));
        const lexer = idOf(await spawnChild(services, parent, { prompt: "Build the lexer on the parser", description: "lexer", ...SONNET, after: [parser] }));

        end(parser, [{ kind: "error", message: "The provider refused the request." }, { kind: "done" }]);
        await expect(finished(parser)).resolves.toMatchObject({ matched: { status: "failed" } });
        await looked();
        expect(started(turns)).toEqual([parser]);
        const stuck = `\`${parser}\` failed, so it does not start by itself: it starts once \`${parser}\` finishes with its work in (send \`${parser}\` what to do), or when you send it a message`;
        expect(rowOf(lexer)).toMatchObject({ status: "pending", summary: `Waiting after \`${parser}\`: ${stuck}. Send it a message to start it now, or cancel it.` });
        expect(told).toEqual([
            `Your subagent \`${lexer}\` ("lexer") waits after \`${parser}\`, and ${stuck}. To start it now anyway, send it a message: it opens on its task, then your words. To drop it, cancel it.`,
        ]);

        expect(await sendToChild(services, parent, lexer, "Go on without the parser: stub it.")).toEqual({ ok: true, note: AFTER_SKIPPED });
        await waitFor(() => expect(started(turns)).toEqual([parser, lexer]), SETTLES);
        expect(turns[1]?.prompt).toBe(withBrief({ spec: { prompt: "Build the lexer on the parser" } }, "Go on without the parser: stub it."));
        // Started before its sibling's work was in, it is not told that work is in its checkout.
        expect(actors.holdings(CHILDREN).get(lexer)?.after).toBeUndefined();
        expect(told).toHaveLength(1);
    });

    // The supervisor's merge and settle pass their answer through afterMoved (children.ts childSupervisor); every land
    // that reaches a tree, an owner's press on the card included, is announced as `agent.landed` (boot-schedulers.ts).
    it.each([
        ["its parent's merge or settle", (id: string) => afterMoved(id)({ ok: true })],
        ["a land of it, the owner's own included", (id: string) => afterLanded({ event: "agent.landed", agentId: id, branch: `agent/${id}`, outcome: "landed", repos: [] })],
    ])("waits on a sibling whose work a clash held on its branch, and starts once %s brings that work in", async (_door, broughtIn) => {
        const { turns, body, end } = gatedTurns();
        const entries = new Map<string, PersistedAgent>();
        const standings = new Map<string, LandStanding>();
        const { services, told } = daemonOver(body, entries, standings);
        const parser = idOf(await spawnChild(services, parent, { prompt: "Write the parser", description: "parser", ...SONNET }));
        const lexer = idOf(await spawnChild(services, parent, { prompt: "Build the lexer on the parser", ...SONNET, after: [parser] }));
        entries.set(parser, isolatedAgent([], { id: parser, identity: { startedBy: childActor(parent.conversationId) } }));
        standings.set(parser, "conflict");

        end(parser);
        await finished(parser);
        await looked();
        expect(started(turns)).toEqual([parser]);
        expect(told).toEqual([expect.stringContaining(`\`${parser}\`'s work waits on its branch, not in your checkout`)]);
        expect(rowOf(lexer)).toMatchObject({ status: "pending", summary: expect.stringContaining("it starts once you bring that work in with merge, or say you did with settle") });

        standings.set(parser, "landed");
        broughtIn(parser);
        await waitFor(() => expect(started(turns)).toEqual([parser, lexer]), SETTLES);
        expect(told).toHaveLength(1);
    });

    it("named after a sibling that already failed, says so in the spawn's own answer rather than after it", async () => {
        const { turns, body, end } = gatedTurns();
        const { services, told } = daemonOver(body);
        const parser = idOf(await spawnChild(services, parent, { prompt: "Write the parser", ...SONNET }));
        end(parser, [{ kind: "error", message: "The provider refused the request." }, { kind: "done" }]);
        await finished(parser);

        const lexer = await spawnChild(services, parent, { prompt: "Build the lexer on the parser", ...SONNET, after: [parser] });
        expect(lexer).toMatchObject({ ok: true, held: true, note: `${afterSummary([parser])} Already: \`${parser}\` failed, so it does not start by itself: it starts once \`${parser}\` finishes with its work in (send \`${parser}\` what to do), or when you send it a message.` });
        await looked();
        expect(told).toEqual([]);
        expect(started(turns)).toEqual([parser]);
    });

    it("never starts once its parent cancels it while it waits", async () => {
        const { turns, body, end } = gatedTurns();
        const { services } = daemonOver(body);
        const parser = idOf(await spawnChild(services, parent, { prompt: "Write the parser", ...SONNET }));
        const lexer = idOf(await spawnChild(services, parent, { prompt: "Build the lexer on the parser", ...SONNET, after: [parser] }));

        expect(await cancelChild(services, parent, lexer)).toMatchObject({ ok: true });
        expect(rowOf(lexer)).toMatchObject({ status: "killed" });
        end(parser);
        await finished(parser);
        await looked();
        expect(started(turns)).toEqual([parser]);
    });

    it("starts at once when every sibling it names has already finished with its work in", async () => {
        const { turns, body, end } = gatedTurns();
        const { services } = daemonOver(body);
        const parser = idOf(await spawnChild(services, parent, { prompt: "Write the parser", ...SONNET }));
        end(parser);
        await finished(parser);

        const lexer = await spawnChild(services, parent, { prompt: "Build the lexer on the parser", ...SONNET, after: [parser] });
        expect(lexer).toEqual({ ok: true, id: expect.any(String) });
        await waitFor(() => expect(started(turns)).toEqual([parser, idOf(lexer)]), SETTLES);
    });

    it("comes back from a restart still waiting after its sibling, and starts once that sibling's work is in", async () => {
        const { turns, body } = gatedTurns();
        const root = await mkdtemp(join(tmpdir(), "after-children-"));
        // The registry still names the sibling that ran, as its parent's child.
        const entries = new Map([["sub-parser", conversationEntry({ id: "sub-parser", identity: { startedBy: childActor(parent.conversationId) } })]]);
        const { services: daemon } = daemonOver(body, entries);
        const services = unstubbed<Services>("services", { ...daemon, config: unstubbed<Services["config"]>("config", { historyRoot: root }) });
        const files = spawnedChildren(root, { warn: () => {} });
        const spec = (prompt: string) => ({ prompt, description: prompt, ...SONNET });
        const at = Date.now();
        files.write("sub-parser", { parent: parent.conversationId, spec: spec("Write the parser"), depth: 1, cwd: WORKSPACE_ROOT, sessionId: "s-1", startedAt: at - 2_000, state: "settled", turns: 1, ending: { status: "completed", at: at - 1_000 }, at: at - 1_000 });
        files.write("sub-lexer", { parent: parent.conversationId, spec: spec("Build the lexer"), depth: 1, cwd: WORKSPACE_ROOT, startedAt: at - 1_500, state: "held", startHold: { kind: "after", order: 1, after: ["sub-parser"] }, turns: 0, at: at - 1_000 });
        await files.list();

        const [restoring, cut] = await readKinds(services, [spawnedChildrenInFlight, cutChildrenInFlight]);
        await restoring?.recover(RESUMES);
        expect(rowOf("sub-lexer")).toMatchObject({ status: "pending", summary: afterSummary(["sub-parser"]) });
        await cut?.recover(RESUMES);

        await waitFor(() => expect(started(turns)).toEqual(["sub-lexer"]), SETTLES);
        expect(turns[0]?.prompt).toBe("Build the lexer");
        expect(actors.holdings(CHILDREN).get("sub-lexer")?.after).toEqual(["sub-parser"]);
    });
});

describe("where a finished sibling's work stands", () => {
    // A sibling that ended well, with the registry saying whose checkout took its two changed files, if any did.
    const finishedSibling = (landedInto: string | undefined, standing: LandStanding, parentHome = false) => {
        openSpawnedChild({ conversationId: parent.conversationId, conversations: actors, subagentsDir: undefined }, { id: "sub-done", ...SONNET });
        settleSpawnedChild(actors, "sub-done", { status: "completed", report: "Done." });
        const sibling = isolatedAgent([], { id: "sub-done", identity: { startedBy: childActor(parent.conversationId) }, landing: { diff: { files: 2, insertions: 10, deletions: 1 } } });
        const lead = conversationEntry({ id: parent.conversationId, identity: parentHome ? { home: true } : {}, placement: { kind: "worktree", branch: "agent/lead", repos: [] } });
        const entries = new Map<string, PersistedAgent>([
            ["sub-done", { ...sibling, placement: { ...sibling.placement, ...opt("landedInto", landedInto) } }],
            [parent.conversationId, lead],
        ]);
        return prerequisiteOf(actors, { entry: (id) => entries.get(id), standingOf: () => standing }, "sub-done");
    };

    it("is in once it landed in the parent's checkout, and held while it did not", () => {
        expect(finishedSibling(parent.conversationId, "landed")).toEqual({ kind: "in" });
        // A land that never wrote it, and one a clash refused.
        expect(finishedSibling(undefined, "ready")).toEqual({ kind: "held" });
        expect(finishedSibling(parent.conversationId, "conflict")).toEqual({ kind: "held" });
    });

    it("is held for a parent that judges its children first until that parent merges it", () => {
        expect(finishedSibling(undefined, "ready", true)).toEqual({ kind: "held" });
        expect(finishedSibling(parent.conversationId, "ready", true)).toEqual({ kind: "held" });
        expect(finishedSibling(parent.conversationId, "landed", true)).toEqual({ kind: "in" });
    });
});
