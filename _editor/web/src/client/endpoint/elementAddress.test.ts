import { elementAddress } from "./elementAddress";

// The host's resolver is read on every call, so one injected after the module loaded still takes effect.
interface Host {
    window?: { __INTENTIC_ELEMENT_ADDRESS__?: (url: string) => string };
}
// SAFETY: tests run without a page; `window` is the one global this module reads, set and removed here.
const host = globalThis as Host;

afterEach(() => {
    delete host.window;
});

test("an address is handed over unchanged when the host names no stand-in", () => {
    host.window = {};
    expect(elementAddress(`https://sandbox.example.dev/workspace/media?path=a.mp4&ticket=t`)).toBe(`https://sandbox.example.dev/workspace/media?path=a.mp4&ticket=t`);
});

test("an address is handed over unchanged outside a page", () => {
    expect(elementAddress(`https://sandbox.example.dev/workspace/download?ticket=t`)).toBe(`https://sandbox.example.dev/workspace/download?ticket=t`);
});

test("the host's resolver names the address an element loads", () => {
    const asked: string[] = [];
    host.window = {
        __INTENTIC_ELEMENT_ADDRESS__: (url) => {
            asked.push(url);
            return `/relay/${encodeURIComponent(url)}`;
        },
    };
    expect(elementAddress(`https://sandbox.example.dev/x`)).toBe(`/relay/${encodeURIComponent(`https://sandbox.example.dev/x`)}`);
    expect(asked).toEqual([`https://sandbox.example.dev/x`]);
});
