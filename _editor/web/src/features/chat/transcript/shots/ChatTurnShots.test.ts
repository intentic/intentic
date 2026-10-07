// The strip a finished turn ends on: up to four tiles, the rest counted on the first, a press handing the viewer the
// shot to open at, and a picture that is gone saying so rather than drawing a broken image.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { IconStub } from "@intentic/ui/testing";
import { type ChatShot, shotKey } from "./shots";

// What the tile cache answers per path: a URL, `{ url: undefined }` for nothing there, unset for still on its way.
const tiles = new Map<string, { url: string | undefined }>();
// Every path a strip asked a tile or a view of, in order.
const tileAsks: string[] = [];
const viewAsks: string[] = [];
jest.mock("../../../workspace/home/thumbnails", () => ({
    picture: (_agent: string | undefined, path: string, size: string) => {
        if (size === `view`) {
            viewAsks.push(path);
            return undefined;
        }
        tileAsks.push(path);
        return tiles.get(path);
    },
}));

// What each picture was judged (shotLook.ts) by path; a path not set is an ordinary picture, unset in `unjudged` still coming.
const judged = new Map<string, { plain: boolean; print: string | undefined }>();
const unjudged = new Set<string>();
jest.mock("./shotLooks", () => ({
    shotLook: (_agent: string | undefined, path: string) => (unjudged.has(path) ? undefined : (judged.get(path) ?? { plain: false, print: path })),
}));

// The viewport is the observer's to judge, which jsdom has none of: each case says when its strip comes near.
const nearing: (() => void)[] = [];
jest.mock("../../../workspace/home/nearViewport", () => ({
    whenNear: (_el: Element, near: () => void) => nearing.push(near),
    stopWaiting: () => {},
}));
const comeNear = async (): Promise<void> => {
    for (const near of nearing.splice(0)) {
        near();
    }
    await nextTick();
};

const { default: ChatTurnShots } = await import("./ChatTurnShots.vue");

const SHOTS = `${STATE_DIR}/records/artifacts/browser`;

const shotsOf = (...names: string[]): ChatShot[] =>
    names.map((name, index) => ({ key: shotKey(`s${index}`, `${SHOTS}/${name}.png`), path: `${SHOTS}/${name}.png`, toolId: `s${index}`, turnId: 1 }));

let app: App | undefined;
const view = jest.fn<(shot: ChatShot) => void>();
const reveal = jest.fn<(shown: boolean) => void>();

