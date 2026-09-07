// @vitest-environment jsdom
//
// jsdom for a `window` and a `navigator` to hang a Permissions API off; there is no storage in this module.
import { afterEach, expect, it, vi } from "vitest";

/* THE NAME, which is the one thing here a caller cannot see and the one thing Chrome has already changed once.
 * 142 shipped `local-network-access`; 145 split it into `local-network` for the LAN and `loopback-network` for
 * this machine. The app dials 127.0.0.1 and nothing else, so it must ask under the narrow name where there is
 * one — asking under the old one reports on a permission covering the user's whole network, which this app has
 * never wanted and must not imply it has. */

/// Every name this browser knows about, and what it says about each. Anything else rejects, which is how a
/// browser without the permission is told from one that has it under another name.
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
    // Chrome 145 and after: both names exist. Answering `denied` for the LAN one would be the wrong answer to
    // report, and asking for it at all would be asking for more than this app uses.
    const { asked } = browserKnows({ 'loopback-network': `granted`, 'local-network': `denied`, 'local-network-access': `denied` });
    const loopbackPermission = await load();

    expect(await loopbackPermission()).toBe(`granted`);
    expect(asked).toEqual([`loopback-network`]);
});

it(`falls back to the name a Chrome before the split knows`, async () => {
    // 142 to 144: one permission, covering both spaces, and the only one there is to ask about.
    const { asked } = browserKnows({ 'local-network-access': `prompt` });
    const loopbackPermission = await load();

    expect(await loopbackPermission()).toBe(`prompt`);
    expect(asked).toEqual([`loopback-network`, `local-network-access`]);
});

/* A BROWSER THAT KNOWS NEITHER NAME IS NOT AN ERROR, it is every browser before Chrome 142 and every WebKit and
 * Firefox since. Nothing gates the reach there, so the answer is `ungated` and the app probes without asking
 * anyone — the alternative is refusing to use an address that works on the strength of not having been able to
 * ask about it. */
it(`reads a browser that knows neither name as having no gate`, async () => {
    browserKnows({});
    expect(await (await load())()).toBe(`ungated`);
});

it(`reads a browser with no Permissions API at all the same way`, async () => {
    Reflect.deleteProperty(globalThis.navigator, `permissions`);
    expect(await (await load())()).toBe(`ungated`);
});

/* Asked once per document. This runs on every reconnect, and a query per reconnect would be a query per network
 * blip — while the object it holds is live, so a grant revoked in site settings still reaches the next call. */
it(`asks the browser once and holds what it answered with`, async () => {
    const { asked } = browserKnows({ 'loopback-network': `prompt` });
    const loopbackPermission = await load();

    expect(await loopbackPermission()).toBe(`prompt`);
    expect(await loopbackPermission()).toBe(`prompt`);
    expect(asked).toEqual([`loopback-network`]);
});

/* The desktop app answers before Chrome is reached: its workspace webview does not gate the reach, so there is
 * nothing to query and nothing to explain to the user (desktop-app windows.rs). */
it(`takes the desktop webview's word without asking the browser`, async () => {
    const { asked } = browserKnows({ 'loopback-network': `prompt` });
    globalThis.window.__INTENTIC_DESKTOP__ = { version: `1.2.3`, installId: `i`, update: null, loopbackUngated: true };

    expect(await (await load())()).toBe(`ungated`);
    expect(asked).toEqual([]);
});
