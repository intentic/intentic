import { hostedStateOf } from "./hosted-state.js";

test.each([
    ["started", "awake"],
    ["stopped", "asleep"],
    ["suspended", "asleep"],
    ["created", "starting"],
    ["starting", "starting"],
    ["replacing", "starting"],
    ["failed", "down"],
    ["destroyed", "down"],
    ["destroying", "down"],
    ["stopping", "unknown"],
    ["new-state", "unknown"],
] as const)("maps %s to %s", (state, expected) => expect(hostedStateOf(state)).toBe(expected));
