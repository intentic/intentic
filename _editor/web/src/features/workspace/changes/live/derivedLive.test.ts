// The signal that a file's text landed. Renderings are written under the state directory the watcher ignores on purpose,
// so a workspace change can never stand in for this — which is why it is its own epoch rather than a reuse of the
// file's own, and why a viewer that watched only the file sat on an empty pane forever.
import { resetSandboxScope } from "@intentic/extension-api";
import { changeEpochOf, derivedEpochOf, markDerivedChanged } from "./useWorkspaceLive";

beforeEach(() => {
    resetSandboxScope();
});

it(`moves only the paths a run names, so an unrelated file re-reads nothing`, () => {
    const before = derivedEpochOf(`docs/spec.docx`);
    markDerivedChanged([`docs/spec.docx`]);
    expect(derivedEpochOf(`docs/spec.docx`)).not.toBe(before);
    expect(derivedEpochOf(`other/photo.png`)).toBe(0);
});

it(`leaves the file's own change epoch alone: its text moved, the file did not`, () => {
    markDerivedChanged([`docs/spec.docx`]);
    expect(changeEpochOf(`docs/spec.docx`)).toBe(0);
});

it(`drops it all on switching sandboxes, where the same path is a different file`, () => {
    markDerivedChanged([`docs/spec.docx`]);
    resetSandboxScope();
    expect(derivedEpochOf(`docs/spec.docx`)).toBe(0);
});
