// The signal that a file's text landed. Shadows are written under the state directory the watcher ignores on purpose,
// so a workspace change can never stand in for this — which is why it is its own epoch rather than a reuse of the
// file's own, and why a viewer that watched only the file sat on an empty pane forever.
import { beforeEach, expect, it } from "vitest";
import { changeEpochOf, derivedEpochOf, markDerivedChanged, resetWorkspaceLive, sidecarQueue } from "./useWorkspaceLive";

const IDLE = { enabled: true, queued: 0, deriving: [], sweeping: false, broken: false };

beforeEach(() => {
    resetWorkspaceLive();
});

it(`moves only the paths a run names, so an unrelated file re-reads nothing`, () => {
    const before = derivedEpochOf(`docs/spec.docx`);
    markDerivedChanged([`docs/spec.docx`], IDLE);
    expect(derivedEpochOf(`docs/spec.docx`)).not.toBe(before);
    expect(derivedEpochOf(`other/photo.png`)).toBe(0);
});

it(`leaves the file's own change epoch alone: its text moved, the file did not`, () => {
    markDerivedChanged([`docs/spec.docx`], IDLE);
    expect(changeEpochOf(`docs/spec.docx`)).toBe(0);
});

it(`moves every path at once for a sweep, which rewrites what it found and does not report which`, () => {
    const untouched = derivedEpochOf(`never/named.pdf`);
    markDerivedChanged([], IDLE);
    expect(derivedEpochOf(`never/named.pdf`)).not.toBe(untouched);
});

it(`carries the queue's own state, since a wait has no file to be read off`, () => {
    markDerivedChanged([], { ...IDLE, queued: 4, sweeping: true, shadows: 87 });
    expect(sidecarQueue.value).toMatchObject({ queued: 4, sweeping: true, shadows: 87 });
});

it(`drops it all on switching sandboxes, where the same path is a different file`, () => {
    markDerivedChanged([`docs/spec.docx`], IDLE);
    resetWorkspaceLive();
    expect(derivedEpochOf(`docs/spec.docx`)).toBe(0);
    expect(sidecarQueue.value).toBeUndefined();
});
