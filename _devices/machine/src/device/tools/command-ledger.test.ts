import { startTimeOf, stillLeftOver } from "./command-ledger.js";

/* Which recorded command groups the next agent ends: only the ones still provably what the dead agent left. */

// A real /proc/<pid>/stat line, with a command name that holds spaces and a parenthesis of its own.
const STAT = "4242 (sh -c (x)) S 1 4242 4242 0 -1 4194560 120 0 0 0 0 0 0 0 20 0 1 0 987654 2412544 211 18446744073709551615";

test("the start time is the 22nd field, counted after the command name however it is spelled", () => {
    expect(startTimeOf(STAT)).toBe("987654");
    expect(startTimeOf("")).toBeUndefined();
});

test("a live leader is the recorded one only with the recorded start time; a number given to another is left alone", () => {
    const group = { pgid: 4242, started: "987654" };
    expect(stillLeftOver(group, "987654", true)).toBe(true);
    expect(stillLeftOver(group, "999999", true)).toBe(false);
});

// The kernel never gives a group's number to a new process while anything still answers to the group, so with its
// leader gone, a group that answers is still the dead agent's; one that does not is nothing to end.
test("with its leader gone, a group is ended only while something still answers to it", () => {
    const group = { pgid: 4242, started: "987654" };
    expect(stillLeftOver(group, undefined, true)).toBe(true);
    expect(stillLeftOver(group, undefined, false)).toBe(false);
});
