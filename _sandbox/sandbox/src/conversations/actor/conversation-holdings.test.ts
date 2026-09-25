import { memoryFleet } from "../../testing.js";
import type { Holding } from "./conversation-holdings.js";

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
