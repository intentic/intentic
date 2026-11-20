import { sandboxRef } from "@intentic/extension-api";
import { z } from "zod";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { deviceTerminalsKey, storedJson, storeJson } from "../../app/storage/browserStorage";
import { currentSandboxTarget } from "../../client/sandbox/sandboxTarget";
import { type TerminalDoor, TerminalGone, type TerminalParams } from "./terminalDoor";
import type { TerminalTab } from "../../features/terminal/useTerminal";
import { type RemoteApi, type RemoteGrant, remoteApi, sessionGone } from "../sandbox/devices/remote/remoteApi";
import { tokenKeeper } from "../sandbox/devices/remote/remoteToken";

// SHELLS ON THE OWNER'S CONNECTED COMPUTERS, AS TABS OF THE TERMINAL PANEL. A device terminal is the computer's own
// session (its remoted keeps it across reloads and viewers), reached on /system/device-terminal with a token the
// sandbox hands out and renews; the panel draws it as any other tab and its xterm speaks the same protocol
// (terminalSession.ts, through the door below). Which ones this browser has open is kept per sandbox in this browser,
// so a reload reattaches them; one the computer no longer has (closed there, or its remoted restarted) ends as an exit
// would the first time it is dialled. Closing the tab closes the session on the computer.

export interface DeviceTerminal {
    // The tab's name: `device~<device>~<session>`.
    readonly name: string;
    // The connection the remote procedures name (`rog`, `rog::wsl:archlinux`).
    readonly device: string;
    readonly session: string;
    // What the tab says: the computer, then where on it the shell runs.
    readonly title: string;
    readonly environment: string;
    readonly openedAt: number;
}

const PREFIX = `device~`;

/** A device terminal's tab name, unique per sandbox: the session id is the computer's own. */
export const deviceTabName = (device: string, session: string): string => `${PREFIX}${device}~${session}`;
export const isDeviceTab = (name: string): boolean => name.startsWith(PREFIX);

const StoredSchema = z.array(
    z.object({
        name: z.string(),
        device: z.string(),
        session: z.string(),
        title: z.string(),
        environment: z.string(),
        openedAt: z.number(),
    }),
);

const storageKey = (): string => deviceTerminalsKey(activeSandboxId.value ?? `local`);
// The tabs this browser holds open, per sandbox: read back from its own key on a switch.
const held = sandboxRef<DeviceTerminal[]>(() => storedJson(storageKey(), StoredSchema.catch([])) ?? []);
const persist = (): void => {
    storeJson(storageKey(), held.value);
};

// The grant an open or an attach just answered with, kept for the tab's first dial so it is not asked twice.
const grants = new Map<string, RemoteGrant>();

/** Holds a device terminal as a tab of this browser's, with the grant that opened it when there is one. */
export const holdDeviceTerminal = (terminal: Omit<DeviceTerminal, `name` | `openedAt`>, grant?: RemoteGrant): DeviceTerminal => {
    const name = deviceTabName(terminal.device, terminal.session);
    if (grant !== undefined) {
        grants.set(name, grant);
    }
    const existing = held.value.find((entry) => entry.name === name);
    if (existing !== undefined) {
        return existing;
    }
    const entry = { ...terminal, name, openedAt: Date.now() };
    held.value = [...held.value, entry];
    persist();
    return entry;
};

/** Lets a tab go: closed in the panel, or ended on the computer. */
export const forgetDeviceTerminal = (name: string): void => {
    grants.delete(name);
    if (held.value.some((entry) => entry.name === name)) {
        held.value = held.value.filter((entry) => entry.name !== name);
        persist();
    }
};

/** The device terminals as the panel lists its tabs; running until the computer says otherwise. */
export const deviceTerminalTabs = (): TerminalTab[] =>
    held.value.map((entry) => ({ name: entry.name, label: entry.title, kind: `device`, running: true, activityAt: 0 }));

export const heldDeviceTerminal = (name: string): DeviceTerminal | undefined => held.value.find((entry) => entry.name === name);

// The query the device's terminal route takes: its token, and the attach's grid, sight and deflate as on the sandbox's
// own route; the session is in the path, and a computer's shell starts where its environment starts.
const deviceQuery = (token: string, params: TerminalParams): string => {
    const query = new URLSearchParams({ token, cols: params.cols, rows: params.rows });
    if (params.away !== undefined) {
        query.set(`away`, params.away);
    }
    if (params.deflate !== undefined) {
        query.set(`deflate`, params.deflate);
    }
    return query.toString();
};

/** What a door reaches: the remote api, the sandbox's base, and the clock its renewals run on; a test's to replace. */
export interface DoorSeams {
    readonly api?: RemoteApi;
    readonly base?: () => string | undefined;
    readonly later?: (run: () => void, ms: number) => () => void;
}

// A refusal that the session is not on the computer any more ends the tab; any other is a dial to try again.
const orGone = async <T>(ask: () => Promise<T>): Promise<T> => {
    try {
        return await ask();
    } catch (error) {
        throw error instanceof Error && sessionGone(error) ? new TerminalGone(error.message) : error;
    }
};

/**
 * Where a device terminal's socket dials. Its first dial uses the grant it was opened or attached with, or attaches
 * afresh (after a reload); every later dial renews the token first, so a socket the computer closed for its token
 * (4001, 4002) comes back with a live one. While open, the token is renewed before it lapses and handed to the socket.
 */
export const deviceDoor = (terminal: Pick<DeviceTerminal, `name` | `device` | `session`>, seams: DoorSeams = {}): TerminalDoor => {
    const api = seams.api ?? remoteApi;
    let path: string | undefined;
    let send: ((token: string) => void) | undefined;
    const keeper = tokenKeeper({
        refresh: () => api.refresh(terminal.device, terminal.session),
        renewed: (token) => send?.(token.token),
        later: seams.later,
    });
    const grantOf = async (): Promise<RemoteGrant> => {
        const granted = grants.get(terminal.name);
        grants.delete(terminal.name);
        return granted ?? orGone(() => api.attachTerminal(terminal.device, terminal.session));
    };
    return {
        address: async (params) => {
            let token: string;
            if (path === undefined) {
                const grant = await grantOf();
                keeper.take(grant);
                [path, token] = [grant.path, grant.token];
            } else {
                token = await orGone(keeper.fresh);
            }
            const base = (seams.base ?? (() => currentSandboxTarget()?.base))();
            return base === undefined ? undefined : { base, path, query: deviceQuery(token, params) };
        },
        opened: (say) => {
            send = (token) => say({ type: `token`, token });
        },
        dispose: () => {
            send = undefined;
            keeper.dispose();
        },
    };
};

/** The terminal panel's door for a tab: a device terminal's own, or the sandbox's (undefined). */
export const deviceDoorFor = (tab: TerminalTab): TerminalDoor | undefined => {
    const terminal = tab.kind === `device` ? heldDeviceTerminal(tab.name) : undefined;
    return terminal === undefined ? undefined : deviceDoor(terminal);
};

/** Closes a device terminal on its computer; the tab is already gone, and a refusal is only logged. */
export const closeDeviceTerminal = async (name: string, api: RemoteApi = remoteApi): Promise<void> => {
    const terminal = heldDeviceTerminal(name);
    forgetDeviceTerminal(name);
    if (terminal === undefined) {
        return;
    }
    try {
        await api.closeTerminal(terminal.device, terminal.session);
    } catch (error) {
        console.error(`device terminal ${name}: close failed`, error);
    }
};
