import { fleetWithheld } from "./sandboxes.routes.js";

// The fleet CLI's routes answer for the turn that calls them, not for the sandbox: a turn whose persona or people were
// not given the owner's account is refused, while a shell no planned turn owns keeps the card-per-create it always had.

test("a turn granted the fleet card goes through", () => {
    expect(fleetWithheld("fleet", { granted: ["github", "fleet"] })).toBeUndefined();
});

test("a turn the persona or the people's reach kept the card from is refused, by the card's name", () => {
    expect(fleetWithheld("fleet", { granted: ["github"] })).toContain('"fleet" card');
});

test("no fleet connected, or no planned turn to ask about, leaves the decision to the gate behind", () => {
    expect(fleetWithheld(undefined, { granted: [] })).toBeUndefined();
    expect(fleetWithheld("fleet", undefined)).toBeUndefined();
});
