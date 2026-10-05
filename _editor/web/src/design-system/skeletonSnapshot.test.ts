// A loading placeholder drawn from its content's imprint is only worth having if the imprint is exact and the store
// keeps it apart per sandbox. Pinned here: what `takeImprint` keeps of a laid-out tree (classes, one bar per line at
// its width, blocks at their size, and nothing outside the band or hidden); what <SkeletonSnapshot> draws from it, and
// when it draws its fallback instead; that `v-skeleton-source` takes the imprint once the element settles, and never
// under a scope that changed while it waited; and that the store batches writes, keeps a page's own imprints over
// older ones read from disk, and forgets everything on sign-out.
import "@intentic/testing/dom";
import { SkeletonSnapshot, vSkeletonSource } from "@intentic/ui";
import { type ImprintElement, type ImprintNode, type SkeletonImprint, takeImprint } from "@intentic/ui/skeleton-imprint";
import { clearImprints, configureSkeletonSnapshots, imprintOf, loadImprintScope, rememberImprint, type SkeletonPersistence } from "@intentic/ui/skeleton-store";
import { type App, createApp, h, nextTick, ref, type VNode, withDirectives } from "vue";

// jsdom lays nothing out, so each element says where it sits (`data-box="top,left,width,height"`) and a text node's
// lines come from its parent's `data-lines="width,width"`, each line 16px tall from the parent's top.
const LINE = 16;
const numbers = (raw: string | null): number[] => (raw ?? ``).split(`,`).filter(Boolean).map(Number);
const rect = (top: number, left: number, width: number, height: number): DOMRect =>
    ({ top, left, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) satisfies DOMRect;

const original = { box: Element.prototype.getBoundingClientRect, lines: Range.prototype.getClientRects };
beforeAll(() => {
    Element.prototype.getBoundingClientRect = function box(this: Element): DOMRect {
        const [top = 0, left = 0, width = 0, height = 0] = numbers(this.getAttribute(`data-box`));
        return rect(top, left, width, height);
    };
    Range.prototype.getClientRects = function lines(this: Range): DOMRectList {
        const parent = this.startContainer.parentElement;
        const [top = 0, left = 0] = numbers(parent?.getAttribute(`data-box`) ?? null);
        const rects = numbers(parent?.getAttribute(`data-lines`) ?? null).map((width, index) => rect(top + index * LINE, left, width, LINE));
        return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
    };
});
afterAll(() => {
    Element.prototype.getBoundingClientRect = original.box;
    Range.prototype.getClientRects = original.lines;
});

const mounted: { app: App; host: HTMLElement }[] = [];
afterEach(async () => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
    document.body.innerHTML = ``;
    await clearImprints();
    configureSkeletonSnapshots({});
});

// A list of one laid-out row, one hidden row and one far below the band; the row holds an icon, a two-line name and a
// painted button, with a status dot (painted, empty) and whitespace between.
const LIST =
    `<ul data-box="0,0,400,120" class="divide-y" data-v-abc123 style="background-image: url(x.png); gap: 4px">` +
    `<li data-box="0,0,400,40" class="flex items-center gap-2 px-4">` +
    `<svg data-box="12,16,16,16" class="shrink-0 ml-1 text-danger hover:mr-2" style="display: block"></svg> ` +
    `<span data-box="4,40,200,32" data-lines="120,64" style="font-size: 20px">A name long enough to wrap</span> ` +
    `<span data-box="16,250,8,8" class="size-2 rounded-full bg-success" style="display: block; background-color: rgb(0, 128, 0)"></span>` +
    `<button data-box="8,300,80,24" class="ml-auto rounded-md bg-primary px-2" style="display: inline-flex; background-color: rgb(0, 0, 255); border-radius: 6px">Open</button>` +
    `</li>` +
    `<li data-box="40,0,400,40" style="display: none">gone</li>` +
    `<li data-box="2000,0,400,40">below the band</li>` +
    `</ul>`;

const laidOut = (html: string): Element => {
    const host = document.createElement(`div`);
    host.innerHTML = html;
    document.body.append(host);
    const root = host.firstElementChild;
    if (root === null) {
        throw new Error(`fixture has no root`);
    }
    return root;
};

