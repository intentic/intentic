import type { InvokeArgs } from "@tauri-apps/api/core";
import { sleep } from "@intentic/base/async";
import type { KeyringState } from "@intentic/sandbox-contract/schemas/keyring";
import type { KeyringEntry, KeyringStatus, NewKeyringEntry } from "../src/desktop";

// The keyring's half of the app stood in for on a dev server (devDesktop.ts), kept apart from the rest of it.

const NOW_S = Math.floor(Date.now() / 1000);

/* THE KEYRING ON THIS COMPUTER (src-tauri/src/keyring.rs), as `intentic-machine keyring … --json` answers: one line of
   JSON. Set up, locked, one password shared with the sandbox this machine links; every change takes a moment, standing in
   for the prompt the keyring raises on the computer, so This device's "Confirm on this computer" can be seen. */
const SHOP_URL = `https://shop-574ea8038415.intentic.app`;
let devKeyringLocked = true;
let devAskpass = false;
let devKeyringEntries: KeyringEntry[] = [
    {
        name: `VPN_PASSWORD`,
        kind: `password`,
        programs: [`FortiClient.exe`],
        packages: [],
        hosts: [`vpn.example.com`],
        anyField: false,
        askpass: [],
        source: `keyring`,
        shares: [{ sandbox: SHOP_URL, machine: `rog`, mode: `each-use`, sharedAt: NOW_S * 1000 }],
        createdAt: NOW_S * 1000,
        updatedAt: NOW_S * 1000,
    },
];
const DONE_LINE = JSON.stringify({ ok: true });
const keyringStatusLine = (): string => {
    const state: KeyringState = {
        version: `1.318.0`,
        locked: devKeyringLocked,
        unlock: [`hello`, `passphrase`],
        keys: { seal: `A`.repeat(43), inbox: `B`.repeat(43) },
        pendingInbox: devKeyringLocked ? 1 : 0,
    };
    if (!devKeyringLocked) {
        state.unlockedUntil = Date.now() + 15 * 60_000;
    }
    const status: KeyringStatus = { installed: true, running: true, setUp: true, state, askpass: { installed: devAskpass } };
    return JSON.stringify({ ok: true, ...status });
};
const textArg = (args: InvokeArgs | undefined, key: string): string => {
    if (args === undefined || Array.isArray(args) || args instanceof ArrayBuffer || args instanceof Uint8Array) {
        return ``;
    }
    const value = args[key];
    return value === undefined ? `` : String(value);
};
export const keyringVerb = (command: string, args: InvokeArgs | undefined): string | Promise<string> | undefined => {
    const prompted = (effect: () => void): Promise<string> =>
        sleep(1500).then(() => {
            effect();
            return DONE_LINE;
        });
    switch (command) {
        case `keyring_status`:
            return keyringStatusLine();
        case `keyring_list`:
            return JSON.stringify({ ok: true, entries: devKeyringEntries, backends: [] });
        case `keyring_setup`:
            return prompted(() => undefined);
        case `keyring_unlock`:
            return prompted(() => {
                devKeyringLocked = false;
            });
        case `keyring_lock`:
            devKeyringLocked = true;
            return DONE_LINE;
        case `keyring_askpass`:
            return prompted(() => {
                devAskpass = textArg(args, `action`) === `install`;
            });
        case `keyring_harden`:
            return prompted(() => undefined);
        case `keyring_remove`:
            return prompted(() => {
                devKeyringEntries = devKeyringEntries.filter((entry) => entry.name !== textArg(args, `name`));
            });
        case `keyring_add`: {
            if (args === undefined || !(`entry` in args)) {
                return undefined;
            }
            // SAFETY: the page's own desktop.ts sends it, as `keyringAdd` types it; the value beside it is never kept here.
            const entry = args[`entry`] as NewKeyringEntry;
            return prompted(() => {
                devKeyringEntries = [
                    ...devKeyringEntries,
                    { ...entry, askpass: [], source: `keyring`, shares: [], createdAt: Date.now(), updatedAt: Date.now() },
                ];
            });
        }
        case `keyring_share`:
            return prompted(() => {
                const mode = textArg(args, `mode`);
                const shared = devKeyringEntries.find((entry) => entry.name === textArg(args, `name`));
                if (shared !== undefined && (mode === `each-use` || mode === `while-here` || mode === `copy`)) {
                    devKeyringEntries = devKeyringEntries.map((entry) =>
                        entry === shared
                            ? { ...entry, shares: [...entry.shares, { sandbox: textArg(args, `sandbox`), machine: `rog`, mode, sharedAt: Date.now() }] }
                            : entry,
                    );
                }
            });
        default:
            return undefined;
    }
};
