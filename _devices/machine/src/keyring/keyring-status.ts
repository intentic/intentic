import { KeyringUnavailable } from "@intentic/keyring";
import type { Item } from "@intentic/local-agent";
import { type KeyringState, localZone, wallClockIn } from "@intentic/sandbox-contract";
import { askpassStatus } from "./askpass.js";
import { hardenedHere, keyringInstalled, keyringState } from "./service.js";

// THE KEYRING AS EVERY SURFACE SAYS IT: `keyring status`, and the one line `status` and `doctor` give it. Installed is
// the binary beside this agent; running is its pipe answering within a moment; set up and locked are its own answer.

export interface KeyringSummary {
    readonly installed: boolean;
    readonly running: boolean;
    readonly setUp: boolean;
    readonly state?: KeyringState;
}

export const readKeyringSummary = async (): Promise<KeyringSummary> => {
    const state = await keyringState();
    const running = !(state instanceof KeyringUnavailable);
    const summary: KeyringSummary = { installed: keyringInstalled(), running, setUp: running && state.ok && state.setUp };
    return running && state.ok ? { ...summary, state: state.state } : summary;
};

// Whether ssh, sudo and git ask intentic-askpass, and where it is.
export interface AskpassAnswer {
    readonly installed: boolean;
    readonly path?: string;
}

export const readAskpassAnswer = async (): Promise<AskpassAnswer> => {
    const status = await askpassStatus();
    return status.path === undefined ? { installed: status.installed } : { installed: status.installed, path: status.path };
};

// What `keyring status --json` answers.
export interface KeyringStatusAnswer extends KeyringSummary {
    readonly ok: true;
    readonly askpass: AskpassAnswer;
    // Whether the vault is under the hardened service (Windows), which the desktop app's Hardened mode row reads.
    readonly hardened: boolean;
}

export const readKeyringStatus = async (): Promise<KeyringStatusAnswer> => {
    const [summary, askpass, hardened] = await Promise.all([readKeyringSummary(), readAskpassAnswer(), hardenedHere()]);
    return { ok: true, ...summary, askpass, hardened };
};

// An instant as the person at this computer reads it, on this computer's own clock.
export const clock = (ms: number): string => wallClockIn(ms, localZone());

/** The keyring's one row: not installed, not running, not set up, or running and locked or unlocked. Pure. */
export const keyringLine = (line: KeyringStatusLine): Item => {
    if (!line.installed) {
        return { tone: "skip", name: "keyring", meta: "not installed (`intentic-machine keyring setup`)" };
    }
    if (!line.running) {
        return { tone: "fail", name: "keyring", meta: "installed, not running (`intentic-machine keyring setup` starts it)" };
    }
    if (!line.setUp) {
        return { tone: "warn", name: "keyring", meta: "running, not set up (`intentic-machine keyring setup`)" };
    }
    const lockWords = line.locked === false ? `unlocked${line.unlockedUntil === undefined ? "" : ` until ${clock(line.unlockedUntil)}`}` : "locked";
    return { tone: "ok", name: "keyring", meta: `running${line.version === undefined ? "" : ` ${line.version}`} · ${lockWords}` };
};

// The keyring as `status --json` carries it: small, and nothing of its keys.
export interface KeyringStatusLine {
    readonly installed: boolean;
    readonly running: boolean;
    readonly setUp: boolean;
    readonly locked?: boolean;
    readonly unlockedUntil?: number;
    readonly version?: string;
}

export const keyringStatusLine = (summary: KeyringSummary): KeyringStatusLine => {
    const line: KeyringStatusLine = { installed: summary.installed, running: summary.running, setUp: summary.setUp };
    if (summary.state === undefined) {
        return line;
    }
    const known = { ...line, locked: summary.state.locked, version: summary.state.version };
    return summary.state.unlockedUntil === undefined ? known : { ...known, unlockedUntil: summary.state.unlockedUntil };
};
