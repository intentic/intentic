import "@intentic/testing/dom";
import { copyNatively, NATIVE_COPY_EVENT, type NativeEvent } from "./nativeCopy";

// The page's half of handing a drop to the desktop app: what it posts, which answers it takes as its own, and that a
// drop never waits on an app that does not answer.

// What the page posts, as far as these tests read it.
interface Posted {
    readonly intentic?: string;
    readonly id?: string;
    readonly port?: number;
    readonly target?: string;
    readonly skip?: { readonly dirs: readonly string[] };
    readonly manifests?: readonly string[];
}

// Each message read back from the JSON string it goes as: an object would stop at Tauri's own handler.
const posted: { message: Posted; objects?: ArrayLike<unknown> }[] = [];
const read = (message: unknown): Posted => {
    expect(typeof message).toBe(`string`);
    return JSON.parse(message as string) as Posted;
};
const bridge = {
    postMessage: (message: unknown) => posted.push({ message: read(message) }),
    postMessageWithAdditionalObjects: (message: unknown, objects: ArrayLike<unknown>) => posted.push({ message: read(message), objects }),
};

// The app's answer, as its drop_copy.rs dispatches it.
const answer = (detail: Record<string, unknown>): void => {
    window.dispatchEvent(new CustomEvent(NATIVE_COPY_EVENT, { detail }));
};

beforeEach(() => {
    posted.length = 0;
    (globalThis as { chrome?: unknown }).chrome = { webview: bridge };
});

afterEach(() => {
    jest.useRealTimers();
});

const DROP = { files: [new File([`x`], `marketing`)], port: 28_123 };

describe(`a drop handed to the desktop app`, () => {
    it(`posts the files with the request, and hears only the answers to it`, async () => {
        const heard: NativeEvent[] = [];
        const outcome = copyNatively(DROP, `media`, new AbortController().signal, (event) => heard.push(event));
        const { message, objects } = posted[0] ?? { message: {} };
        expect([message.intentic, message.port, message.target, objects]).toEqual([`drop-copy`, 28_123, `media`, DROP.files]);
        expect(message.skip?.dirs).toContain(`node_modules`);
        expect(message.manifests?.includes(`package.json`)).toBe(true);
        answer({ id: `someone-else`, kind: `finished`, done: 9, doneBytes: 9, sentBytes: 9, failed: 0 });
        answer({ id: message.id, kind: `received` });
        answer({ id: message.id, kind: `finished`, done: 1, doneBytes: 1, sentBytes: 1, failed: 0 });
        expect(await outcome).toBe(`handled`);
        expect(heard.map((event) => event.kind)).toEqual([`received`, `finished`]);
    });

    it(`goes back to the browser when the app declines it`, async () => {
        const outcome = copyNatively(DROP, ``, new AbortController().signal, () => {});
        answer({ id: posted[0]?.message.id, kind: `declined`, reason: `small` });
        expect(await outcome).toBe(`declined`);
    });

    it(`goes back to the browser when the app never answers, and tells the app to let go`, async () => {
        jest.useFakeTimers();
        const outcome = copyNatively(DROP, ``, new AbortController().signal, () => {});
        jest.advanceTimersByTime(5000);
        expect(await outcome).toBe(`declined`);
        expect(posted[1]?.message).toEqual({ intentic: `drop-copy-cancel`, id: posted[0]?.message.id });
    });

    it(`is cancelled in the app when the card's Cancel aborts it`, async () => {
        const controller = new AbortController();
        const outcome = copyNatively(DROP, ``, controller.signal, () => {});
        answer({ id: posted[0]?.message.id, kind: `received` });
        controller.abort();
        expect(await outcome).toBe(`handled`);
        expect(posted[1]?.message).toEqual({ intentic: `drop-copy-cancel`, id: posted[0]?.message.id });
    });
});
