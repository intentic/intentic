import { memoryFleet } from "../registry/agents-registry.testing.js";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { BeginTurn } from "./conversation-decide.js";
import { beginTurn } from "./conversation-actors.testing.js";
import { awaitBegin, carryingOn, expectTurn, type Holding, turnComing } from "./conversation-holdings.js";

// What a conversation holds beside its state, through the registry every door files into: each item is found by its
// id alone, sits with its holder, and leaves with the holder's dispose, or with the dispose of the conversation it is
// about, and with nobody else's.

const CARDS: Holding<string> = { name: "cards" };

describe("holdings", () => {
    test("file an item under its holder, find it by id alone, and list a holder's own in the order held", () => {
        const { conversations } = memoryFleet();
        const cards = conversations.holdings(CARDS);
        cards.hold("c1", "r-1", "first");
        cards.hold("c2", "r-2", "other");
        cards.hold("c1", "r-3", "second");

        expect(cards.get("r-3")).toBe("second");
        expect(cards.holder("r-2")).toBe("c2");
        expect(cards.of("c1")).toEqual(["first", "second"]);
        expect(cards.entries()).toEqual([
            ["r-1", "first"],
            ["r-2", "other"],
            ["r-3", "second"],
        ]);
    });

    test("keep an item no conversation holds in the bucket, found by id and named by no holder", () => {
        const { conversations } = memoryFleet();
        const cards = conversations.holdings(CARDS);
        cards.hold(undefined, "r-loose", "plan");

        expect(cards.get("r-loose")).toBe("plan");
        expect(cards.has("r-loose")).toBe(true);
        expect(cards.holder("r-loose")).toBeUndefined();
        expect(cards.drop("r-loose")).toBe(true);
        expect(cards.has("r-loose")).toBe(false);
        expect(cards.drop("r-loose")).toBe(false);
    });

    test("move an item to its new holder when it is held again, and to the end of the order", () => {
        const { conversations } = memoryFleet();
        const cards = conversations.holdings(CARDS);
        cards.hold("c1", "r-1", "one");
        cards.hold("c1", "r-2", "two");
        cards.hold("c2", "r-1", "moved");

        expect(cards.of("c1")).toEqual(["two"]);
        expect(cards.of("c2")).toEqual(["moved"]);
        expect(cards.entries().map(([id]) => id)).toEqual(["r-2", "r-1"]);
    });

    test("keep two kinds apart even under one id", () => {
        const { conversations } = memoryFleet();
        const seats: Holding<number> = { name: "seats" };
        conversations.holdings(CARDS).hold("c1", "c1", "card");
        conversations.holdings(seats).hold("c1", "c1", 2);

        expect(conversations.holdings(CARDS).get("c1")).toBe("card");
        expect(conversations.holdings(seats).get("c1")).toBe(2);
    });

    test("clear every item of one kind, the bucket's too, and no other kind's", () => {
        const { conversations } = memoryFleet();
        const seats: Holding<number> = { name: "seats" };
        conversations.holdings(CARDS).hold("c1", "r-1", "card");
        conversations.holdings(CARDS).hold(undefined, "r-2", "loose");
        conversations.holdings(seats).hold("c1", "c1", 1);

        conversations.holdings(CARDS).clear();

        expect(conversations.holdings(CARDS).entries()).toEqual([]);
        expect(conversations.holdings(seats).entries()).toEqual([["c1", 1]]);
    });
});

