import { describe, test, expect } from "bun:test";
import { fenceHoldsPersona, personaHome } from "./persona-home.js";

// Where a card lives, and therefore who may wear it. This is the whole of the rule the Access tab draws and the
// daemon refuses on, so the three shapes a card can name a place in are each pinned here.

describe("personaHome", () => {
    test("the folder it opens in is its home, even when it may touch more", () => {
        expect(personaHome({ workspace: { startIn: "support" } })).toEqual(["support"]);
        expect(personaHome({ workspace: { startIn: "support", folders: ["support", "shared"] } })).toEqual(["support"]);
    });

    test("with no starting folder, the folders it may touch are its home", () => {
        expect(personaHome({ workspace: { folders: ["finance", "billing"] } })).toEqual(["finance", "billing"]);
    });

    test("naming no place at all is the workspace root, which is not a folder any fence can hold", () => {
        expect(personaHome({})).toBeUndefined();
        expect(personaHome({ workspace: {} })).toBeUndefined();
        expect(personaHome({ workspace: { folders: [] } })).toBeUndefined();
    });
});

describe("fenceHoldsPersona", () => {
    const support = { workspace: { startIn: "support/inbox" } };
    const finance = { workspace: { startIn: "finance" } };
    const anywhere = { workspace: { folders: ["finance", "support"] } };

    test("an unfenced holder wears every card, root-homed ones included", () => {
        expect(fenceHoldsPersona(undefined, support)).toBe(true);
        expect(fenceHoldsPersona(undefined, {})).toBe(true);
    });

    test("a fenced holder wears the cards homed inside its folders and no others", () => {
        expect(fenceHoldsPersona(["support"], support)).toBe(true);
        expect(fenceHoldsPersona(["support"], finance)).toBe(false);
        // By segment, not by string prefix: `support2` is not inside `support`.
        expect(fenceHoldsPersona(["support"], { workspace: { startIn: "support2" } })).toBe(false);
    });

    test("a card spanning more than the fence is not held: the fence has to cover all of it", () => {
        expect(fenceHoldsPersona(["support"], anywhere)).toBe(false);
        expect(fenceHoldsPersona(["support", "finance"], anywhere)).toBe(true);
    });

    // The one card no fence can reach, whatever it names: everything is inside the root, so holding it would be
    // holding the workspace.
    test("a card homed at the root is the owner's alone", () => {
        expect(fenceHoldsPersona(["support"], {})).toBe(false);
        expect(fenceHoldsPersona([], {})).toBe(false);
    });
});
