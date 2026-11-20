// A shell on a connected computer as a terminal tab: held per sandbox so a reload reattaches it, dialled on the path and
// token its grant named, the token renewed for every later dial and on the open socket, and a session the computer no
// longer has ended as an exit would rather than retried for ever.
import "@intentic/testing/dom";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { TerminalGone, type TerminalParams } from "./terminalDoor";
import type { RemoteApi, RemoteGrant } from "../sandbox/devices/remote/remoteApi";
import {
    deviceDoor,
    deviceTabName,
    deviceTerminalTabs,
    forgetDeviceTerminal,
    heldDeviceTerminal,
    holdDeviceTerminal,
    isDeviceTab,
} from "./deviceTerminals";

const BASE = `https://rog-box.sandbox.example`;
const PARAMS: TerminalParams = { session: `ignored`, cols: `120`, rows: `32`, deflate: `1` };
const grant = (token: string): RemoteGrant => ({ session: `t-1`, path: `/system/device-terminal/rog/t-1`, token, expiresAt: Date.now() + 120_000 });

const fakeApi = (overrides: Partial<RemoteApi> = {}) => {
    const calls: string[] = [];
    let issued = 0;
    const api: RemoteApi = {
        status: () => Promise.reject(new Error(`unexpected status`)),
        openScreen: () => Promise.reject(new Error(`unexpected openScreen`)),
        openTerminal: () => Promise.reject(new Error(`unexpected openTerminal`)),
        attachTerminal: async (device, session) => {
            calls.push(`attach ${device} ${session}`);
            return grant(`attached`);
        },
        refresh: async (device, session) => {
            issued += 1;
            calls.push(`refresh ${device} ${session}`);
            return { token: `fresh-${issued}`, expiresAt: Date.now() + 120_000 };
        },
        closeTerminal: async () => undefined,
        ...overrides,
    };
    return { api, calls };
};

const terminal = { name: deviceTabName(`rog`, `t-1`), device: `rog`, session: `t-1` };

afterEach(() => forgetDeviceTerminal(terminal.name));

it("names a device tab apart from the sandbox's own sessions", () => {
    expect(terminal.name).toBe(`device~rog~t-1`);
    expect([isDeviceTab(terminal.name), isDeviceTab(`web-3a2b`)]).toEqual([true, false]);
});

it("holds a device terminal as a tab of this browser's, once, until it is let go", () => {
    holdDeviceTerminal({ device: `rog`, session: `t-1`, title: `rog · Windows`, environment: `native` });
    holdDeviceTerminal({ device: `rog`, session: `t-1`, title: `rog · Windows`, environment: `native` });
    expect(deviceTerminalTabs()).toEqual([{ name: `device~rog~t-1`, label: `rog · Windows`, kind: `device`, running: true, activityAt: 0 }]);
    forgetDeviceTerminal(terminal.name);
    expect(deviceTerminalTabs()).toEqual([]);
    expect(heldDeviceTerminal(terminal.name)).toBeUndefined();
});

it("dials its first socket on the grant it was opened with, and renews the token for every later dial", async () => {
    const { api, calls } = fakeApi();
    holdDeviceTerminal({ device: `rog`, session: `t-1`, title: `rog · Windows`, environment: `native` }, grant(`opened`));
    const door = deviceDoor(terminal, { api, base: () => BASE, later: () => () => undefined });
    await expect(door.address(PARAMS)).resolves.toEqual({
        base: BASE,
        path: `/system/device-terminal/rog/t-1`,
        query: `token=opened&cols=120&rows=32&deflate=1`,
    });
    expect(calls).toEqual([]);
    await expect(door.address({ ...PARAMS, away: `1` })).resolves.toMatchObject({ query: `token=fresh-1&cols=120&rows=32&away=1&deflate=1` });
    expect(calls).toEqual([`refresh rog t-1`]);
    door.dispose?.();
});

it("attaches afresh after a reload, when it holds no grant", async () => {
    const { api, calls } = fakeApi();
    const door = deviceDoor(terminal, { api, base: () => BASE, later: () => () => undefined });
    await expect(door.address(PARAMS)).resolves.toMatchObject({ query: `token=attached&cols=120&rows=32&deflate=1` });
    expect(calls).toEqual([`attach rog t-1`]);
});

it("ends the tab when the computer no longer has the session, rather than dialling it again and again", async () => {
    const { api } = fakeApi({
        attachTerminal: () => Promise.reject(new SandboxHttpError(404, `No terminal t-1 on rog.`)),
    });
    const door = deviceDoor(terminal, { api, base: () => BASE, later: () => () => undefined });
    await expect(door.address(PARAMS)).rejects.toBeInstanceOf(TerminalGone);
    // Anything else (the computer asleep, the sandbox restarting) is a dial to try again.
    const offline = deviceDoor(terminal, {
        api: fakeApi({ attachTerminal: () => Promise.reject(new SandboxHttpError(409, `rog is offline.`)) }).api,
        base: () => BASE,
    });
    await expect(offline.address(PARAMS)).rejects.toMatchObject({ status: 409 });
});

it("hands a renewed token to the open socket before the old one lapses", async () => {
    const { api } = fakeApi();
    const timers: (() => void)[] = [];
    const door = deviceDoor(terminal, {
        api,
        base: () => BASE,
        later: (run) => {
            timers.push(run);
            return () => undefined;
        },
    });
    await door.address(PARAMS);
    const said: unknown[] = [];
    door.opened?.((message) => said.push(message));
    timers.at(-1)!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(said).toEqual([{ type: `token`, token: `fresh-1` }]);
});
