import { memoryFleet } from "../../testing.js";
import { type ChildStanding, cancelMoveFor, descendantsOf, type FamilyLink, familyCancels, familyEnded, markFamilyEnded } from "./family-cancel.js";

// Which children stop when a conversation leaves the board, and how: the spawn tree below it, and what each child stands on.

const link = (child: string, parent: string): FamilyLink => ({ child, parent });

describe("the family below a conversation that leaves", () => {
    const tree = [link("a", "p"), link("b", "p"), link("a1", "a"), link("a1x", "a1"), link("q1", "q"), link("b1", "b")];

    it("is every generation below it, nearer ones first, and nothing beside it", () => {
        expect(descendantsOf(["p"], tree)).toEqual([link("a", "p"), link("b", "p"), link("a1", "a"), link("b1", "b"), link("a1x", "a1")]);
        expect(descendantsOf(["q"], tree)).toEqual([link("q1", "q")]);
        expect(descendantsOf(["nobody"], tree)).toEqual([]);
        expect(descendantsOf([], tree)).toEqual([]);
    });

    it("leaves out a head another head spawned, which leaves on its own account, but still walks below it", () => {
        // The aged sweep files a parent with the children that go with it, so both are heads.
        expect(descendantsOf(["p", "a"], tree)).toEqual([link("b", "p"), link("a1", "a"), link("b1", "b"), link("a1x", "a1")]);
    });

    it("names each child once, whichever record of it was read, and survives a loop in the records", () => {
        // The registry and the daemon's own records both name a child it supervises.
        expect(descendantsOf(["p"], [link("a", "p"), link("a", "p")])).toEqual([link("a", "p")]);
        expect(descendantsOf(["p"], [link("a", "p"), link("p", "a")])).toEqual([link("a", "p")]);
        expect(descendantsOf(["p"], [link("a", "p"), link("b", "a"), link("a", "b")])).toEqual([link("a", "p"), link("b", "a")]);
    });
});

describe("what stopping one child takes", () => {
    const tracked = (over: Partial<Extract<ChildStanding, { tracked: true }>> = {}): ChildStanding => ({
        tracked: true,
        heldForOwner: false,
        paused: false,
        running: false,
        ...over,
    });
    const untracked = (over: Partial<Extract<ChildStanding, { tracked: false }>> = {}): ChildStanding => ({
        tracked: false,
        sandboxRun: false,
        bookedRerun: false,
        ...over,
    });

    it("cancels a supervised child that runs, waits to start, or waits on a booked re-run, as its parent would", () => {
        expect(cancelMoveFor(tracked({ running: true }))).toEqual({ kind: "cancel" });
        expect(cancelMoveFor(tracked({ paused: true }))).toEqual({ kind: "cancel" });
    });

    it("leaves a finished child, and one waiting on the owner's card, which is theirs to decline", () => {
        expect(cancelMoveFor(tracked())).toEqual({ kind: "none" });
        expect(cancelMoveFor(tracked({ running: true, heldForOwner: true }))).toEqual({ kind: "none" });
    });

    it("stops the sandbox's turn and drops its booking on a child the daemon lost track of across a restart", () => {
        expect(cancelMoveFor(untracked({ sandboxRun: true }))).toEqual({ kind: "halt", stop: true, drop: false });
        expect(cancelMoveFor(untracked({ bookedRerun: true }))).toEqual({ kind: "halt", stop: false, drop: true });
        expect(cancelMoveFor(untracked({ sandboxRun: true, bookedRerun: true }))).toEqual({ kind: "halt", stop: true, drop: true });
        // Nothing of the sandbox's runs or is booked: a person's own turn in its chat, or nothing at all.
        expect(cancelMoveFor(untracked())).toEqual({ kind: "none" });
    });

    it("lists only the members with something to stop, nearer generations first", () => {
        const standings = new Map([
            ["a", tracked({ running: true })],
            ["b", tracked()],
            ["a1", untracked({ bookedRerun: true })],
            ["b1", untracked()],
            ["a1x", tracked({ paused: true })],
        ]);
        const members = descendantsOf(["p"], [link("a", "p"), link("b", "p"), link("a1", "a"), link("a1x", "a1"), link("b1", "b")]);
        expect(familyCancels(members, (child) => standings.get(child) ?? untracked())).toEqual([
            { child: "a", parent: "p", move: { kind: "cancel" } },
            { child: "a1", parent: "a", move: { kind: "halt", stop: false, drop: true } },
            { child: "a1x", parent: "a1", move: { kind: "cancel" } },
        ]);
    });
});

describe("the mark that keeps stopped endings from waking a child with children", () => {
    it("holds for the moments a stop takes to settle, then lapses", () => {
        const { conversations } = memoryFleet();
        expect(familyEnded(conversations, "a", 1_000)).toBe(false);
        markFamilyEnded(conversations, "a", 1_000);
        expect(familyEnded(conversations, "a", 1_000 + 60_000)).toBe(true);
        expect(familyEnded(conversations, "b", 1_000)).toBe(false);
        expect(familyEnded(conversations, "a", 1_000 + 2 * 60_000)).toBe(false);
    });

    it("goes with the conversation it marks", async () => {
        const { conversations } = memoryFleet();
        markFamilyEnded(conversations, "a", 1_000);
        await conversations.dispose(["a"]);
        expect(familyEnded(conversations, "a", 1_000)).toBe(false);
    });
});
