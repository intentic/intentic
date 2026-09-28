import "@intentic/testing/dom";
import type { OpenRequest, OpenResult } from "./contract.js";
import { drop, frameId } from "./frames.js";
import { CHANNEL, type PageMessage, type ViewerMessage } from "./protocol.js";
import { EditorSlot, type Opening } from "./slot.js";

// The viewer's frame against scripted backend answers, in jsdom with a stand-in `moveBefore` (jsdom has none, and a
// browser without one keeps nothing). What is checked is which frame ends up in the slot, when it may be used, and what
// the backend is asked.

type Movable = { moveBefore?: (node: Node, child: Node | null) => void };
const prototype = Element.prototype as Movable;

const brief: Opening = { path: `brief.docx`, agent: undefined, mode: `edit`, theme: `light`, engine: `server`, lang: `en`, origin: `https://app.example` };
// What the backend is asked for `brief`, before any resume.
const briefRequest = { path: `brief.docx`, mode: `edit`, theme: `light`, engine: `server`, lang: `en`, origin: `https://app.example` } as const;

interface Fake {
    readonly slot: EditorSlot;
    readonly element: HTMLElement;
    readonly opened: OpenRequest[];
    readonly saved: string[];
    readonly framed: boolean[];
    readonly heard: PageMessage[];
    answer: (request: OpenRequest) => Promise<OpenResult>;
}

const fake = (): Fake => {
    const element = document.createElement(`div`);
    document.body.append(element);
    const state: Fake = {
        element,
        opened: [],
        saved: [],
        framed: [],
        heard: [],
        answer: async () => ({ url: `https://port-1.example/editor?s=one`, session: `one`, engine: `server` }),
        slot: undefined as unknown as EditorSlot,
    };
    return Object.assign(state, {
        slot: new EditorSlot(element, {
            open: async (request) => {
                state.opened.push(request);
                return state.answer(request);
            },
            address: async (url) => url.replace(`https://port-1.example`, `http://port-1.localhost`),
            forceSave: async (session) => {
                state.saved.push(session);
            },
            framed: (value) => {
                state.framed.push(value);
            },
            message: (message) => {
                state.heard.push(message);
            },
        }),
    });
};

const frames = (element: HTMLElement): HTMLIFrameElement[] => [...element.querySelectorAll(`iframe`)];

beforeEach(() => {
    prototype.moveBefore = function (this: Element, node: Node, child: Node | null) {
        this.insertBefore(node, child);
    };
});

afterEach(() => {
    for (const engine of [`server`, `browser`] as const) {
        drop(frameId(brief.path, brief.agent, brief.mode, brief.theme, engine));
        drop(frameId(brief.path, brief.agent, `view`, brief.theme, engine));
    }
    delete prototype.moveBefore;
    document.body.replaceChildren();
});

describe(`a first visit`, () => {
    it(`frames the editor at the address this browser should use, under the session the backend opened`, async () => {
        const { slot, element, opened, framed } = fake();
        expect(await slot.load(brief)).toEqual({ framed: true });
        expect(opened).toEqual([briefRequest]);
        const [frame] = frames(element);
        expect(frame?.src).toBe(`http://port-1.localhost/editor?s=one`);
        expect(frame?.hasAttribute(`inert`)).toBe(false);
        expect(framed).toEqual([true]);
    });

    it(`answers the state in the way and frames nothing while the server is not ready`, async () => {
        const state = fake();
        state.answer = async () => ({ status: { state: `starting` } });
        expect(await state.slot.load(brief)).toEqual({ status: { state: `starting` } });
        expect(frames(state.element)).toEqual([]);
        expect(state.framed).toEqual([]);
    });
});

