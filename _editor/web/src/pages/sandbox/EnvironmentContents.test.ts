// @vitest-environment jsdom
//
// THE SUBJECT IS SPACE, and space is the one thing a projection test cannot see. This tab drew every entry the
// same way: an icon column that was the same grey box eighteen times, a name line, and a whole second line for
// a sentence, on a row a thousand pixels wide, which made it two screens long and made the three entries
// somebody actually decided on the quietest thing on it.
//
// So what is pinned here is the shape, not the inventory (contents.integration.test.ts has that): that the
// staples are a strip you scan rather than thirteen rows you scroll, that a closed row costs one line, that the
// filter reaches every group rather than the long one, and that the attribution says nothing three times.
import type { EnvironmentItem } from "@intentic-app/api-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import type { ContentsGroup } from "../../composables/sandbox/useEnvironmentContents";

// The import chain pulls in app-wide singletons that read browser globals at import time (@intentic/ui's
// useDevice reads window.matchMedia; environment.ts reads window.env). The brand CDN is stubbed to refuse, which
// is also what an offline sandbox does: every mark then paints the tier underneath, and nothing here is waiting
// on a network round trip.
vi.hoisted(() => {
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof globalThis.fetch;
    // The clamped install block watches its own width to know whether it has anything left to show; jsdom
    // ships no ResizeObserver, and nothing measured is what this suite is about.
});

const { default: EnvironmentContents } = await import("./EnvironmentContents.vue");

const staple = (name: string, bin: string, version: string, purpose: string): EnvironmentItem => ({
    id: `base:${bin}`,
    name,
    origin: `base`,
    state: `active`,
    tools: [{ name: bin, version }],
    purpose,
});

// One of each group, as an ordinary sandbox holds them: something an agent added with a rationale behind it,
// something a capability dragged in, and the staples nobody chose.
const GROUPS: ContentsGroup[] = [
    {
        origin: `custom`,
        label: `Added for this workspace`,
        items: [
            {
                id: `custom:ffmpeg`,
                name: `ffmpeg`,
                origin: `custom`,
                state: `active`,
                tools: [{ name: `ffmpeg`, version: `5.1.9` }],
                // The row's line is a TRIMMED version of the paragraph below it (the parenthetical dropped), which
                // is the shape that used to print the opening sentence twice the moment a row was opened.
                purpose: `ffmpeg, encoding screen recordings.`,
                detail:
                    `ffmpeg, encoding screen recordings (Playwright records VP8/WebM). The recordings the machine agents ` +
                    `produce are raw frames until something encodes them.\n\nThe promo captures go out as MP4, which its ` +
                    `bundled build cannot encode.`,
                commands: `RUN apt-get install -y ffmpeg`,
            },
        ],
    },
    {
        origin: `capability`,
        label: `From your capabilities`,
        items: [
            {
                id: `capability:docker`,
                name: `docker`,
                origin: `capability`,
                originLabel: `docker capability`,
                state: `active`,
                tools: [{ name: `docker`, version: `29.7.2` }],
                purpose: `docker capability: this directive grants dockerd the privileges it needs.`,
            },
            {
                id: `capability:tauri`,
                name: `Rust tauri`,
                origin: `capability`,
                originLabel: `workspace extension`,
                state: `active`,
                tools: [{ name: `rustc`, version: `1.97.1` }],
                purpose: `The desktop app is a Tauri shell.`,
            },
        ],
    },
    {
        origin: `base`,
        label: `Comes with every sandbox`,
        items: [
            staple(`Node.js`, `node`, `24.18.0`, `The runtime everything JavaScript in here runs on.`),
            staple(`Python`, `python3`, `3.11.2`, `Scripting, plus anything reached for with pip.`),
            staple(`ripgrep`, `rg`, `13.0.0`, `Fast text search across the workspace.`),
        ],
    },
];

let app: App | undefined;

