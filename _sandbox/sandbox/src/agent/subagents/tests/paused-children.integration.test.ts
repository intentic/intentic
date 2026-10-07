import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { PersistedAgent } from "../../../conversations/registry/agents-store.js";
import {
    filePausedChildren,
    type PausedChild,
    pausedChildrenDocument,
    type RestartPauseDeps,
    type RestartPauseFacts,
    restartPauseFate,
    restartPauseWords,
    settleRestartPauses,
} from "../paused-children.js";

// A paused child's end check across a restart: the boot's decision for each pause an earlier process wrote down, and the
// record itself.

const EARLIER = "boot-before";
const NOW = "boot-now";
const pause = (over: Partial<PausedChild> = {}): PausedChild => ({
    parent: "p",
    failure: "You've hit your usage limit.",
    at: 1_000,
    boot: EARLIER,
    ...over,
});
const facts = (over: { child?: RestartPauseFacts["child"] | null; parent?: RestartPauseFacts["parent"] | null } = {}): RestartPauseFacts => ({
    child: over.child === null ? undefined : (over.child ?? { parent: "p", running: false }),
    parent: over.parent === null ? undefined : (over.parent ?? { archived: false, running: true }),
});

const logger = { info: () => {}, warn: () => {} };
const roots: string[] = [];
const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "paused-children-"));
    roots.push(root);
    return root;
};
afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("what a boot does with a pause an earlier process left", () => {
    it("tells a parent with a live turn that its child stays stopped, since a restart drops every booked re-run", () => {
        expect(restartPauseFate(pause(), facts(), NOW)).toEqual({ kind: "tell", parent: "p" });
    });

    it("leaves a pause this process wrote, which its own look still covers", () => {
        expect(restartPauseFate(pause({ boot: NOW }), facts(), NOW)).toEqual({ kind: "keep" });
    });

    it("lets a pause go with no word where there is nobody to tell, or the child runs again", () => {
        const dropped = (given: RestartPauseFacts): string | undefined => {
            const fate = restartPauseFate(pause(), given, NOW);
            return fate.kind === "drop" ? fate.why : undefined;
        };
        expect(dropped(facts({ child: null }))).toBe("the child's conversation is gone");
        expect(dropped(facts({ child: { parent: "other", running: false } }))).toBe("the registry names another parent");
        expect(dropped(facts({ child: { parent: "p", running: true } }))).toBe("a turn runs on the child again, and its ending reaches the parent");
        expect(dropped(facts({ parent: null }))).toBe("the parent's conversation is gone");
        expect(dropped(facts({ parent: { archived: true, running: false } }))).toBe("the parent is archived");
        // The check the restart cut tells only a parent in a live turn too (sayToParent).
        expect(dropped(facts({ parent: { archived: false, running: false } }))).toBe("the parent has no live turn to hear it in");
    });

    it("says what stopped the child and why the re-run never comes", () => {
        expect(restartPauseWords("sub-1", "Port the parser", "You've hit your usage limit.")).toBe(
            'Your subagent `sub-1` ("Port the parser") stays stopped: You\'ve hit your usage limit. The sandbox restarted before the re-run it had booked for it, and a restart drops that booking, so it is not coming back by itself: send it again, or give the task to another agent.',
        );
        expect(restartPauseWords("sub-1", undefined, "Out of usage.")).toMatch(/^Your subagent `sub-1` stays stopped: Out of usage\. /);
    });
});

describe("the record a restart reads", () => {
    it("keeps each pause under its child until the pause ends, stamped with the process that wrote it", async () => {
        const root = await scratch();
        const ledger = filePausedChildren(root, logger);
        await ledger.note("sub-1", { parent: "p", failure: "spent" }, 5_000);
        await ledger.note("sub-2", { parent: "p", failure: "stopped short" }, 6_000);
        await ledger.forget(["sub-1"]);
        const kept = await ledger.read();
        expect(Object.keys(kept)).toEqual(["sub-2"]);
        expect(kept["sub-2"]).toMatchObject({ parent: "p", failure: "stopped short", at: 6_000, boot: expect.any(String) });
        expect(JSON.parse(await readFile(join(root, pausedChildrenDocument.path), "utf8"))).toEqual(kept);
    });

    it("never throws for a write that fails, since it runs off a child's turn ending", async () => {
        // A history root that is a file: nothing can be written under it.
        const root = join(await scratch(), "not-a-directory");
        await writeFile(root, "");
        const warned: unknown[] = [];
        const ledger = filePausedChildren(root, { warn: (...args: unknown[]) => void warned.push(args[1]) });
        await ledger.note("sub-1", { parent: "p", failure: "spent" }, 5_000);
        expect(warned).toEqual(["subagents: a child's pause could not be written down, a restart before its re-run tells its parent nothing"]);
    });
});

describe("the boot's settling of the pauses a restart cut", () => {
    // Only what the boot reads of an entry: who started it, whether it is archived, and its title. Every other field
    // throws by name, so a read this suite did not mean to allow fails loudly.
    const entry = (id: string, over: Partial<{ startedBy: string; archivedAt: number; title: string }> = {}): PersistedAgent => {
        const read = {
            id,
            identity: unstubbed<PersistedAgent["identity"]>("identity", { startedBy: over.startedBy }),
            social: unstubbed<PersistedAgent["social"]>("social", {
                title: over.title === undefined ? undefined : { text: over.title, source: "user" },
            }),
            archivedAt: over.archivedAt,
        };
        // SAFETY: an absent field is still a key here, as the boot reads `archivedAt` of an entry that has none.
        return unstubbed<PersistedAgent>(`entry ${id}`, read as Partial<PersistedAgent>);
    };

    it("tells the live parent, strikes off every earlier pause, and leaves its own process's", async () => {
        const root = await scratch();
        // Written by an earlier process: the stamp is the process's own, so this suite writes the file the way one would.
        const ledger = filePausedChildren(root, logger);
        await ledger.note("own", { parent: "p", failure: "spent" }, 9_000);
        await writeFile(
            join(root, pausedChildrenDocument.path),
            JSON.stringify({
                ...(await ledger.read()),
                told: pause({ parent: "p", failure: "You've hit your usage limit." }),
                orphan: pause({ parent: "gone" }),
            }),
        );
        const entries = new Map([
            ["p", entry("p")],
            ["told", entry("told", { startedBy: "agent:p", title: "Port the parser" })],
            ["own", entry("own", { startedBy: "agent:p" })],
            ["orphan", entry("orphan", { startedBy: "agent:gone" })],
        ]);
        const said: { conversationId: string; prompt: string }[] = [];
        const deps: RestartPauseDeps = {
            config: { historyRoot: root },
            logger,
            agents: { entry: (id) => entries.get(id) },
            conversations: { running: (id) => id === "p", sessionIdOf: () => undefined },
            turns: {
                say: async (sent) => {
                    said.push({ conversationId: sent.turn.conversationId, prompt: sent.turn.prompt });
                    return { delivered: "steered", run: "run-p" };
                },
            },
        };

        await settleRestartPauses(deps);

        expect(said).toEqual([{ conversationId: "p", prompt: restartPauseWords("told", "Port the parser", "You've hit your usage limit.") }]);
        expect(Object.keys(await ledger.read())).toEqual(["own"]);
    });
});
