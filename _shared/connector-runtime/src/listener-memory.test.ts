import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { chatRings, recentKeys, typingHeartbeat } from "./listener-memory.js";

// Pins the memory contract shared by every listener; each listener's own tests cover its wiring.

test("a recent key is a duplicate the second time, and the oldest is forgotten past the cap", () => {
    const recent = recentKeys(3);
    expect(recent.duplicate("a")).toBe(false);
    expect(recent.duplicate("a")).toBe(true);
    recent.duplicate("b");
    recent.duplicate("c");
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
    // of() returns a copy; mutating it changes nothing remembered.
    rings.of("x").push("nope");
    expect(rings.of("x")).toEqual(["2", "3"]);
    rings.remember("y", "1");
    // A push re-inserts its chat into recency order.
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
    // Restarting is a continuation: no "paused" fires in between.
    heartbeat.start("room", () => sent.push("typing"), () => sent.push("paused"));
    expect(sent.at(-1)).toBe("typing");
    expect(sent).not.toContain("paused");
    heartbeat.stop("room");
    expect(sent.at(-1)).toBe("paused");
    // Stopping an already-stopped room is a no-op.
    const before = sent.length;
    heartbeat.stop("room");
    vi.advanceTimersByTime(5_000);
    expect(sent.length).toBe(before);
    // maxMs cap: an indicator with no reply stops itself, closing word included.
    heartbeat.start("late", () => sent.push("late"), () => sent.push("late-paused"));
    vi.advanceTimersByTime(10_000);
    expect(sent.filter((entry) => entry === "late").length).toBeLessThanOrEqual(5);
    expect(sent.at(-1)).toBe("late-paused");
    // stopAll drops every heartbeat without a closing word.
    heartbeat.start("a", () => sent.push("a"), () => sent.push("a-paused"));
    heartbeat.start("b", () => sent.push("b"), () => sent.push("b-paused"));
    heartbeat.stopAll();
    const after = sent.length;
    vi.advanceTimersByTime(5_000);
    expect(sent.length).toBe(after);
    expect(sent).not.toContain("a-paused");
});
