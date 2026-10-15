// The review in plain words: what the conversation made first, as documents to open, download or print where they are
// listed, then the names of whatever else it changed, folded away; nothing of git's own (branch, status letters, line
// counts) anywhere on it.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { LandResult } from "@intentic/sandbox-contract";
import type { AgentReviewFile, useAgentChanges } from "../useAgentChanges";

// The conversation's recorded documents as the daemon lists them (agents.documents), and its results' bytes
// (resultFiles.ts), so nothing here reaches a daemon.
const documents = jest.fn(async (_input: { id: string }, _options?: unknown): Promise<{ paths: string[] }> => ({ paths: [`pisma/odpowiedz.odt`, `pisma/zestawienie.pdf`] }));
jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: { agents: { documents } } }));
const read = jest.fn(async (_id: string, _path: string, _at?: string): Promise<Blob> => new Blob([`%PDF`], { type: `application/pdf` }));
const saved = jest.fn(async (_id: string, _path: string, _at?: string): Promise<void> => undefined);
jest.mock(`../../../workspace/viewers/results/resultFiles`, () => ({ readResult: read, saveResult: saved }));
const { default: PlainResultReview } = await import(`./PlainResultReview.vue`);

type Changes = Pick<ReturnType<typeof useAgentChanges>, `count` | `files` | `error` | `conflicts`>;

// The slice of the review state the plain review reads: the changed files by name, their count, and what went wrong.
const changesOf = (paths: readonly string[]): Changes => {
    const files = computed<readonly AgentReviewFile[]>(() =>
        paths.map((path) => ({
            repo: `root`,
            key: JSON.stringify([`root`, path]),
            label: path,
            blocked: undefined,
            change: { path, status: `modified`, additions: 4, deletions: 2, landed: false },
        })),
    );
    return {
        files,
        count: computed(() => files.value.length),
        error: computed((): string | undefined => undefined),
        conflicts: computed<LandResult[`conflicts`]>(() => undefined),
    };
};

let app: App | undefined;

const mount = async (changes: Changes): Promise<HTMLElement> => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(PlainResultReview, { agentId: `c1`, at: `box`, changes }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    await Promise.resolve();
    await nextTick();
    return element;
};

const labels = (element: HTMLElement): (string | null)[] => [...element.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`));

beforeEach(() => {
    documents.mockClear();
    read.mockClear();
    saved.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`PlainResultReview`, () => {
    it(`leads with the documents the conversation recorded, each to open, download and print`, async () => {
        const element = await mount(changesOf([`pisma/odpowiedz.odt`, `pisma/zestawienie.pdf`]));
        expect(documents.mock.calls[0]?.[0]).toEqual({ id: `c1` });
        expect(element.querySelector(`section section`)?.getAttribute(`aria-label`)).toBe(`Results`);
        expect(labels(element)).toEqual([
            `Open odpowiedz.odt, Text document (ODT)`,
            `Download odpowiedz.odt`,
            `Print odpowiedz.odt`,
            `Open zestawienie.pdf, PDF`,
            `Download zestawienie.pdf`,
            `Print zestawienie.pdf`,
        ]);
        element.querySelectorAll<HTMLButtonElement>(`button`)[1]?.click();
        await Promise.resolve();
        expect(saved.mock.calls).toEqual([[`c1`, `pisma/odpowiedz.odt`, `box`]]);
    });

    it(`opens a document over the review, since a reader in plain words reads it here`, async () => {
        const element = await mount(changesOf([]));
        element.querySelector<HTMLButtonElement>(`button`)?.click();
        await Promise.resolve();
        expect(read.mock.calls[0]?.slice(0, 2)).toEqual([`c1`, `pisma/odpowiedz.odt`]);
    });

    it(`names everything else it changed, folded away, without a document twice or anything of git's`, async () => {
        const element = await mount(changesOf([`pisma/odpowiedz.odt`, `notatki/plan.md`]));
        const others = element.querySelector(`details`);
        expect(others?.querySelector(`summary`)?.textContent).toBe(`1 other changed file`);
        expect([...(others?.querySelectorAll(`li`) ?? [])].map((item) => item.textContent)).toEqual([`notatki/plan.md`]);
        expect(element.textContent).not.toMatch(/agent\/|\+4|−2|-2\b/);
    });

    it(`says so in a sentence when the conversation made no document`, async () => {
        documents.mockImplementationOnce(async () => ({ paths: [] }));
        const element = await mount(changesOf([`notatki/plan.md`]));
        expect(element.textContent).toContain(`This conversation has no recorded documents yet.`);
    });
});
