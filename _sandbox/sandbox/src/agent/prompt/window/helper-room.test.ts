import { expect, test } from "vitest";
import { helperOverflow, helperPromptRoom } from "./context-budget.js";

// What a one-shot helper may spend, and what it is told when it cannot. The sibling of the turn arithmetic in
// context-budget.test.ts, and deliberately not the same sum: a helper carries no tools, so the harness floor that
// gates a turn is not in the way.

const card = (window: number) => ({ window, onACard: true });
const server = (window: number) => ({ window, onACard: false });

test("an unknown window is unlimited room, never a reason to send less", () => {
    expect(helperPromptRoom(undefined)).toBe(Number.POSITIVE_INFINITY);
});

// The whole window minus the reply, unlike a turn, which also loses ~20k to the loop's own tool schemas.
test("a declared window is spent on the prompt, less room to answer", () => {
    // 16,384 − 1,000 reply = 15,384 tokens × 4 chars.
    expect(helperPromptRoom(card(16_384))).toBe(15_384 * 4);
});

test("a window smaller than the reply leaves nothing rather than a negative budget", () => {
    expect(helperPromptRoom(card(500))).toBe(0);
});

test("a prompt that fits is not an overflow", () => {
    const room = helperPromptRoom(card(16_384));

    expect(helperOverflow("x".repeat(room), room, card(16_384))).toBeUndefined();
});

// THE POINT OF THE CHECK: the two numbers the owner needs, and the two places either one is changed. Without it the
// same job comes back as the server's raw 400 and is memoed for ten minutes, so it reads as intermittent.
test("an overflow names both numbers and where to change them", () => {
    const room = helperPromptRoom(card(16_384));

    const reason = helperOverflow("x".repeat(room + 4_000), room, card(16_384));

    expect(reason).toContain("16,384");
    expect(reason).toContain("Sandbox ▸ Agent ▸ Models");
    // A model this sandbox runs is fixed on its card; pointing at a server flag would send the owner looking for a
    // command line they never typed.
    expect(reason).toContain("Conversation window");
});

test("somebody else's server is pointed at the server, not at a card", () => {
    const room = helperPromptRoom(server(16_384));

    const reason = helperOverflow("x".repeat(room + 4_000), room, server(16_384));

    expect(reason).toMatch(/context size its server was started with/i);
    expect(reason).not.toContain("Conversation window");
});

// Unknown stays unknown: a native subscription publishes no window, and guessing one would refuse helpers that work.
test("an unknown window never overflows", () => {
    expect(helperOverflow("x".repeat(1_000_000), helperPromptRoom(undefined), undefined)).toBeUndefined();
});
