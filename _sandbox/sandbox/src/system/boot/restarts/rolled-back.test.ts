import { expect, test } from "vitest";
import { rolledBackOf, rolledBackProblem } from "./rolled-back.js";

const told = JSON.stringify({
    at: 1_794_000_000_000,
    kind: "rolled-back",
    from: { hash: "a1b2c3d4e5f60718", builtAt: Date.UTC(2026, 10, 11, 22, 0, 0) },
    to: { hash: "0f1e2d3c4b5a6978", builtAt: Date.UTC(2026, 10, 11, 18, 30, 0) },
    failures: 3,
    error: "TypeError: Cannot read properties of undefined (reading 'handler')\n    at x (main.js:1:1)",
    step: "Opening the netd door",
});

test("netd's word that this start is the last build that booted puts it on the owner's card, with the error that sent it there", () => {
    const rolled = rolledBackOf(told);
    expect(rolled).toMatchObject({ failures: 3, step: "Opening the netd door" });
    expect(rolled === undefined ? undefined : rolledBackProblem(rolled)).toEqual({
        kind: "invalidEntry",
        detail:
            "The sandbox is running the last daemon build that booted (built 2026-11-11T18:30:00Z), because the build installed after it " +
            "(built 2026-11-11T22:00:00Z) failed 3 times before it was ready at \"Opening the netd door\": TypeError: Cannot read properties of undefined (reading 'handler')",
        fix: expect.stringContaining("the next start tries the new build first"),
    });
});

test("no word, or one that cannot be read, is an ordinary start", () => {
    expect(rolledBackOf(undefined)).toBeUndefined();
    expect(rolledBackOf("")).toBeUndefined();
    expect(rolledBackOf("{not json")).toBeUndefined();
    expect(rolledBackOf(JSON.stringify({ from: "x" }))).toBeUndefined();
});
