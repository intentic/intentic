import { join } from "node:path";
import { homeDir } from "@intentic/local-agent";
import { CUTOVER_HOLDS_MS, cutoverUnderway, icHome, parseSwapRecord, slugOfRecord, swapsUnderway } from "./swap-records.js";

/* What ic's channel record says about a swap, read the way ic itself reads the file. */

const NOW = 1_800_000_000_000;

test("a record's swap keys are read as ic writes them, and the rest of the file is ignored", () => {
    const text = ["channel=stable", "current=img:1", "swap_phase=cutover", `swap_at=${NOW - 1_000}`, "desired_memory=12", ""].join("\n");
    expect(parseSwapRecord("work", text)).toEqual({ slug: "work", phase: "cutover", at: NOW - 1_000, probationUntil: undefined });
});

// ic's own rules: last occurrence wins, CRLF is a line ending, a line with no `=` is nothing.
test("the last occurrence of a key wins, and a torn or foreign line is skipped", () => {
    const text = `swap_phase=cutover\r\nswap_phase=probation\r\ngarbage\r\nprobation_until=${NOW}\r\nswap_at=soon\r\n`;
    expect(parseSwapRecord("work", text)).toEqual({ slug: "work", phase: "probation", at: undefined, probationUntil: NOW });
});

test("a record with no swap in it names no phase", () => {
    expect(parseSwapRecord("work", "channel=stable\nswap_phase=\n").phase).toBeUndefined();
});

test("only ic's own record files name a slug", () => {
    expect(slugOfRecord("sandbox-work.channel")).toBe("work");
    // ic names a sandbox with a public hostname by that hostname's first label, which itself starts `sandbox-`.
    expect(slugOfRecord("sandbox-sandbox-0123456789ab.channel")).toBe("sandbox-0123456789ab");
    expect(slugOfRecord("sandbox-.channel")).toBeUndefined();
    expect(slugOfRecord("sandbox-work.channel.tmp")).toBeUndefined();
    expect(slugOfRecord("backups")).toBeUndefined();
});

// A cutover is believed for half an hour either side of now: past that it is an interruption for the watch to settle,
// and a stamp from the future is a clock that moved, not a swap that has not started.
test("a cutover holds for exactly the window, and only a cutover holds", () => {
    const cutover = (at: number | undefined) => ({ slug: "work", phase: "cutover", at });
    expect(cutoverUnderway(cutover(NOW - CUTOVER_HOLDS_MS + 1), NOW)).toBe(true);
    expect(cutoverUnderway(cutover(NOW - CUTOVER_HOLDS_MS), NOW)).toBe(false);
    expect(cutoverUnderway(cutover(NOW + CUTOVER_HOLDS_MS - 1), NOW)).toBe(true);
    expect(cutoverUnderway(cutover(undefined), NOW)).toBe(false);
    expect(cutoverUnderway({ slug: "work", phase: "probation", at: NOW }, NOW)).toBe(false);
});

test("the swaps underway are the fresh cutovers, by slug", () => {
    const records = [
        { slug: "fresh", phase: "cutover", at: NOW - 60_000 },
        { slug: "stale", phase: "cutover", at: NOW - 2 * CUTOVER_HOLDS_MS },
        { slug: "proving", phase: "probation", at: NOW - 60_000 },
    ];
    expect(swapsUnderway(records, NOW)).toEqual(["fresh"]);
});

test("ic's home is INTENTIC_HOME when set, else .intentic under this agent's home", () => {
    expect(icHome({ INTENTIC_HOME: "/srv/ic" })).toBe("/srv/ic");
    expect(icHome({ INTENTIC_HOME: "" })).toBe(join(homeDir(), ".intentic"));
    expect(icHome({})).toBe(join(homeDir(), ".intentic"));
});