// The imprint with its string-table indices read back, so an expectation names classes rather than positions.
type Readable = { e: string; c?: string; s?: string; v?: string[]; k?: Readable[] } | { h: number; w: readonly number[] } | Record<string, unknown> | 0;
const readable = (node: ImprintNode, table: readonly string[]): Readable => {
    if (node === 0 || `w` in node) {
        return node;
    }
    if (`b` in node) {
        return { ...node, c: node.c === undefined ? undefined : table[node.c], r: node.r === undefined ? undefined : table[node.r] };
    }
    const element: ImprintElement = node;
    return {
        e: element.e,
        c: element.c === undefined ? undefined : table[element.c],
        s: element.s === undefined ? undefined : table[element.s],
        v: element.v?.map((index) => table[index] ?? ``),
        k: element.k?.map((child) => readable(child, table)),
    };
};

const imprintOfList = (): SkeletonImprint => {
    const imprint = takeImprint(laidOut(LIST), { now: 1_000 });
    if (imprint === undefined) {
        throw new Error(`the fixture list took no imprint`);
    }
    return imprint;
};

describe(`takeImprint`, () => {
    it(`keeps the elements and their classes, one bar per line at its width, and blocks at their measured size`, () => {
        const imprint = imprintOfList();

        expect(imprint.at).toBe(1_000);
        expect(readable(imprint.root, imprint.t)).toEqual({
            e: `ul`,
            c: `divide-y`,
            // The background image would load; the gap is layout and stays.
            s: `gap: 4px`,
            v: [`data-v-abc123`],
            k: [
                {
                    e: `li`,
                    c: `flex items-center gap-2 px-4`,
                    s: undefined,
                    v: undefined,
                    k: [
                        // Only the classes that place it; its colour classes are gone, and it holds its 16px in a row.
                        { b: [16, 16], c: `shrink-0 ml-1 hover:mr-2`, r: undefined, n: 1 },
                        0,
                        { e: `span`, c: undefined, s: `font-size: 20px`, v: undefined, k: [{ h: 16, w: [120, 64] }] },
                        0,
                        // A painted mark with nothing in it is a neutral block, so a stale green never shows.
                        { b: [8, 8], c: undefined, r: undefined, n: 1 },
                        // A painted button is one block, its radius as computed, inline as it flowed.
                        { b: [80, 24], c: `ml-auto`, r: `6px`, i: 1 },
                    ],
                },
            ],
        });
    });

    it(`keeps a placed element's transform but not its transition, and keeps a drawing's space without filling it`, () => {
        const imprint = takeImprint(
            laidOut(
                `<div data-box="0,0,400,240" class="relative">` +
                    `<svg data-box="0,0,400,240" class="absolute inset-0" style="display: block"></svg>` +
                    `<div data-box="20,30,120,40" class="absolute" style="transform: translate(30px, 20px); transition: opacity 1s">` +
                    `<span data-box="20,30,90,16" data-lines="90">node</span></div>` +
                    `</div>`,
            ),
        );
        expect(imprint === undefined ? undefined : readable(imprint.root, imprint.t)).toEqual({
            e: `div`,
            c: `relative`,
            s: undefined,
            v: undefined,
            k: [
                { b: [400, 240], c: `absolute inset-0`, r: undefined, g: 1 },
                {
                    e: `div`,
                    c: `absolute`,
                    s: `transform: translate(30px, 20px)`,
                    v: undefined,
                    k: [{ e: `span`, c: undefined, s: undefined, v: undefined, k: [{ h: 11, w: [90] }] }],
                },
            ],
        });
    });

    it(`takes a boxless run of grid items by the boxes of its children`, () => {
        const imprint = takeImprint(
            laidOut(
                `<div style="display: contents">` +
                    `<div data-box="0,0,200,80" class="rounded-xl bg-card"><p data-box="16,16,120,16" data-lines="120">one</p></div>` +
                    `<div data-box="0,212,200,80" class="rounded-xl bg-card"><p data-box="16,228,90,16" data-lines="90">two</p></div>` +
                    `</div>`,
            ),
        );
        expect(imprint?.root.k?.map((tile) => readable(tile, imprint.t))).toEqual([
            { e: `div`, c: `rounded-xl bg-card`, s: undefined, v: undefined, k: [{ e: `p`, c: undefined, s: undefined, v: undefined, k: [{ h: 11, w: [120] }] }] },
            { e: `div`, c: `rounded-xl bg-card`, s: undefined, v: undefined, k: [{ e: `p`, c: undefined, s: undefined, v: undefined, k: [{ h: 11, w: [90] }] }] },
        ]);
    });

    it(`takes nothing from a tree the DOM never laid out`, () => {
        expect(takeImprint(laidOut(`<div><p>no box anywhere</p></div>`))).toBeUndefined();
    });

    it(`takes nothing from a root with nothing measurable inside it`, () => {
        expect(takeImprint(laidOut(`<div data-box="0,0,200,40"><p style="display: none">hidden</p></div>`))).toBeUndefined();
    });
});

