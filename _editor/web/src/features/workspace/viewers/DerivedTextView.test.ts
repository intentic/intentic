// @vitest-environment jsdom
// What a reader actually sees of a file's shadow: the text, and the three things that make it trustworthy — which
// reader made it, what it had to cut, and whether the file has moved on since. Asserted in the DOM, since "shown
// with the text" rather than "carried in the response" is the whole point of this surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { WorkspaceDerived } from "@intentic/sandbox-contract";

// The daemon seam, stubbed: `read` is what opening the file answers, `derive` what the button asks for.
const answers: { read: WorkspaceDerived; derive?: WorkspaceDerived } = {
    read: { present: false, path: `bundle.zip`, derivable: true },
};
const derived = vi.fn();
vi.mock("../files/derivedText", () => ({
    readDerivedText: () => Promise.resolve(answers.read),
    deriveText: (path: string) => {
        derived(path);
        return Promise.resolve(answers.derive ?? answers.read);
    },
}));
// Live-change epoch: a store in the app, a constant here, so the watch fires once per mount.
vi.mock("../changes/useWorkspaceLive", () => ({ changeEpochOf: () => 0 }));

const { default: DerivedTextView } = await import("./DerivedTextView.vue");

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
    answers.read = { present: false, path: `bundle.zip`, derivable: true };
    answers.derive = undefined;
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

    it(`offers to render a derivable file nobody has read yet, and shows what comes back`, async () => {
        answers.derive = shadow({ path: `bundle.zip`, content: `- Archive: zip`, deriver: `archive+tar v1` });
        const element = mount({ path: `bundle.zip` });
        await settle();
        expect(element.textContent).toContain(`Nothing has read this file yet`);
        const button = [...element.querySelectorAll(`button`)].find((node) => node.textContent?.includes(`Render as text`));
        button?.click();
        await settle();
        expect(derived).toHaveBeenCalledWith(`bundle.zip`);
        expect(element.textContent).toContain(`Archive: zip`);
    });

    it(`offers the bytes, and no rendering, for a format nothing can read`, async () => {
        answers.read = { present: false, path: `tool.exe`, derivable: false };
        const element = mount({ path: `tool.exe`, downloadable: true });
        await settle();
        const labels = [...element.querySelectorAll(`button`)].map((node) => node.textContent?.trim());
        expect(labels.some((label) => label?.includes(`Render as text`))).toBe(false);
        expect(labels.some((label) => label?.includes(`Download`))).toBe(true);
    });
});
