// A link in the chat that a side view claims opens beside the section; every other link, and every modified click, is
// the browser's as before.
import "@intentic/testing/dom";
import { defineComponent, h } from "vue";

const { claimInText, openClaimedLinkFromEvent } = await import("./sideLinks");
const { registerSideView } = await import("./sideViews");
const { closeAllTabs, sideDocked, sideTabId, useSidePanel } = await import("./sideTabs");

const panel = useSidePanel();
const openedHome = jest.fn();

const disposables: { dispose: () => void }[] = [];
beforeAll(() => {
    disposables.push(
        registerSideView({
            id: `acme.ci/run`,
            owner: `acme.ci`,
            label: `CI run`,
            describe: () => ({ title: `run`, icon: `pipelines` }),
            home: () => ({ label: `CI`, open: openedHome }),
            claim: (url) => {
                const id = /\/actions\/runs\/(\d+)/u.exec(url)?.[1];
                return id === undefined ? undefined : { runId: Number(id) };
            },
            component: async () => defineComponent({ setup: () => () => h(`p`) }),
        }),
    );
});
afterAll(() => {
    for (const disposable of disposables) {
        disposable.dispose();
    }
});

// Renders links the way the chat's markdown does (inside v-html) and clicks one, returning whether the app took it.
const click = (html: string, init: MouseEventInit = {}): boolean => {
    const root = document.createElement(`div`);
    root.innerHTML = html;
    root.addEventListener(`click`, openClaimedLinkFromEvent);
    document.body.append(root);
    const event = new MouseEvent(`click`, { bubbles: true, cancelable: true, ...init });
    root.querySelector(`a`)?.dispatchEvent(event);
    root.remove();
    return event.defaultPrevented;
};

const RUN = `<a href="https://github.com/acme/web/actions/runs/42" target="_blank" rel="noopener">the failing run</a>`;

beforeEach(() => {
    sideDocked.value = true;
    openedHome.mockClear();
    closeAllTabs();
});

afterEach(() => {
    sideDocked.value = false;
});

it(`opens a claimed link beside the chat, as a peek, instead of a browser tab`, () => {
    expect(click(RUN)).toBe(true);
    expect(panel.tabs.value.map((tab) => [tab.view, tab.input])).toEqual([[`acme.ci/run`, { runId: 42 }]]);
    expect(panel.peek.value).toBe(sideTabId(`acme.ci/run`, { runId: 42 }));
});

it(`leaves a link nothing claims to the browser`, () => {
    expect(click(`<a href="https://example.com/docs" target="_blank">docs</a>`)).toBe(false);
    expect(panel.tabs.value).toEqual([]);
});

it(`leaves a modified click to the browser, so a new tab is still one keystroke away`, () => {
    expect(click(RUN, { ctrlKey: true })).toBe(false);
    expect(click(RUN, { metaKey: true })).toBe(false);
    expect(panel.tabs.value).toEqual([]);
});

it(`leaves a file mention to its own handler`, () => {
    expect(click(`<a class="md-file-link" href="https://github.com/acme/web/actions/runs/42">run.ts</a>`)).toBe(false);
});

// A link whose tab is already in front changes nothing on screen, and one was clicked twelve times running: every press
// rings the panel it opened in instead.
// The ring waits for the panel to be drawn (afterPaint), at most a frame and a task.
const painted = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 150));

it(`rings the side panel a claimed link opened in, the tab already in front included`, async () => {
    // Rings the cases above asked for land first, so they cannot be counted as this one's.
    await painted();
    const tabs = document.createElement(`section`);
    tabs.className = `side-tabs`;
    const rung = jest.fn((_frames: Keyframe[], _timing: KeyframeAnimationOptions) => ({}) as Animation);
    // SAFETY: the ring reads nothing back from the animation it starts, so a stand-in that only records suffices.
    tabs.animate = rung as unknown as HTMLElement[`animate`];
    document.body.append(tabs);
    expect(click(RUN)).toBe(true);
    expect(click(RUN)).toBe(true);
    await painted();
    tabs.remove();
    expect(rung).toHaveBeenCalledTimes(2);
});

it(`goes to the claiming view's home where there is no side panel`, () => {
    sideDocked.value = false;
    expect(click(RUN)).toBe(true);
    expect(openedHome).toHaveBeenCalledTimes(1);
    expect(panel.tabs.value).toEqual([]);
});

// An errand's prompt is plain text, not markdown: the page of what it is about sits in a sentence.
it(`finds the first link in plain text a side view claims, past the punctuation a sentence ends it with`, () => {
    const prompt = `CI failed on branch main (https://github.com/acme/web/actions/runs/42). See https://example.com/docs, then fix it.`;
    expect(claimInText(prompt)).toEqual({ view: `acme.ci/run`, input: { runId: 42 }, label: `run` });
    expect(claimInText(`Nothing to open at https://example.com/docs.`)).toBeUndefined();
    expect(claimInText(`No link at all.`)).toBeUndefined();
});