const mount = (groups: ContentsGroup[] = GROUPS): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    // Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin.
    app = createApp({ render: () => h(EnvironmentContents, { groups, awaiting: 0, loading: false }) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

/* Every pill in the staples strip. Two other buttons on this tab are not pills and each is excluded by what it
 * IS rather than by where it sits: the filter's own clear button names itself, and a row's disclosure carries
 * `aria-expanded` (it is a <DisclosureRow>, so the pressable part of a row is a real button now, where it used
 * to be a click handler on a div). */
const pills = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll<HTMLButtonElement>(`button[type="button"]`)].filter(
        (button) => button.ariaLabel !== `Clear filter` && !button.hasAttribute(`aria-expanded`),
    );

/* THE ROW'S OWN DISCLOSURE, which is what opens it. `.ui-row-select` used to find it: that is the class <Row>
 * paints on a row you can click, and the row was a div with a click handler. The pressable part is now the
 * header BUTTON (chevron, mark, name and sentence in one hit area), and `aria-expanded` is what says so. */
const disclosure = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(`button[aria-expanded]`)!;

// A pill's words, in order. Read per child because the mark, the name and the version are siblings with no text
// between them: the gap is a layout gap, so the concatenated textContent runs "Node.js24.18.0".
const wordsOf = (element: Element): string =>
    [...element.children]
        .map((child) => child.textContent?.trim() ?? ``)
        .filter((text) => text !== ``)
        .join(` `);

const filterBy = async (el: HTMLElement, text: string): Promise<void> => {
    const input = el.querySelector<HTMLInputElement>(`input[role="searchbox"]`);
    input!.value = text;
    input!.dispatchEvent(new Event(`input`));
    await nextTick();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`draws the staples as a strip whose sentences are one click away`, async () => {
    const el = mount();
    // One pill per staple, name and version on it: the whole question this group is ever asked.
    expect(pills(el).map(wordsOf)).toEqual([`Node.js 24.18.0`, `Python 3.11.2`, `ripgrep 13.0.0`]);
    // And thirteen sentences nobody reads are not on screen costing thirteen lines.
    expect(el.textContent).not.toContain(`The runtime everything JavaScript in here runs on.`);

    pills(el)[0]!.click();
    await nextTick();
    expect(el.textContent).toContain(`The runtime everything JavaScript in here runs on.`);

    // One at a time: the next pill replaces the sentence rather than pushing the strip apart.
    pills(el)[1]!.click();
    await nextTick();
    expect(el.textContent).not.toContain(`The runtime everything JavaScript in here runs on.`);
    expect(el.textContent).toContain(`Scripting, plus anything reached for with pip.`);
});

it(`keeps a closed row to its one line, and opens the comment in place`, async () => {
    const el = mount();
    const row = disclosure(el);
    // The sentence rides the name; the rationale and the install lines do not exist until asked for.
    expect(el.textContent).toContain(`ffmpeg, encoding screen recordings.`);
    expect(el.textContent).not.toContain(`raw frames until something encodes them`);

    row.click();
    await nextTick();
    expect(el.textContent).toContain(`raw frames until something encodes them`);
    expect(el.textContent).toContain(`RUN apt-get install -y ffmpeg`);
});

/* THE REPEAT THIS TAB SHIPPED WITH. The row's line is a summary of the paragraph: a trailing parenthetical
 * dropped, an over-long sentence cut back to its claim, so a disclosure that stacked "the row's line" above
 * "the rest of the prose" opened every long entry on its own opening sentence twice, once cut and once whole.
 * One of the two, never both. */
it(`never shows the opening sentence twice`, async () => {
    const el = mount();
    disclosure(el).click();
    await nextTick();
    expect(el.textContent?.match(/encoding screen recordings/g)).toHaveLength(1);
});

/* AND IT DOES NOT LAND FIFTEEN LINES AT ONCE. A rationale runs to bullets and CI history; the reader who
 * clicked a row wants the opening. Cut at the agent's own paragraph break, so the toggle only appears where
 * there genuinely is more, and it does not collapse the row it lives inside. */
it(`opens on the first paragraph and keeps the rest one click away`, async () => {
    const el = mount();
    const row = disclosure(el);
    row.click();
    await nextTick();
    expect(el.textContent).not.toContain(`go out as MP4`);

    const more = [...el.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Show more`));
    more!.click();
    await nextTick();
    expect(el.textContent).toContain(`go out as MP4`);
    // Still open: the row header closes the row, not anything the disclosure puts inside it.
    expect(el.textContent).toContain(`RUN apt-get install -y ffmpeg`);
});

it(`filters across every group, and drops the ones that match nothing`, async () => {
    const el = mount();
    // A staple, found from the tab's one filter: the question does not know which group its answer is in.
    await filterBy(el, `python`);
    expect(el.textContent).toContain(`Comes with every sandbox`);
    expect(el.textContent).not.toContain(`Added for this workspace`);
    expect(pills(el)).toHaveLength(1);

    // A workspace addition, from the same field.
    await filterBy(el, `ffmpeg`);
    expect(el.textContent).toContain(`Added for this workspace`);
    expect(el.textContent).not.toContain(`Comes with every sandbox`);

    // An empty bordered surface under a heading would read as "you have none of these", which is a lie about a
    // group the query simply missed.
    await filterBy(el, `haskell`);
    expect(el.textContent).toContain(`Nothing here matches`);
    // The exact translation of the old `.ui-row-select` count: that class was painted only on a row <Row> had
    // been told was `interactive`, which was every EXPANDABLE row and no other, and those are the rows that
    // carry `aria-expanded` now.
    expect(el.querySelectorAll(`button[aria-expanded]`)).toHaveLength(0);
});

it(`only names the source when it is not already saying the row's own name`, () => {
    const el = mount();
    // The trailing facts cluster, which is where a row states what pulled it in.
    const facts = [...el.querySelectorAll(`.tabular-nums`)].map((meta) => meta.textContent?.trim() ?? ``).join(` `);
    // "docker capability", on a row called docker, under a heading called From your capabilities.
    expect(facts).not.toContain(`docker capability`);
    // What nobody could have guessed from the row survives.
    expect(facts).toContain(`workspace extension`);
});

/* THE LONGEST WAIT IN THE HUB, and until now the least drawn: this view's read asks every tool on the overlay
 * for its version, one process spawn each, so it is measured in seconds where the other tabs pay a round-trip.
 * It showed a spinner and "Checking installed versions…" over an empty card for all of it.
 *
 * Mounted with `loading` rather than through the parent, because the prop IS the state under test: what the
 * card does with the query is EnvironmentCard's business. */
const mountLoading = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(EnvironmentContents, { groups: [], awaiting: 0, loading: true }) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

it(`draws the list's outline while it is checking installed versions`, async () => {
    vi.useFakeTimers();
    try {
        const el = mountLoading();
        vi.advanceTimersByTime(250);
        await nextTick();
        expect(el.querySelectorAll(`.skeleton`).length).toBeGreaterThan(0);
        // The sentence is not lost: it is what the wait is announced as, to the readers who need it said.
        expect(el.querySelector(`[role="status"]`)?.textContent).toContain(`Checking installed versions…`);
    } finally {
        vi.useRealTimers();
    }
});

// The quiet side of the same gate: a sandbox that answers quickly must paint no placeholder at all.
it(`paints no outline for a probe that answers within the reveal delay`, async () => {
    vi.useFakeTimers();
    try {
        const el = mountLoading();
        vi.advanceTimersByTime(150);
        await nextTick();
        expect(el.querySelector(`.skeleton`)).toBeNull();
    } finally {
        vi.useRealTimers();
    }
});

// And the loaded view never draws one, which is what keeps a refetch from blanking a list already on screen.
it(`draws no outline once the versions are in`, () => {
    expect(mount().querySelector(`.skeleton`)).toBeNull();
});
