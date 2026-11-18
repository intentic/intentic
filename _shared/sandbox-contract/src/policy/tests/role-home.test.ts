import { fenceHoldsRole, roleHome } from "../role-home.js";

// Where a card lives, and therefore who may wear it. This is the whole of the rule the Access tab draws and the
// daemon refuses on, so both shapes a card can name a place in are each pinned here.

describe("roleHome", () => {
    test("the folder it opens in is its home", () => {
        expect(roleHome({ workspace: { startIn: "support" } })).toEqual(["support"]);
    });

    test("naming no place at all is the workspace root, which is not a folder any fence can hold", () => {
        expect(roleHome({})).toBeUndefined();
        expect(roleHome({ workspace: {} })).toBeUndefined();
        expect(roleHome({ workspace: { startIn: "" } })).toBeUndefined();
    });
});

describe("fenceHoldsRole", () => {
    const support = { workspace: { startIn: "support/inbox" } };
    const finance = { workspace: { startIn: "finance" } };

    test("an unfenced holder wears every card, root-homed ones included", () => {
        expect(fenceHoldsRole(undefined, support)).toBe(true);
        expect(fenceHoldsRole(undefined, {})).toBe(true);
    });

    test("a fenced holder wears the cards homed inside its folders and no others", () => {
        expect(fenceHoldsRole(["support"], support)).toBe(true);
        expect(fenceHoldsRole(["support"], finance)).toBe(false);
        // By segment, not by string prefix: `support2` is not inside `support`.
        expect(fenceHoldsRole(["support"], { workspace: { startIn: "support2" } })).toBe(false);
    });

    // The one card no fence can reach, whatever it names: everything is inside the root, so holding it would be
    // holding the workspace.
    test("a card homed at the root is the owner's alone", () => {
        expect(fenceHoldsRole(["support"], {})).toBe(false);
        expect(fenceHoldsRole([], {})).toBe(false);
    });
});
