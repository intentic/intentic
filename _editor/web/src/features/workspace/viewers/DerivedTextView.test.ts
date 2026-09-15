// @vitest-environment jsdom
// What a reader actually sees of a file's shadow: the text, and the three things that make it trustworthy — which
// reader made it, what it had to cut, and whether the file has moved on since. Asserted in the DOM, since "shown
// with the text" rather than "carried in the response" is the whole point of this surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { WorkspaceDerived } from "@intentic/sandbox-contract";

// A stopped background pass, which is what the daemon reports when nothing is rendering.
const STOPPED = { enabled: false, queued: 0, deriving: [], sweeping: false, broken: false };
// The daemon seam, stubbed: `read` is what opening the file answers, `derive` what asking for it now answers. `hold`
// keeps a call unanswered, which is the only way to assert what the pane shows while it waits.
// The cache module next door is NOT stubbed: what this tab already read, and whether a file version has had a
// derivation asked for it, are two of the things under test here.
const answers: { read: WorkspaceDerived; derive?: WorkspaceDerived; hold?: boolean } = {
    read: { present: false, path: `bundle.zip`, derivable: true, state: `off`, queue: STOPPED },
};
const derived = vi.fn();
let release: ((value: WorkspaceDerived) => void) | undefined;
const answer = (value: WorkspaceDerived): Promise<WorkspaceDerived> =>
    answers.hold === true
        ? new Promise<WorkspaceDerived>((resolve) => {
              release = resolve;
          })
        : Promise.resolve(value);
vi.mock("../files/derivedText", () => ({
    readDerivedText: () => answer(answers.read),
    deriveText: (path: string) => {
        derived(path);
        return answer(answers.derive ?? answers.read);
    },
}));
// Live epochs: stores in the app, locals here. `changeEpochOf` is constant, so that watch fires once per mount;
// `derivedEpoch` is a real ref, since a plain field would not re-trigger the watch and the test would pass on a
// component that never re-reads — which is the bug being covered.
const derivedEpoch = ref(0);
vi.mock("../changes/useWorkspaceLive", () => ({
    changeEpochOf: () => 0,
    derivedEpochOf: () => derivedEpoch.value,
    sidecarQueue: { value: undefined },
}));

const { default: DerivedTextView } = await import("./DerivedTextView.vue");
// The real cache, not a stand-in: seeding it is how a test says "this tab has read that file before", and its
// once-per-version rule is what stops a pane that re-reads from deriving the same file again.
const { forgetDerivedText, rememberDerived } = await import("../files/derivedCache");

const shadow = (over: Partial<Extract<WorkspaceDerived, { present: true }>> = {}): WorkspaceDerived => ({
    present: true,
    path: `docs/spec.docx`,
    content: `# Quarterly plan\n\nShip the derivers.`,
    deriver: `docx v1`,
    derivedAt: new Date().toISOString(),
    notes: [],
    tokens: 1200,
    truncated: false,
    stale: false,
    state: `idle`,
    queue: STOPPED,
    ...over,
});

// A file with no text yet, at whichever point of the queue the test is about.
const nothing = (over: Partial<Extract<WorkspaceDerived, { present: false }>> = {}): WorkspaceDerived => ({
    present: false,
    path: `bundle.zip`,
    derivable: true,
    state: `off`,
    queue: STOPPED,
    ...over,
});