const mount = (render: () => VNode): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render });
    app.mount(host);
    mounted.push({ app, host });
    return host;
};

const FALLBACK = () => h(`p`, { class: `fallback` }, `hand-drawn`);

describe(`<SkeletonSnapshot>`, () => {
    it(`draws its fallback until the name has an imprint in the current scope, then the imprint`, async () => {
        const scope = ref(`sandbox-a`);
        configureSkeletonSnapshots({ scope: () => scope.value });
        const host = mount(() => h(SkeletonSnapshot, { of: `list` }, { default: FALLBACK }));
        expect(host.querySelector(`.fallback`)?.textContent).toBe(`hand-drawn`);

        rememberImprint(`sandbox-a`, `list`, imprintOfList());
        await nextTick();

        const ghost = host.querySelector(`[data-skeleton-snapshot]`);
        expect(ghost?.tagName).toBe(`UL`);
        expect(ghost?.className).toBe(`divide-y skeleton-snapshot`);
        expect(ghost?.getAttribute(`aria-hidden`)).toBe(`true`);
        expect(ghost?.hasAttribute(`inert`)).toBe(true);
        expect(ghost?.hasAttribute(`data-v-abc123`)).toBe(true);
        expect(host.querySelector(`.fallback`)).toBeNull();
        // The name's two lines, one bar each, broken between.
        const name = host.querySelector(`li > span[style*="font-size"]`);
        expect([...(name?.querySelectorAll<HTMLElement>(`.skeleton`) ?? [])].map((bar) => bar.style.width)).toEqual([`120px`, `64px`]);
        expect(name?.querySelectorAll(`br`)).toHaveLength(1);
        // No word of the content reaches the ghost.
        expect(ghost?.textContent?.trim()).toBe(``);

        // Another sandbox has no imprint of its own under the name.
        scope.value = `sandbox-b`;
        await nextTick();
        expect(host.querySelector(`[data-skeleton-snapshot]`)).toBeNull();
        expect(host.querySelector(`.fallback`)).not.toBeNull();
    });

    it(`announces the wait when given a label, instead of hiding itself`, async () => {
        rememberImprint(`default`, `list`, imprintOfList());
        const host = mount(() => h(SkeletonSnapshot, { of: `list`, label: `Reading the list` }, { default: FALLBACK }));
        await nextTick();
        const ghost = host.querySelector(`[data-skeleton-snapshot]`);
        expect(ghost?.getAttribute(`role`)).toBe(`status`);
        expect(ghost?.getAttribute(`aria-label`)).toBe(`Reading the list`);
        expect(ghost?.hasAttribute(`aria-hidden`)).toBe(false);
    });
});

