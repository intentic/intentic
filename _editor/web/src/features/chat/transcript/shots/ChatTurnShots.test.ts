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

const mount = (shots: readonly ChatShot[]): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTurnShots, { shots, agent: undefined, onView: view }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button`)];

beforeEach(() => {
    view.mockClear();
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
        expect(viewAsks).toEqual([shots[2]!.path, shots[0]!.path]);
    });
});