describe("disposal of what conversations hold", () => {
    test("takes the holder's items and those about it, lets their owners go of each, and leaves the rest", async () => {
        const { conversations } = memoryFleet();
        const letGo: string[] = [];
        const children: Holding<string> = { name: "children", dropped: (child) => letGo.push(child) };
        const kids = conversations.holdings(children);
        // The parent's record of the child (about it), the child's own record of a grandchild, and a cousin's.
        kids.hold("parent", "child", "child of parent", "child");
        kids.hold("child", "grandchild", "child of child", "grandchild");
        kids.hold("other", "cousin", "child of other", "cousin");
        conversations.holdings(CARDS).hold(undefined, "r-loose", "loose card");

        await conversations.dispose(["child"]);

        expect(kids.entries()).toEqual([["cousin", "child of other"]]);
        expect(letGo).toEqual(["child of parent", "child of child"]);
        expect(conversations.traces("child")).toEqual([]);
        // The bucket answers to no dispose.
        expect(conversations.holdings(CARDS).get("r-loose")).toBe("loose card");
    });

    test("names what still holds anything of a conversation's until it is disposed", async () => {
        const { conversations } = memoryFleet();
        conversations.holdings(CARDS).hold("c2", "r-1", "about c1", "c1");

        expect(conversations.traces("c1")).toEqual(["cards"]);
        expect(conversations.traces("c2")).toEqual(["actor", "cards"]);

        await conversations.dispose(["c1"]);

        expect(conversations.traces("c1")).toEqual([]);
        expect(conversations.traces("c2")).toEqual(["actor"]);
    });
});

// A turn the sandbox has on its way to a conversation reads `resuming` on its card from the mover's mark to the turn's
// begin, and a mark given back with no turn begun tells the card again.

const turn = (over: Partial<BeginTurn> = {}): BeginTurn => ({
    conversationId: "c1",
    isolated: true,
    prompt: "Wait for CI",
    profile: { agent: "claude", harness: "native" },
    ...over,
});

const atRest = async () => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(fleet.conversations, turn(), 1_000);
    await fleet.conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "Provider refused." } }).settled;
    await fleet.conversations.send("c1", { kind: "settle" }, 1_100).settled;
    const frames: AgentSummary[][] = [];
    fleet.agents.subscribe((agents) => frames.push(agents));
    return { fleet, frames, status: () => fleet.agents.get("c1")?.status };
};

describe("a turn on its way", () => {
    it("reads resuming over the ending it answers, and every mark goes the moment the turn begins", async () => {
        const { fleet, status } = await atRest();
        expect(status()).toBe("error");

        const watch = expectTurn(fleet.conversations, "c1", "watch");
        expectTurn(fleet.conversations, "c1", "child-report", "sub-1");
        expect(status()).toBe("resuming");
        await beginTurn(fleet.conversations, turn(), 2_000);

        expect(turnComing(fleet.conversations, "c1")).toBe(false);
        expect(status()).toBe("running");
        // Given back after the begin took it: nothing to tell.
        watch();
        expect(status()).toBe("running");
    });

    it("tells the card its ending again once the last mark goes with no turn begun, and not before", async () => {
        const { fleet, frames, status } = await atRest();
        const first = expectTurn(fleet.conversations, "c1", "booked");
        const second = expectTurn(fleet.conversations, "c1", "queued");

        first();
        expect(frames.slice(1)).toEqual([]);
        expect(status()).toBe("resuming");
        second();

        expect(frames.slice(1).map((frame) => frame.find((agent) => agent.id === "c1")?.status)).toEqual(["error"]);
        expect(status()).toBe("error");
    });

    it("gives its mark back however the work under it ends", async () => {
        const { fleet, status } = await atRest();
        await expect(
            carryingOn(fleet.conversations, "c1", "held-rerun", async () => {
                expect(status()).toBe("resuming");
                throw new Error("the start threw");
            }),
        ).rejects.toThrow("the start threw");
        expect(status()).toBe("error");
    });

    it("holds a claimed run's conversation until the run begins, or until it ends without one", async () => {
        const { fleet, status } = await atRest();
        let finish: () => void = () => undefined;
        const finished = new Promise<void>((resolve) => {
            finish = resolve;
        });
        awaitBegin(fleet.conversations, "c1", { waitUntilFinished: () => finished });
        expect(status()).toBe("resuming");
        finish();
        await finished;
        await Promise.resolve();
        expect(status()).toBe("error");

        // A conversation already running is in flight on its own word.
        await beginTurn(fleet.conversations, turn(), 3_000);
        awaitBegin(fleet.conversations, "c1", { waitUntilFinished: () => new Promise(() => undefined) });
        expect(turnComing(fleet.conversations, "c1")).toBe(false);
    });
});
