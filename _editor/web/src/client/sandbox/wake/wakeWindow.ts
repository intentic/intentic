// THE WAKING WINDOW: the stretch after this browser asked the platform to wake the active sandbox (useSandbox.ts
// `wake`), during which the connection loop redials fast because the sandbox is expected back any second
// (useSandboxLiveness.ts, connection.ts `nextAttemptDelayMs`). It opens on a wake the platform accepted and closes when the
// stream proves itself with a frame, when the active sandbox changes away, when the loop is torn down, or once
// WAKE_FAST_RETRY_MS has passed. Its own module rather than state in useSandbox.ts so the loop can read it without a
// suite that replaces useSandbox having to know it exists (2026-10-19).

// As long as the diagnosis waits for a sandbox asleep on its own machine before handing the reader what they can do
// (diagnosis/diagnose.ts ASLEEP_WAKE_PATIENCE_MS, which this layer cannot import: client sits below features). Past it
// the computer is likely off, and the loop goes back to its ladder rather than dial a box that is not coming once a
// second for as long as the tab is open. wakeWindow.test.ts holds the two equal (2026-10-19).
export const WAKE_FAST_RETRY_MS = 3 * 60_000;

// When the platform first took a wake for the active sandbox in this wait, per sandbox id. A later ask in the same
// wait (useSandbox.ts asks again every minute it stays unreachable) leaves it where it is, so the window is bounded by the
// first ask and not renewed for as long as the sandbox stays away; only a frame, a switch away or a stop clears it.
const askedAt = new Map<string, number>();

export const openWakeWindow = (sandboxId: string, at: number): void => {
    if (!askedAt.has(sandboxId)) {
        askedAt.set(sandboxId, at);
    }
};

export const closeWakeWindow = (sandboxId: string): void => {
    askedAt.delete(sandboxId);
};

// Every window at once: the loop the windows speed up has stopped, and whatever it was waiting for is no longer watched.
export const closeAllWakeWindows = (): void => {
    askedAt.clear();
};

// Whether `sandboxId` is waking at `now`: a wake was taken for it in this wait, and not so long ago that it stopped
// being expected.
export const wakePendingFor = (sandboxId: string | undefined, now: number): boolean => {
    const at = sandboxId === undefined ? undefined : askedAt.get(sandboxId);
    return at !== undefined && now - at < WAKE_FAST_RETRY_MS;
};