const mount = (shots: readonly ChatShot[], revealed = false): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTurnShots, { shots, agent: undefined, revealed, onView: view, onReveal: reveal }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button`)];

beforeEach(() => {
    view.mockClear();
    reveal.mockClear();
    judged.clear();
    unjudged.clear();
    tiles.clear();
    tileAsks.length = 0;
    viewAsks.length = 0;
    nearing.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`ChatTurnShots`, () => {
    it(`draws a tile per shot, named for its file, with no count while four or fewer`, async () => {
        const shots = shotsOf(`before`, `after`);
        for (const shot of shots) {
            tiles.set(shot.path, { url: `blob:${shot.path}` });
        }
        const element = mount(shots);
        await comeNear();
        expect(buttons(element).map((button) => button.getAttribute(`aria-label`))).toEqual([`Open before`, `Open after`]);
        expect([...element.querySelectorAll(`img`)].map((image) => image.getAttribute(`src`))).toEqual([
            `blob:${SHOTS}/before.png`,
            `blob:${SHOTS}/after.png`,
        ]);
        expect(element.textContent).not.toContain(`+`);
    });

    it(`past four, draws the last four and counts the rest on the first, which opens the turn's first shot`, () => {
        const shots = shotsOf(`a`, `b`, `c`, `d`, `e`, `f`);
        const drawn = buttons(mount(shots));
        expect(drawn.map((button) => button.getAttribute(`aria-label`))).toEqual([`Open all 6 pictures`, `Open d`, `Open e`, `Open f`]);
        // The counted tile stands for itself and the two before it.
        expect(drawn[0]?.textContent?.trim()).toBe(`+3`);
        drawn[0]?.click();
        expect(view.mock.calls).toEqual([[shots[0]!]]);
    });

    it(`a press hands the viewer the shot that tile shows`, () => {
        const shots = shotsOf(`one`, `two`, `three`);
        buttons(mount(shots))[1]?.click();
        expect(view.mock.calls).toEqual([[shots[1]!]]);
    });

    it(`a picture with nothing on disk says so, and one still coming draws neither`, async () => {
        const shots = shotsOf(`expired`, `coming`);
        tiles.set(shots[0]!.path, { url: undefined });
        const element = mount(shots);
        await comeNear();
        const [gone, coming] = buttons(element);
        expect(gone?.textContent?.trim()).toBe(`No longer available`);
        expect(gone?.querySelector(`img`)).toBeNull();
        expect(coming?.textContent?.trim()).toBe(``);
        expect(coming?.querySelector(`img`)).toBeNull();
    });

    // A chat opens on its newest turn; a strip far above it waits, so the pictures on screen are the ones fetched first.
    it(`asks for no tile until the strip comes near the viewport`, async () => {
        const shots = shotsOf(`one`, `two`);
        mount(shots);
        expect(tileAsks).toEqual([]);
        await comeNear();
        expect(tileAsks).toEqual([shots[0]!.path, shots[1]!.path]);
    });

    it(`starts a tile's view coming when the pointer rests on it, the counted tile's being the turn's first`, async () => {
        const shots = shotsOf(`a`, `b`, `c`, `d`, `e`);
        const [counted, second] = buttons(mount(shots));
        second?.dispatchEvent(new Event(`pointerenter`));
        counted?.dispatchEvent(new Event(`pointerenter`));
        expect(viewAsks).toEqual(expect.arrayContaining([shots[2]!.path, shots[0]!.path]));
    });

    // The strip's picture stands in until the view arrives; the look is the tile's own shot, even on the counted one.
    it(`shows a tile bigger while the pointer rests on it, and drops the look on leave or press`, async () => {
        const shots = shotsOf(`a`, `b`);
        for (const shot of shots) {
            tiles.set(shot.path, { url: `blob:${shot.path}` });
        }
        const [, second] = buttons(mount(shots));
        await comeNear();
        const looks = (): string[] => [...document.body.querySelectorAll(`.fixed img`)].map((image) => image.getAttribute(`src`) ?? ``);
        second?.dispatchEvent(new Event(`pointerenter`));
        await nextTick();
        expect(looks()).toEqual([`blob:${shots[1]!.path}`]);
        second?.dispatchEvent(new Event(`pointerleave`));
        await nextTick();
        expect(looks()).toEqual([]);
        second?.dispatchEvent(new Event(`pointerenter`));
        second?.click();
        await nextTick();
        expect(looks()).toEqual([]);
        expect(view.mock.calls).toEqual([[shots[1]!]]);
    });

    // The tiles that open pictures, without the line's own press.
    const tileButtons = (element: HTMLElement): HTMLButtonElement[] => buttons(element).filter((button) => button.closest(`.grid`) !== null);
    const asideLine = (element: HTMLElement): HTMLElement | null => element.querySelector(`p`);

    it(`sets a blank picture and a repeat aside behind one quiet line, whose press asks to show them`, async () => {
        const shots = shotsOf(`blank`, `page`, `again`);
        judged.set(shots[0]!.path, { plain: true, print: `white` });
        judged.set(shots[1]!.path, { plain: false, print: `same` });
        judged.set(shots[2]!.path, { plain: false, print: `same` });
        const element = mount(shots);
        await comeNear();
        expect(tileButtons(element).map((button) => button.getAttribute(`aria-label`))).toEqual([`Open page`]);
        expect(asideLine(element)?.textContent).toContain(`2 blank or repeated pictures hidden`);
        asideLine(element)?.querySelector(`button`)?.click();
        expect(reveal.mock.calls).toEqual([[true]]);
    });

    it(`once revealed, draws the set-aside pictures in their place, dimmed, and offers to hide them again`, async () => {
        const shots = shotsOf(`blank`, `page`);
        judged.set(shots[0]!.path, { plain: true, print: `white` });
        const element = mount(shots, true);
        await comeNear();
        const [blank, page] = tileButtons(element);
        expect(blank?.getAttribute(`aria-label`)).toBe(`Open blank`);
        expect(blank?.className).toContain(`opacity-50`);
        expect(page?.className).not.toContain(`opacity-50`);
        expect(asideLine(element)?.textContent).toContain(`1 blank picture shown, dimmed`);
        asideLine(element)?.querySelector(`button`)?.click();
        expect(reveal.mock.calls).toEqual([[false]]);
    });

    it(`a turn whose every picture came out blank draws only the line`, async () => {
        const shots = shotsOf(`white`, `black`);
        judged.set(shots[0]!.path, { plain: true, print: `w` });
        judged.set(shots[1]!.path, { plain: true, print: `b` });
        const element = mount(shots);
        await comeNear();
        expect(tileButtons(element)).toEqual([]);
        expect(asideLine(element)?.textContent).toContain(`2 blank pictures hidden`);
    });

    // A blank tile drawn and then pulled once judged would flash; the tile waits for both.
    it(`draws no tile's picture before that picture is judged`, async () => {
        const shots = shotsOf(`judged`, `coming`);
        unjudged.add(shots[1]!.path);
        mount(shots);
        await comeNear();
        expect(tileAsks).toEqual([shots[0]!.path]);
    });
});