describe(`leaving and coming back`, () => {
    it(`keeps the editor, saves what was typed now, and shows the same editor again once the backend vouches for it`, async () => {
        const first = fake();
        await first.slot.load(brief);
        const [frame] = frames(first.element);
        first.slot.leave();
        expect(first.saved).toEqual([`one`]);
        expect(frames(first.element)).toEqual([]);
        expect(frame?.isConnected).toBe(true);

        const second = fake();
        let vouch = (): void => undefined;
        second.answer = () =>
            new Promise((resolve) => {
                vouch = () => resolve({ resumed: true });
            });
        const loading = second.slot.load(brief);
        // On screen before the backend answers, but not to be typed into yet.
        expect(frames(second.element)).toHaveLength(1);
        expect(frames(second.element)[0]).toBe(frame);
        expect(frame?.hasAttribute(`inert`)).toBe(true);
        expect(second.framed).toEqual([true]);
        vouch();
        expect(await loading).toEqual({ framed: true });
        expect(frame?.hasAttribute(`inert`)).toBe(false);
        expect(second.opened).toEqual([{ ...briefRequest, resume: `one` }]);
    });

    it(`throws the kept editor away for a new one when the backend does not vouch for it`, async () => {
        const first = fake();
        await first.slot.load(brief);
        const [kept] = frames(first.element);
        first.slot.leave();

        const second = fake();
        second.answer = async () => ({ url: `https://port-1.example/editor?s=two`, session: `two`, engine: `server` });
        expect(await second.slot.load(brief)).toEqual({ framed: true });
        expect(kept?.isConnected).toBe(false);
        expect(frames(second.element).map((frame) => frame.src)).toEqual([`http://port-1.localhost/editor?s=two`]);
        expect(second.framed).toEqual([true, false, true]);
        // What is kept from here on is the new editor's session.
        second.slot.leave();
        expect(second.saved).toEqual([`two`]);
    });

    it(`throws the kept editor away when the server is no longer ready, or the backend fails`, async () => {
        const first = fake();
        await first.slot.load(brief);
        const [kept] = frames(first.element);
        first.slot.leave();
        const second = fake();
        second.answer = async () => ({ status: { state: `starting` } });
        expect(await second.slot.load(brief)).toEqual({ status: { state: `starting` } });
        expect(kept?.isConnected).toBe(false);

        const third = fake();
        await third.slot.load(brief);
        third.slot.leave();
        const fourth = fake();
        fourth.answer = async () => {
            throw new Error(`daemon unreachable`);
        };
        await expect(fourth.slot.load(brief)).rejects.toThrow(`daemon unreachable`);
        expect(frames(document.body)).toEqual([]);
    });

    it(`does not ask to save a document it only viewed`, async () => {
        const viewer = fake();
        await viewer.slot.load({ ...brief, mode: `view` });
        viewer.slot.leave();
        expect(viewer.saved).toEqual([]);
    });

    it(`lets the frame go with the viewer in a browser that cannot keep it`, async () => {
        delete prototype.moveBefore;
        const first = fake();
        await first.slot.load(brief);
        const [frame] = frames(first.element);
        first.slot.leave();
        expect(frame?.isConnected).toBe(false);
        expect(first.saved).toEqual([]);
    });
});

describe(`a load another one overtook`, () => {
    it(`frames nothing and says so`, async () => {
        const state = fake();
        let answer = (): void => undefined;
        state.answer = () =>
            new Promise((resolve) => {
                answer = () => resolve({ url: `https://port-1.example/editor?s=late`, session: `late`, engine: `server` });
            });
        const loading = state.slot.load(brief);
        state.slot.leave();
        answer();
        expect(await loading).toEqual({ superseded: true });
        expect(frames(state.element)).toEqual([]);
        expect(state.framed).toEqual([false]);
    });
});

