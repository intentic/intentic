import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { chatRings, recentKeys, typingHeartbeat } from "./listener-memory.js";

// One suite for the memory that used to be written four times, once per connector: what each bound promises
// is pinned here, and the listeners' own tests cover the wiring.

test("a recent key is a duplicate the second time, and the oldest is forgotten past the cap", () => {
    const recent = recentKeys(3);
    expect(recent.duplicate("a")).toBe(false);
    expect(recent.duplicate("a")).toBe(true);
    recent.duplicate("b");
    recent.duplicate("c");
    // "a" is the oldest of four: evicted, so its next delivery reads as new again (the documented worst case,
    // one duplicate wake, rather than an unbounded set).
    recent.duplicate("d");
    expect(recent.duplicate("a")).toBe(false);
    expect(recent.duplicate("d")).toBe(true);
});

test("a chat ring keeps the newest entries per chat, and the quietest chat goes first past the cap", () => {
    const rings = chatRings<string>({ perChat: 2, chats: 2 });
    rings.remember("x", "1");
    rings.remember("x", "2");
    rings.remember("x", "3");
    expect(rings.of("x")).toEqual(["2", "3"]);
    // The copy is the caller's: mutating it changes nothing remembered.
    rings.of("x").push("nope");
    expect(rings.of("x")).toEqual(["2", "3"]);
    rings.remember("y", "1");
    // A push re-inserts its chat, so "x" is the recent one and "y" the quietest when a third chat arrives.
    rings.remember("x", "4");
    rings.remember("z", "1");
    expect(rings.of("y")).toEqual([]);
    expect(rings.of("x")).toEqual(["3", "4"]);
    expect(rings.of("z")).toEqual(["1"]);
});

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

test("the typing heartbeat re-sends on its cadence, stops with a closing word, and never outlives its cap", () => {
    const heartbeat = typingHeartbeat({ intervalMs: 1_000, maxMs: 3_500 });
    const sent: string[] = [];
    heartbeat.start("room", () => sent.push("typing"), () => sent.push("paused"));
    expect(sent).toEqual(["typing"]);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual(["typing", "typing", "typing"]);
    // A restart is a continuation: the indicator is re-sent, and nothing says "paused" in between.
    heartbeat.start("room", () => sent.push("typing"), () => sent.push("paused"));
    expect(sent.at(-1)).toBe("typing");
    expect(sent).not.toContain("paused");
    heartbeat.stop("room");
    expect(sent.at(-1)).toBe("paused");
    // Stopping a room that is not typing says nothing, and a stopped heartbeat sends nothing more.
    const before = sent.length;
    heartbeat.stop("room");
    vi.advanceTimersByTime(5_000);
    expect(sent.length).toBe(before);
    // The cap: a turn that never replies stops the indicator on its own, with the closing word.
    heartbeat.start("late", () => sent.push("late"), () => sent.push("late-paused"));
    vi.advanceTimersByTime(10_000);
    expect(sent.filter((entry) => entry === "late").length).toBeLessThanOrEqual(5);
    expect(sent.at(-1)).toBe("late-paused");
    // Shutdown drops every heartbeat without a closing word: the connection it would ride is going too.
    heartbeat.start("a", () => sent.push("a"), () => sent.push("a-paused"));
    heartbeat.start("b", () => sent.push("b"), () => sent.push("b-paused"));
    heartbeat.stopAll();
    const after = sent.length;
    vi.advanceTimersByTime(5_000);
    expect(sent.length).toBe(after);
    expect(sent).not.toContain("a-paused");
});
