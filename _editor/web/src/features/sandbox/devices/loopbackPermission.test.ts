// @vitest-environment jsdom
// jsdom for a `window`/`navigator` to hang a Permissions API off; there is no storage in this module.
import { afterEach, expect, it, vi } from "vitest";

// Chrome 142 shipped `local-network-access`; 145 split it into `local-network` (LAN) and `loopback-network`
// (this machine). The app dials 127.0.0.1 only, so it must ask under the narrow name where one exists.

// Every name this browser knows, and what it says; anything else rejects, telling apart a browser with no
// permission from one under another name.
const browserKnows = (states: Record<string, PermissionState>): { asked: string[] } => {
    const asked: string[] = [];
    Object.defineProperty(globalThis.navigator, `permissions`, {
        configurable: true,
        value: {
            query: ({ name }: PermissionDescriptor): Promise<PermissionStatus> => {
                asked.push(String(name));
                const state = states[String(name)];
                return state === undefined
                    ? Promise.reject(new TypeError(`unknown permission ${String(name)}`))
                    : Promise.resolve({ state } as PermissionStatus);
            },
        },
    });
    return { asked };
};

const load = async () => {
    vi.resetModules();
    return (await import(`./loopbackPermission`)).loopbackPermission;
};

afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, `permissions`);
    Reflect.deleteProperty(globalThis.window, `__INTENTIC_DESKTOP__`);
});

it(`asks about loopback alone where the browser draws the distinction`, async () => {
    // Chrome 145+: both names exist. Answering `denied` for the LAN one, or asking for it, would overreach.
    const { asked } = browserKnows({ 'loopback-network': `granted`, 'local-network': `denied`, 'local-network-access': `denied` });
    const loopbackPermission = await load();

    expect(await loopbackPermission()).toBe(`granted`);
    expect(asked).toEqual([`loopback-network`]);
});

it(`falls back to the name a Chrome before the split knows`, async () => {
    // Chrome 142-144: one name covers both spaces, and is the only one to ask about.
    const { asked } = browserKnows({ 'local-network-access': `prompt` });
    const loopbackPermission = await load();

    expect(await loopbackPermission()).toBe(`prompt`);
    expect(asked).toEqual([`loopback-network`, `local-network-access`]);
});

// Not an error: every pre-142 browser, and every WebKit/Firefox. Nothing gates the reach, so the app probes
// without asking — refusing to use a working address would be the worse default.
it(`reads a browser that knows neither name as having no gate`, async () => {
    browserKnows({});
    expect(await (await load())()).toBe(`ungated`);
});

it(`reads a browser with no Permissions API at all the same way`, async () => {
    Reflect.deleteProperty(globalThis.navigator, `permissions`);
    expect(await (await load())()).toBe(`ungated`);
});

// Asked once per document: a query per reconnect would be a query per network blip, and the held object stays
// live so a site-settings revoke still reaches the next call.
it(`asks the browser once and holds what it answered with`, async () => {
    const { asked } = browserKnows({ 'loopback-network': `prompt` });
    const loopbackPermission = await load();

    expect(await loopbackPermission()).toBe(`prompt`);
    expect(await loopbackPermission()).toBe(`prompt`);
    expect(asked).toEqual([`loopback-network`]);
});

// The desktop webview doesn't gate the reach, so Chrome is never queried.
it(`takes the desktop webview's word without asking the browser`, async () => {
    const { asked } = browserKnows({ 'loopback-network': `prompt` });
    globalThis.window.__INTENTIC_DESKTOP__ = { version: `1.2.3`, installId: `i`, update: null, loopbackUngated: true };

    expect(await (await load())()).toBe(`ungated`);
    expect(asked).toEqual([]);
});