describe(`v-skeleton-source`, () => {
    // Reports once on observe, as a browser's observer reports an element's first size.
    class ReportingObserver implements ResizeObserver {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe(target: Element): void {
            const entry = {
                target,
                contentRect: rect(0, 0, 0, 0),
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
            } satisfies ResizeObserverEntry;
            this.report([entry], this);
        }
        unobserve(): void {}
        disconnect(): void {}
    }
    const realObserver = globalThis.ResizeObserver;
    beforeEach(() => {
        jest.useFakeTimers();
        globalThis.ResizeObserver = ReportingObserver;
    });
    afterEach(() => {
        jest.useRealTimers();
        globalThis.ResizeObserver = realObserver;
    });

    const source = (name: string): void => {
        mount(() =>
            withDirectives(
                h(`div`, { "data-box": `0,0,300,40` }, [h(`span`, { "data-box": `0,0,90,16`, "data-lines": `90` }, `ninety`)]),
                [[vSkeletonSource, name]],
            ),
        );
    };

    it(`takes the element's imprint once it has settled`, async () => {
        const scope = ref(`sandbox-a`);
        configureSkeletonSnapshots({ scope: () => scope.value });
        source(`row`);
        await nextTick();
        expect(imprintOf(`row`)).toBeUndefined();

        jest.advanceTimersByTime(500);
        expect(imprintOf(`row`)?.root.k).toEqual([{ e: `span`, k: [{ h: 11, w: [90] }] }]);

        // Content arriving inside a box that keeps its size (an editor filling its pane) is taken again once quiet.
        const late = document.createElement(`span`);
        late.setAttribute(`data-box`, `20,0,40,16`);
        late.setAttribute(`data-lines`, `40`);
        late.textContent = `late`;
        document.querySelector(`[data-box="0,0,300,40"]`)?.append(late);
        await Promise.resolve();
        jest.advanceTimersByTime(500);
        expect(imprintOf(`row`)?.root.k).toEqual([
            { e: `span`, k: [{ h: 11, w: [90] }] },
            { e: `span`, k: [{ h: 11, w: [40] }] },
        ]);
    });

    it(`drops a capture whose scope changed while it waited`, async () => {
        const scope = ref(`sandbox-a`);
        configureSkeletonSnapshots({ scope: () => scope.value });
        source(`row`);
        await nextTick();

        scope.value = `sandbox-b`;
        jest.advanceTimersByTime(500);
        expect(imprintOf(`row`)).toBeUndefined();
        scope.value = `sandbox-a`;
        expect(imprintOf(`row`)).toBeUndefined();
    });
});

describe(`the imprint store`, () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const persisting = (stored: ReadonlyMap<string, SkeletonImprint> = new Map()) => {
        const saves: [string, string[]][] = [];
        let cleared = 0;
        const persistence: SkeletonPersistence = {
            load: () => Promise.resolve(stored),
            save: (scope, imprints) => {
                saves.push([scope, [...imprints.keys()]]);
                return Promise.resolve();
            },
            clear: () => {
                cleared += 1;
                return Promise.resolve();
            },
        };
        return { persistence, saves, cleared: () => cleared };
    };

    it(`fills a scope from disk without overwriting an imprint this page already took`, async () => {
        const onDisk = { ...imprintOfList(), at: 1 };
        const fresh = { ...imprintOfList(), at: 2 };
        const { persistence } = persisting(new Map([[`list`, onDisk], [`other`, onDisk]]));
        configureSkeletonSnapshots({ scope: () => `sandbox-a`, persistence });
        rememberImprint(`sandbox-a`, `list`, fresh);

        await loadImprintScope(`sandbox-a`);
        expect(imprintOf(`list`)?.at).toBe(2);
        expect(imprintOf(`other`)?.at).toBe(1);
    });

    it(`batches writes into one save per scope, and skips an imprint that did not change`, () => {
        const { persistence, saves } = persisting();
        configureSkeletonSnapshots({ scope: () => `sandbox-a`, persistence });
        rememberImprint(`sandbox-a`, `list`, imprintOfList());
        rememberImprint(`sandbox-a`, `rail`, imprintOfList());
        expect(saves).toEqual([]);

        jest.advanceTimersByTime(2_000);
        jest.advanceTimersByTime(0);
        expect(saves).toEqual([[`sandbox-a`, [`list`, `rail`]]]);

        // Taken again a minute later, the same: nothing to write.
        rememberImprint(`sandbox-a`, `list`, { ...imprintOfList(), at: 61_000 });
        jest.advanceTimersByTime(2_000);
        jest.advanceTimersByTime(0);
        expect(saves).toHaveLength(1);
    });

    it(`forgets every scope, in memory and on disk, on sign-out`, async () => {
        const { persistence, cleared } = persisting();
        configureSkeletonSnapshots({ scope: () => `sandbox-a`, persistence });
        rememberImprint(`sandbox-a`, `list`, imprintOfList());

        await clearImprints();
        expect(cleared()).toBe(1);
        expect(imprintOf(`list`)).toBeUndefined();
    });
});