let app: App | undefined;
const mount = (props: { path: string; downloadable?: boolean }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(DerivedTextView, props) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// The read resolves on the microtask queue; two ticks let the render that follows it land.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

beforeEach(() => {
    derived.mockClear();
    derivedEpoch.value = 0;
    answers.read = nothing();
    answers.derive = undefined;
    answers.hold = false;
    release = undefined;
    forgetDerivedText();
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`DerivedTextView`, () => {
    it(`shows the text under the provenance of what made it`, async () => {
        answers.read = shadow();
        const element = mount({ path: `docs/spec.docx` });
        await settle();
        expect(element.textContent).toContain(`Derived text`);
        expect(element.textContent).toContain(`docx v1`);
        expect(element.textContent).toContain(`Quarterly plan`);
        expect(element.textContent).toContain(`Ship the derivers.`);
    });

    // Reopening a file whose text exists used to blank the pane and spin until the daemon answered, which reads as the
    // file being derived all over again. It is not: a shadow is keyed by the source's content hash and reused.
    it(`paints the text this tab already read before the daemon answers again`, async () => {
        rememberDerived(`docs/spec.docx`, shadow());
        answers.hold = true;
        const element = mount({ path: `docs/spec.docx` });
        await settle();
        expect(element.textContent).toContain(`Quarterly plan`);
        expect(element.querySelector(`[data-icon="spinner"]`)).toBeNull();
        // The read still lands, and still wins: a file that did change corrects itself behind the text it painted.
        release?.(shadow({ content: `# Quarterly plan\n\nShip the viewers.`, stale: true }));
        await settle();
        expect(element.textContent).toContain(`Ship the viewers.`);
        expect(element.textContent).toContain(`changed after its text was made`);
    });

    // A wait with no words on it is read as a failure, and this one can legitimately run for a minute on a scan.
    it(`says what a derivation is doing, and how long it has been doing it`, async () => {
        const element = mount({ path: `scans/contract.pdf` });
        await settle();
        answers.hold = true;
        const button = [...element.querySelectorAll(`button`)].find((node) => node.textContent?.includes(`Render as text`));
        button?.click();
        await settle();
        expect(element.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
        expect(element.textContent).toContain(`Reading this file and writing its text`);
        expect(element.textContent).toContain(`recognised a page at a time`);
        // Never the thing that does not happen: fileq reads a recording's duration and tags, it does not transcribe it.
        expect(element.textContent).not.toContain(`transcrib`);
        expect(element.textContent).toContain(`0s`);
        release?.(shadow({ path: `scans/contract.pdf`, content: `# Contract` }));
        await settle();
        expect(element.textContent).toContain(`Contract`);
    });

    it(`shows every cap the derivation hit, so cut text cannot read as the whole document`, async () => {
        answers.read = shadow({ notes: [`sheet "Orders": showing 200 of 4,000 rows`] });
        const element = mount({ path: `books/orders.xlsx` });
        await settle();
        expect(element.textContent).toContain(`showing 200 of 4,000 rows`);
    });

    it(`says so when the file changed after its text was made`, async () => {
        answers.read = shadow({ stale: true });
        const element = mount({ path: `docs/spec.docx` });
        await settle();
        expect(element.textContent).toContain(`changed after its text was made`);
    });

    // Opening the file IS the request. This used to stop at an empty pane with a button on it, which asked a reader
    // who had already said what they wanted to say it again — for work that takes a few hundred milliseconds.
    it(`reads a file nobody has read yet on open, rather than asking to be told to`, async () => {
        answers.derive = shadow({ path: `bundle.zip`, content: `- Archive: zip`, deriver: `archive+tar v1` });
        const element = mount({ path: `bundle.zip` });
        await settle();
        expect(derived).toHaveBeenCalledWith(`bundle.zip`);
        expect(element.textContent).toContain(`Archive: zip`);
        expect(element.textContent).not.toContain(`Nothing has read this file yet`);
    });

    // The one case that must not derive itself: a second child process for a file the background pass is already
    // holding would compete with the one doing the work. The wait says so, and the button is there to jump the queue.
    it(`leaves a file the background pass already has to the pass`, async () => {
        answers.read = nothing({
            path: `bundle.zip`,
            state: `queued`,
            queue: { enabled: true, queued: 2, deriving: [], sweeping: false, broken: false },
        });
        const element = mount({ path: `bundle.zip` });
        await settle();
        expect(derived).not.toHaveBeenCalled();
        expect(element.textContent).toContain(`in line to be read`);
        const labels = [...element.querySelectorAll(`button`)].map((node) => node.textContent?.trim());
        expect(labels.some((label) => label?.includes(`Read it now`))).toBe(true);
    });

    // The other half of that rule: a sweep converges the whole tree, so "queued" behind one is a wait of minutes for
    // a file a person is looking at right now. That one is worth its own child process.
    it(`does not make a reader wait behind a whole-tree sweep`, async () => {
        answers.read = nothing({
            path: `bundle.zip`,
            state: `queued`,
            queue: { enabled: true, queued: 400, deriving: [], sweeping: true, broken: false },
        });
        answers.derive = shadow({ path: `bundle.zip`, content: `- Archive: zip`, deriver: `archive+tar v1` });
        const element = mount({ path: `bundle.zip` });
        await settle();
        expect(derived).toHaveBeenCalledWith(`bundle.zip`);
        expect(element.textContent).toContain(`Archive: zip`);
    });

    // A file that renders to nothing answers once. The pane re-reads on every sweep and every shadow that lands, and
    // each of those would otherwise spawn the same fruitless work again.
    it(`asks for one version of a file to be read exactly once`, async () => {
        answers.derive = nothing({ path: `tool.bin`, reason: `unsupported` });
        const element = mount({ path: `tool.bin` });
        await settle();
        expect(derived).toHaveBeenCalledTimes(1);
        answers.read = nothing({ path: `tool.bin`, reason: `unsupported` });
        derivedEpoch.value = 1;
        await settle();
        expect(derived).toHaveBeenCalledTimes(1);
        // And says what happened, rather than claiming nothing has read a file this pane just had read.
        expect(element.textContent).toContain(`no text came out of it`);
        expect(element.textContent).toContain(`unsupported`);
    });

    it(`picks up text that landed in the background, without the file itself having changed`, async () => {
        // Queued, so the pane is waiting on the pass rather than reading the file itself: this is about the frame
        // that tells it the wait is over.
        answers.read = nothing({ path: `bundle.zip`, state: `queued`, queue: { enabled: true, queued: 1, deriving: [], sweeping: false, broken: false } });
        const element = mount({ path: `bundle.zip` });
        await settle();
        expect(element.textContent).toContain(`in line to be read`);
        // What a `derivedChanged` frame does: the shadow is rewritten where the watcher does not look, so the source
        // file's own epoch never moves. Before this trigger existed, the pane sat on the empty state indefinitely.
        answers.read = shadow({ path: `bundle.zip`, content: `- Archive: zip`, deriver: `archive+tar v1` });
        derivedEpoch.value = 1;
        await settle();
        expect(element.textContent).toContain(`Archive: zip`);
        expect(derived).not.toHaveBeenCalled();
    });

    it(`says a queued file is waiting, and does not tell the reader to switch on what is already on`, async () => {
        answers.read = nothing({
            path: `docs/spec.docx`,
            state: `queued`,
            queue: { enabled: true, queued: 3, deriving: [`other.pdf`], sweeping: false, broken: false },
        });
        const element = mount({ path: `docs/spec.docx` });
        await settle();
        expect(element.textContent).toContain(`in line to be read`);
        expect(element.textContent).toContain(`2 other files ahead`);
        // The old copy pointed at Settings whatever the setting said, which is what made it misleading.
        expect(element.textContent).not.toContain(`Settings → Agent`);
        expect(element.textContent).not.toContain(`Nothing has read this file yet`);
    });

    it(`points at the setting only where turning it on is the answer`, async () => {
        answers.read = nothing({ path: `docs/spec.docx`, state: `off` });
        const element = mount({ path: `docs/spec.docx` });
        await settle();
        expect(element.textContent).toContain(`Settings → Agent`);
    });

    it(`blames the sandbox, not the file, when the renderer is missing, and offers nothing that would fail`, async () => {
        answers.read = nothing({
            path: `docs/spec.docx`,
            derivable: false,
            state: `broken`,
            queue: { enabled: true, queued: 0, deriving: [], sweeping: false, broken: true },
        });
        const element = mount({ path: `docs/spec.docx`, downloadable: true });
        await settle();
        expect(element.textContent).toContain(`no renderer installed`);
        const labels = [...element.querySelectorAll(`button`)].map((node) => node.textContent?.trim());
        expect(labels.some((label) => label?.includes(`Render as text`))).toBe(false);
    });

    it(`offers the bytes, and no rendering, for a format nothing can read`, async () => {
        answers.read = nothing({ path: `tool.exe`, derivable: false, state: `undeliverable` });
        const element = mount({ path: `tool.exe`, downloadable: true });
        await settle();
        const labels = [...element.querySelectorAll(`button`)].map((node) => node.textContent?.trim());
        expect(labels.some((label) => label?.includes(`Render as text`))).toBe(false);
        expect(labels.some((label) => label?.includes(`Download`))).toBe(true);
    });
});
