import "@intentic/testing/dom";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

// The install log's Copy: a browser that refuses the write (an unfocused window, a denied permission) used to reject out
// of the press with nothing to catch it; now the press settles and the button never claims a copy that did not happen.
// The app is Tauri's own IPC mock, answering nothing.

mockIPC(() => undefined);
// The kit's device readout (reached through ./machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});
const { copyLog, logCopied } = await import("./setup");

const held = Object.getOwnPropertyDescriptor(navigator, `clipboard`);
afterEach(() => {
    if (held === undefined) {
        Reflect.deleteProperty(navigator, `clipboard`);
    } else {
        Object.defineProperty(navigator, `clipboard`, held);
    }
});
afterAll(() => clearMocks());

const clipboard = (writeText: (text: string) => Promise<void>): void => {
    Object.defineProperty(navigator, `clipboard`, { value: { writeText }, configurable: true });
};

test("a refused clipboard write settles the press and leaves Copy reading as Copy", async () => {
    clipboard(async () => {
        throw new DOMException(`Document is not focused.`, `NotAllowedError`);
    });

    await expect(copyLog()).resolves.toBeUndefined();
    expect(logCopied.value).toBe(false);
});

test("a write that lands says Copied", async () => {
    const written: string[] = [];
    clipboard(async (text) => {
        written.push(text);
    });

    await copyLog();
    expect({ copied: logCopied.value, writes: written.length }).toEqual({ copied: true, writes: 1 });
});
