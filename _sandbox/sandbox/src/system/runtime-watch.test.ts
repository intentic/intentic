import type { RuntimeDomain } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { createRuntimeSampler, paneFingerprint, publishRuntimeChange, type RuntimeProbes, subscribeRuntimeChanges } from "./runtime-watch.js";

/* The bus is module-level state (one daemon, one feed), so every test takes a subscription and gives it back:
 * the last unsubscribe resets the pending set, the rate-limit stamps and the sampler together, which is what
 * keeps these order-independent. */

const frames: RuntimeDomain[][] = [];
const listen = (): (() => void) => {
    frames.length = 0;
    return subscribeRuntimeChanges((domains) => frames.push(domains));
};

// Probes the test drives by hand: each returns whatever the test last set.
const fakeProbes = (): RuntimeProbes & { set: (key: "terminals" | "ports", value: string) => void } => {
    const readings = new Map<string, string>([
        ["terminals", ""],
        ["ports", ""],
    ]);
    return {
        terminals: async () => readings.get("terminals") ?? "",
        ports: async () => readings.get("ports") ?? "",
        set: (key, value) => readings.set(key, value),
    };
};

afterEach(() => {
    vi.useRealTimers();
});

test("a publish reaches the stream on the next tick, and a burst arrives as one frame", async () => {
    const unsubscribe = listen();
    publishRuntimeChange("panels");
    publishRuntimeChange("terminals");
    // Nothing has gone out yet: the coalescing window is what turns "started a panel" into one frame rather
    // than one per subsystem that noticed.
    expect(frames).toHaveLength(0);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]?.toSorted()).toEqual(["panels", "terminals"]);
    unsubscribe();
});

test("nothing is queued while no browser is connected", async () => {
    // No subscriber, so no one to be stale: a new connection re-asks every runtime-bound key anyway.
    publishRuntimeChange("browsers");
    const unsubscribe = listen();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toEqual([]);
    unsubscribe();
});

test("a chatty domain is rate-limited: the first change goes out at once, the rest coalesce", async () => {
    vi.useFakeTimers();
    const unsubscribe = listen();
    // A working subagent reports a tool use and a token count continuously. Every one of them publishes.
    publishRuntimeChange("subagents");
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toEqual([["subagents"]]);

    for (let i = 0; i < 50; i++) {
        publishRuntimeChange("subagents");
    }
    await vi.advanceTimersByTimeAsync(100);
    // Still one frame: fifty mutations inside the window cost the browsers nothing extra.
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(frames).toEqual([["subagents"], ["subagents"]]);
    unsubscribe();
});

test("a discrete domain is not held up behind a chatty one's window", async () => {
    vi.useFakeTimers();
    const unsubscribe = listen();
    publishRuntimeChange("subagents");
    await vi.advanceTimersByTimeAsync(1);
    frames.length = 0;

    // subagents is now inside its 2s window. A panel starting must NOT wait it out: a click that feels as slow
    // as the chattiest thing in the sandbox is the failure this pull-the-timer-earlier rule exists to prevent.
    publishRuntimeChange("subagents", "panels");
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toEqual([["panels"]]);
    unsubscribe();
});

test("the sampler publishes only what changed, and never on its first reading", async () => {
    const unsubscribe = listen();
    const probes = fakeProbes();
    const sampler = createRuntimeSampler(probes, 60_000);

    // The baseline is not a change: the browser that just connected has already re-asked everything.
    await sampler.sample();
    expect(frames).toEqual([]);

    probes.set("terminals", "web-a\t0\t\t1");
    await sampler.sample();
    await vi.waitFor(() => expect(frames).toEqual([["terminals"]]));

    // A second identical reading says nothing: an idle sandbox with a tab open pushes nothing at all.
    await sampler.sample();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toEqual([["terminals"]]);
    unsubscribe();
});

/* THE FINGERPRINT, and the regression it exists for. A command ending in a shell is a change that NOTHING else
 * in a tmux reading records: the pane lives either way, its exit status is tmux's rather than the command's,
 * and the activity stamp stops moving at the moment the prompt is drawn. A fingerprint without the foreground
 * command in it therefore read the shell as identical before and after, and the panel's busy dot stayed lit
 * until the coarse activity bucket happened to roll under it. */
const ACTIVITY = 1_780_000_000;
const shellPane = (command: string, activity = ACTIVITY): string => `web-a1b2c3d4\t0\t\t${activity}\t${command}`;

test("a command finishing moves the fingerprint, with every other field standing still", () => {
    expect(paneFingerprint(shellPane("pnpm"))).not.toBe(paneFingerprint(shellPane("zsh")));
});

test("a running command's churn does not: busy is a flag, not the word", () => {
    // A build's foreground process walks `pnpm` → `node` → `git` and back. Pushing on each would bill every
    // connected browser a list read a second for a dot that is already lit.
    expect(paneFingerprint(shellPane("node"))).toBe(paneFingerprint(shellPane("git")));
});

test("a new listening port refreshes the panels above it as well as the ports view", async () => {
    const unsubscribe = listen();
    const probes = fakeProbes();
    const sampler = createRuntimeSampler(probes, 60_000);
    await sampler.sample();

    // A dev server binding its port IS the panel turning healthy: panel health is read off the sockets.
    probes.set("ports", "1F90");
    await sampler.sample();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]?.toSorted()).toEqual(["panels", "ports"]);
    unsubscribe();
});
