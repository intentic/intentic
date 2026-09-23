import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { advanceTimersByTimeAsync, waitFor } from "@intentic/testing/bun";
import { type Caller, createIndicator, IDLE_MS, PAUSE_HOTKEY } from "./indicator.js";
import { ScopeError } from "./policy.js";
import { fakeIndicatorDeps } from "./testing.js";

/* The notice's state machine against a fake helper and a fake clock: when it opens, what it says, when it goes, and the
   pause the person at the machine holds. The helper's window itself is desktop-automation's, and a person's to judge. */

const said: string[] = [];
const link = (host: string): Caller => ({ sandboxUrl: `https://${host}`, log: (message) => void said.push(message) });
const ALPHA = link("alpha.example.dev");
const BETA = link("beta.example.dev");

const DRIVING = `Intentic agent is controlling this computer · alpha.example.dev · ${PAUSE_HOTKEY} pauses`;
const PAUSED = `Intentic agent paused · alpha.example.dev · ${PAUSE_HOTKEY} resumes`;

beforeEach(() => {
    jest.useFakeTimers();
    said.length = 0;
});
afterEach(() => jest.useRealTimers());

test("the first action opens the notice, naming the sandbox driving and the keys that pause it", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(ALPHA);
    expect(fake.helpers).toHaveLength(1);
    expect(fake.helpers[0]?.shown).toEqual([DRIVING]);
});

test("an action restarts the countdown, and IDLE_MS after the last one the helper is closed, not just hidden", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(ALPHA);
    await advanceTimersByTimeAsync(IDLE_MS - 1_000);
    await indicator.control(ALPHA);
    await advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(fake.helpers.map((helper) => helper.closed)).toEqual([false]);
    await advanceTimersByTimeAsync(1);
    expect(fake.helpers.map((helper) => helper.closed)).toEqual([true]);

    // The next session gets a helper of its own.
    await indicator.control(ALPHA);
    expect(fake.helpers.map((helper) => helper.closed)).toEqual([true, false]);
    expect(fake.helpers[1]?.shown).toEqual([DRIVING]);
});

test("a link that disconnects takes the notice down at once; one still driving keeps it up under its own name", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(ALPHA);
    await indicator.control(BETA);
    expect(fake.helpers[0]?.shown.at(-1)).toBe(`Intentic agent is controlling this computer · beta.example.dev · ${PAUSE_HOTKEY} pauses`);

    // A link that never drove anything leaving changes nothing.
    indicator.release("https://gamma.example.dev");
    indicator.release(BETA.sandboxUrl);
    expect(fake.helpers[0]?.closed).toBe(false);
    expect(fake.helpers[0]?.shown.at(-1)).toBe(DRIVING);

    indicator.release(ALPHA.sandboxUrl);
    expect(fake.helpers[0]?.closed).toBe(true);

    // The countdowns went with the links: a new session is not cut short by the old one's.
    await indicator.control(ALPHA);
    await advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(fake.helpers.map((helper) => helper.closed)).toEqual([true, false]);
});

test("with two links driving, the notice names whichever acted last", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(ALPHA);
    await indicator.control(BETA);
    await indicator.control(ALPHA);
    expect(fake.helpers[0]?.shown).toEqual([
        DRIVING,
        `Intentic agent is controlling this computer · beta.example.dev · ${PAUSE_HOTKEY} pauses`,
        DRIVING,
    ]);
});

test("the hotkey pauses every action, in the person's words, on the notice, on disk and in the audit log; again resumes", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(ALPHA);

    fake.helpers[0]?.events.hotkey();
    expect(fake.helpers[0]?.shown.at(-1)).toBe(PAUSED);
    const refusal = await indicator.control(ALPHA).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ScopeError);
    expect((refusal as ScopeError).message).toBe(
        `Refused: paused by the person at this computer: they pressed ${PAUSE_HOTKEY}, which stops agents from using its mouse and keyboard until they press it again. Tell the user; do not look for another way to do this on the screen.`,
    );
    await waitFor(() => expect(fake.saved()).toBe(true));

    fake.helpers[0]?.events.hotkey();
    await expect(indicator.control(ALPHA)).resolves.toBeUndefined();
    expect(fake.helpers[0]?.shown.at(-1)).toBe(DRIVING);
    await waitFor(() => expect(fake.saved()).toBe(false));
    expect(fake.audited).toEqual([
        { tool: "local-pause", ok: true, detail: `paused by the person at this computer (${PAUSE_HOTKEY})` },
        { tool: "local-pause", ok: true, detail: `resumed by the person at this computer (${PAUSE_HOTKEY})` },
    ]);
    expect(said).toEqual([`paused by the person at this computer (${PAUSE_HOTKEY})`, `resumed by the person at this computer (${PAUSE_HOTKEY})`]);
    // One helper throughout: pausing is a change of words, not of window.
    expect(fake.helpers).toHaveLength(1);
});

