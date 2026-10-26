import { freshImport } from "@intentic/testing/bun";

// This computer's own sandboxes, offered from a hosted page only where the desktop app says it can open them
// (thisComputer.ts), and opened by the one link the app takes for them. The page's globals are swapped for plain
// objects, as the app's window would present them, and put back after each test.

const SWAPPED = [`window`, `location`, `document`] as const;
const held = SWAPPED.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);

afterEach(() => {
    for (const [name, descriptor] of held) {
        if (descriptor === undefined) {
            Reflect.deleteProperty(globalThis, name);
        } else {
            Object.defineProperty(globalThis, name, descriptor);
        }
    }
});

const load = (desktop: unknown): Promise<typeof import("./thisComputer")> => {
    Reflect.set(globalThis, `window`, { __INTENTIC_DESKTOP__: desktop });
    return freshImport<typeof import("./thisComputer")>("./thisComputer", import.meta.url);
};

const APP = { version: `1.361.0`, installId: `i-1`, update: null };

test("offered only where the app says it can open this computer's sandboxes", async () => {
    // A browser, an app from before the field, and an app on a computer with nothing to open.
    expect((await load(undefined)).thisComputerOffered()).toBe(false);
    expect((await load(APP)).thisComputerOffered()).toBe(false);
    expect((await load({ ...APP, machineFace: false })).thisComputerOffered()).toBe(false);
    expect((await load({ ...APP, machineFace: true })).thisComputerOffered()).toBe(true);
});

test("pressed, it hands the app the one link that opens them", async () => {
    const { openThisComputersSandboxes, DESKTOP_MACHINE_FACE_LINK } = await load({ ...APP, machineFace: true });
    const sent: string[] = [];
    Reflect.set(globalThis, `location`, {
        get href(): string {
            return sent.at(-1) ?? ``;
        },
        set href(link: string) {
            sent.push(link);
        },
    });
    Reflect.set(globalThis, `document`, { readyState: `complete` });

    openThisComputersSandboxes();

    expect(DESKTOP_MACHINE_FACE_LINK).toBe(`intentic://machine-face`);
    expect(sent).toEqual([`intentic://machine-face`]);
});
