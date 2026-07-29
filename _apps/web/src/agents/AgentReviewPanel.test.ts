// @vitest-environment jsdom
//
// jsdom because the whole subject here is the LEFT-HAND LIST. A land conflict used to be a paragraph above the
// review naming a few paths, over a list of rows that all looked alike — so "which of these thirty files is the
// problem, and whose problem is it?" was a question the user answered by matching strings with their eyes. The
// fix is entirely in what renders: a mark per blocked row, a count per repo heading, a filter that narrows to
// them. None of that can be pinned by a unit test on the composable, only by looking at the rows.
import type { AgentChangesResponse } from "@intentic-app/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { REASON_COPY } from "../composables/agents/conflictResolution";
import { queryClient } from "../composables/queryPersistence";
import { sandboxKey } from "../composables/sandbox/useSandbox";
import { router } from "../router";

// The panel's import chain pulls in app-wide singletons that read browser globals at import time
// (@intentic-app/ui's useDevice reads window.matchMedia; environment.ts reads window.env). matches:false keeps
// the device DESKTOP — the form factor where the list and the diff are on screen together.
vi.hoisted(() => {
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    // jsdom implements no scrolling at all, and selecting a row keeps it on screen.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

// The only stand-ins: the two viewers, which the panel mounts for whichever file is selected. Monaco is a real
// editor with real workers and nothing about it is under test here — the list is.
vi.mock("../pages/workspace/viewers/DiffView.vue", () => ({ default: { render: () => null } }));
vi.mock("../pages/workspace/viewers/BinaryDiffView.vue", () => ({ default: { render: () => null } }));

const { default: AgentReviewPanel } = await import("./AgentReviewPanel.vue");

const AGENT = `a1`;
/* A refused land as the daemon reports it: nothing landed (a check land is atomic), two of the five files
 * blocked, for two different causes, in two different repos. The third repo group holds none — the case that
 * proves a heading's count is per repo and not the report's total. */
const changes: AgentChangesResponse = {
    repos: [
        {
            repo: `root`,
            branch: `agent/a1`,
            changes: [
                { path: `src/auth/session.ts`, status: `modified`, additions: 12, deletions: 3, landed: false },
                { path: `src/auth/session.test.ts`, status: `modified`, additions: 8, deletions: 0, landed: false },
                { path: `src/config.ts`, status: `modified`, additions: 2, deletions: 1, landed: false },
                { path: `assets/logo.png`, status: `modified`, landed: false },
            ],
        },
        { repo: `docs`, branch: `agent/a1`, changes: [{ path: `README.md`, status: `modified`, additions: 1, deletions: 1, landed: false }] },
    ],
    conflicts: [
        {
            repo: `root`,
            clean: 2,
            paths: [
                { path: `src/config.ts`, reason: `workspace` },
                { path: `assets/logo.png`, reason: `binary` },
            ],
        },
    ],
};

let app: App | undefined;

/* Seeded into the query cache rather than served over a stubbed fetch: the diff query is gated on the daemon
 * being reachable (useSandboxQuery), which no test drives, and the cache is where the real panel reads it from
 * anyway — this is the state a browser is in when it opens the review on a conflict it learned about from the
 * board. */
const mount = async (): Promise<HTMLElement> => {
    queryClient.setQueryData(sandboxKey(`agents`, AGENT, `diff`), changes);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AgentReviewPanel, { agentId: AGENT }) });
    // Registered app-wide by installUi in the real page. Icon prints the glyph it was handed, because WHICH
    // glyph a mark wears is the link between the report's group heading and the rows it is talking about.
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
});

// The file rows, by the class the row container carries. Substring-matched to sidestep escaping Tailwind's `/`.
const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[class*="group/file"]`)];
const rowFor = (el: HTMLElement, path: string): HTMLElement =>
    rows(el).find((row) => row.textContent?.includes(path.slice(path.lastIndexOf(`/`) + 1)))!;
// The narrowing control's options, in the order it offers them.
const filters = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`button`)]
        .map((button) => button.textContent?.trim() ?? ``)
        .filter((label) => /^(All|Blocked|Code|Tests|Not landed) \d+$/.test(label));

it(`marks each blocked row with its own cause, and leaves the rest of the review alone`, async () => {
    const el = await mount();
    // The user's own uncommitted edits, and a file git cannot merge at all — two causes, two marks, and the
    // words are the module's, so the row cannot come to say something the report above it doesn't.
    expect(rowFor(el, `src/config.ts`).textContent).toContain(REASON_COPY.workspace.mark);
    expect(rowFor(el, `src/config.ts`).querySelector(`[data-icon="${REASON_COPY.workspace.icon}"]`)).not.toBeNull();
    expect(rowFor(el, `assets/logo.png`).textContent).toContain(REASON_COPY.binary.mark);
    expect(rowFor(el, `assets/logo.png`).querySelector(`[data-icon="${REASON_COPY.binary.icon}"]`)).not.toBeNull();
    // A file that landed nowhere is not a file that BLOCKED anything: an atomic refusal leaves every row
    // unlanded, so marking on `landed` alone would have called all five of these the conflict.
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(REASON_COPY.workspace.mark);
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(REASON_COPY.binary.mark);
    expect(rowFor(el, `src/auth/session.ts`).textContent).not.toContain(REASON_COPY.diverged.mark);
});

it(`counts the blockers on the repo heading, so a collapsed group cannot hide one`, async () => {
    const el = await mount();
    const heading = (repo: string): HTMLElement =>
        [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim().toLowerCase().startsWith(repo))!;
    const root = heading(`root`);
    const docs = heading(`docs`);
    expect(root.querySelector(`[data-icon="exclamation-triangle"]`)).not.toBeNull();
    expect(docs.querySelector(`[data-icon="exclamation-triangle"]`)).toBeNull();
});

/* THE REGRESSION THIS FILTER CARRIES. The control used to be hidden whole whenever the unlanded set was not a
 * proper subset of the review — and a refused land leaves EVERY row unlanded, so the one state where narrowing
 * a thirty-file list matters most was the one state with no control to do it. */
it(`offers Blocked first and keeps the control alive when a refusal left nothing landed`, async () => {
    const el = await mount();
    expect(filters(el)).toEqual([`All 5`, `Blocked 2`, `Code 4`, `Tests 1`]);
});

it(`narrows to exactly the blocked files`, async () => {
    const el = await mount();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Blocked 2`)!.click();
    await nextTick();
    expect(rows(el).map((row) => row.textContent?.match(/config\.ts|logo\.png|session\.ts|README\.md/)?.[0])).toEqual([`config.ts`, `logo.png`]);
});

it(`lands a path clicked in the report on its row, and says so in the diff header`, async () => {
    const el = await mount();
    // The report prints the repo-qualified path; the row it names is the one the diff header must end up on.
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `assets/logo.png`)!.click();
    await nextTick();
    await nextTick();
    const header = el.querySelector(`section > div`)!;
    expect(header.textContent).toContain(`logo.png`);
    expect(header.textContent).toContain(REASON_COPY.binary.mark);
});