// A sandbox can restart this agent; a pause that a restart lifted would be one the agent could lift.
test("a pause read back at start refuses from the first action, and that attempt puts up the notice that can lift it", async () => {
    const fake = fakeIndicatorDeps({ paused: true });
    const indicator = createIndicator(fake.deps);
    await expect(indicator.control(ALPHA)).rejects.toThrow(ScopeError);
    expect(fake.helpers[0]?.shown).toEqual([PAUSED]);

    fake.helpers[0]?.events.hotkey();
    await expect(indicator.control(ALPHA)).resolves.toBeUndefined();
});

test("a paused machine still takes its notice down when the links go quiet", async () => {
    const fake = fakeIndicatorDeps({ paused: true });
    const indicator = createIndicator(fake.deps);
    await expect(indicator.control(ALPHA)).rejects.toThrow(ScopeError);
    await advanceTimersByTimeAsync(IDLE_MS);
    expect(fake.helpers[0]?.closed).toBe(true);
    // Still paused: the notice's going is not the pause's.
    await expect(indicator.control(ALPHA)).rejects.toThrow(ScopeError);
    expect(fake.helpers[1]?.shown).toEqual([PAUSED]);
});

test("a helper that dies by itself is not respawned while the links keep acting; the next session tries again", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(ALPHA);
    fake.helpers[0]?.events.exited("Windows would not keep the notice out of screen captures (error 5).");
    await indicator.control(ALPHA);
    expect(fake.helpers).toHaveLength(1);
    expect(said).toEqual(["the on-screen notice stopped: Windows would not keep the notice out of screen captures (error 5)."]);

    await advanceTimersByTimeAsync(IDLE_MS);
    await indicator.control(ALPHA);
    expect(fake.helpers).toHaveLength(2);
    expect(fake.helpers[1]?.shown).toEqual([DRIVING]);
});

test("a helper that cannot start costs the notice, never the action", async () => {
    const fake = fakeIndicatorDeps();
    let attempts = 0;
    const indicator = createIndicator({
        ...fake.deps,
        open: () => {
            attempts += 1;
            throw new Error("spawn EINVAL");
        },
    });
    await expect(indicator.control(ALPHA)).resolves.toBeUndefined();
    await expect(indicator.control(ALPHA)).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    expect(said).toEqual(["the on-screen notice could not open: spawn EINVAL"]);
});

test("keys another program holds are not advertised on the notice", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(ALPHA);
    fake.helpers[0]?.events.hotkeyTaken();
    expect(fake.helpers[0]?.shown.at(-1)).toBe("Intentic agent is controlling this computer · alpha.example.dev");
    expect(said).toEqual([`${PAUSE_HOTKEY} is held by another program, so it cannot pause agents here until that program lets go of it.`]);
});

test("an action that arrived over no link is shown without a name", async () => {
    const fake = fakeIndicatorDeps();
    const indicator = createIndicator(fake.deps);
    await indicator.control(undefined);
    expect(fake.helpers[0]?.shown).toEqual([`Intentic agent is controlling this computer · ${PAUSE_HOTKEY} pauses`]);
});

// Every platform but Windows: desktop-automation has no notice to open there.
test("with no notice to open, actions go through and nothing is left counting down", async () => {
    const fake = fakeIndicatorDeps({ notices: false });
    const indicator = createIndicator(fake.deps);
    await expect(indicator.control(ALPHA)).resolves.toBeUndefined();
    expect(fake.helpers).toEqual([]);
    await advanceTimersByTimeAsync(IDLE_MS);
    expect(jest.getTimerCount()).toBe(0);
});