describe(`the browser engine's page`, () => {
    const browser: Opening = { ...brief, engine: `browser` };
    const told: { message: ViewerMessage; origin: string }[] = [];
    const listen = (frame: HTMLIFrameElement | undefined): void => {
        const window = frame?.contentWindow;
        if (window === null || window === undefined) {
            throw new Error(`the frame has no window`);
        }
        // SAFETY: a stand-in that records the (message, targetOrigin) form the slot uses, the only one it calls.
        window.postMessage = ((message: ViewerMessage, origin: string) => told.push({ message, origin })) as typeof window.postMessage;
    };
    const browserFake = (): Fake => {
        const state = fake();
        state.answer = async () => ({ url: `https://port-1.example/editor?s=one`, session: `one`, engine: `browser` });
        return state;
    };

    beforeEach(() => {
        told.length = 0;
    });

    it(`is told to save by message when left, addressed to its own origin, and the backend is not asked`, async () => {
        const state = browserFake();
        await state.slot.load(browser);
        listen(frames(state.element)[0]);
        state.slot.leave();
        expect(told).toEqual([{ message: { channel: CHANNEL, type: `save` }, origin: `http://port-1.localhost` }]);
        expect(state.saved).toEqual([]);
    });

    it(`is told to save before it goes, in a browser that cannot keep it`, async () => {
        delete prototype.moveBefore;
        const state = browserFake();
        await state.slot.load(browser);
        const [frame] = frames(state.element);
        listen(frame);
        state.slot.leave();
        expect(told.map((entry) => entry.message.type)).toEqual([`save`]);
        expect(frame?.isConnected).toBe(false);
    });

    it(`is asked where things stand when it is shown again after being kept`, async () => {
        const first = browserFake();
        await first.slot.load(browser);
        const [frame] = frames(first.element);
        listen(frame);
        first.slot.leave();
        const second = browserFake();
        let vouch = (): void => undefined;
        second.answer = () =>
            new Promise((resolve) => {
                vouch = () => resolve({ resumed: true });
            });
        const loading = second.slot.load(browser);
        // jsdom gives a moved frame a new window where a browser's moveBefore keeps the old one: listen on the one it has.
        listen(frames(second.element)[0]);
        vouch();
        await loading;
        expect(told.map((entry) => entry.message.type)).toEqual([`save`, `sync`]);
    });

    it(`hands on what its own frame says from its own origin, and nothing else`, async () => {
        const state = browserFake();
        await state.slot.load(browser);
        const source = frames(state.element)[0]?.contentWindow ?? null;
        const say = (data: unknown, origin: string, from: MessageEventSource | null): void => {
            window.dispatchEvent(new MessageEvent(`message`, { data, origin, source: from }));
        };
        say({ channel: CHANNEL, type: `conflict` }, `http://port-1.localhost`, source);
        say({ channel: CHANNEL, type: `conflict` }, `https://elsewhere.example`, source);
        say({ channel: CHANNEL, type: `saved`, path: `x.docx` }, `http://port-1.localhost`, null);
        say({ channel: `other`, type: `conflict` }, `http://port-1.localhost`, source);
        expect(state.heard).toEqual([{ channel: CHANNEL, type: `conflict` }]);
        state.slot.dispose();
        say({ channel: CHANNEL, type: `dirty`, dirty: true }, `http://port-1.localhost`, source);
        expect(state.heard).toHaveLength(1);
    });

    it(`is told how a conflict was settled, asked to save again, and thrown away for a new one`, async () => {
        const state = browserFake();
        await state.slot.load(browser);
        listen(frames(state.element)[0]);
        state.slot.resolve(`copy`);
        state.slot.save();
        expect(told.map((entry) => entry.message)).toEqual([
            { channel: CHANNEL, type: `resolve`, choice: `copy` },
            { channel: CHANNEL, type: `save` },
        ]);
        state.slot.reset();
        expect(frames(state.element)).toEqual([]);
        expect(state.framed).toEqual([true, false]);
    });

    it(`is a different editor from the document server's for the same document`, () => {
        expect(frameId(`brief.docx`, undefined, `edit`, `light`, `browser`)).not.toBe(frameId(`brief.docx`, undefined, `edit`, `light`, `server`));
    });
});
