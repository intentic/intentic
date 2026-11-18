import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { helloHere, KeyringUnavailable, NOT_ON_MAC, realRunner } from "@intentic/keyring";
import type { Item } from "@intentic/local-agent";
import type { KeyringState } from "@intentic/sandbox-contract/schemas/keyring";
import { localZone, wallClockIn } from "@intentic/sandbox-contract/time/zone";
import { askpassStatus } from "./askpass.js";
import { keyringInstalled, keyringState, raiseRunningKeyring, serviceDown, serviceHere } from "./service.js";

// THE KEYRING AS EVERY SURFACE SAYS IT: `keyring status`, and the one line `status` and `doctor` give it. Installed is
// the binary beside this agent; running is its pipe answering within a moment; set up and locked are its own answer.

export interface KeyringSummary {
    readonly installed: boolean;
    readonly running: boolean;
    readonly setUp: boolean;
    readonly state?: KeyringState;
    // Passwords' protected service is installed, and its session helper runs, but the service behind it does not
    // answer: the vault is there and nothing can reach it. Only ever `true` (an agent from before says nothing).
    readonly serviceDown?: true;
    // Passwords' protected service is installed, and the session helper in front of it does not answer: not running,
    // and set up or not is unknown, never "not set up" (`keyring start` starts it). Only ever `true`.
    readonly serviceInstalled?: true;
}

// How long the keyring is given to answer, asked once. A computer with no keyring running has no pipe, which says so at
// once, so only a keyring that is there and slow is waited on. It used to be asked twice, quickly and then for longer,
// with `whoami` between: a helper slow on a busy computer cost all three and still read as not running, which the
// desktop app showed as Passwords not answering after ten seconds or more.
const PATIENT_STATE_MS = 10_000;

// Passwords' service installed, its helper silent: set up or not is unknown, never "not set up". A helper its logon task
// started below normal priority is raised first, which is what kept it from answering on a busy computer.
const patientState = async (): Promise<Awaited<ReturnType<typeof keyringState>> | "service-installed"> => {
    await raiseRunningKeyring();
    const state = await keyringState(PATIENT_STATE_MS);
    return state instanceof KeyringUnavailable && (await serviceHere()) ? "service-installed" : state;
};

export const readKeyringSummary = async (): Promise<KeyringSummary> => {
    const state = await patientState();
    if (state === "service-installed") {
        return { installed: keyringInstalled(), running: false, setUp: false, serviceInstalled: true };
    }
    const running = !(state instanceof KeyringUnavailable);
    const summary: KeyringSummary = { installed: keyringInstalled(), running, setUp: running && state.ok && state.setUp };
    if (serviceDown(state) && (await serviceHere())) {
        return { ...summary, serviceDown: true };
    }
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

// Whether Passwords can be set up here, and why not when it cannot: what the desktop app reads before it offers setup.
export interface KeyringSupport {
    readonly canSetUp: boolean;
    readonly why?: string;
    // Whether the daily unlock is a Windows Hello tap (Linux's is polkit's, the person's own password).
    readonly hello: boolean;
    readonly platform: "windows" | "linux" | "darwin";
}

// What the Linux service needs: systemd to run it, polkit to ask the person, setfacl to open its door to one user.
const LINUX_NEEDS = [
    { program: "systemctl", what: "systemd" },
    { program: "pkexec", what: "polkit (pkexec)" },
    { program: "pkcheck", what: "polkit (pkcheck)" },
    { program: "setfacl", what: "the acl tools (setfacl)" },
] as const;

const onPath = (program: string, env: NodeJS.ProcessEnv): boolean =>
    (env["PATH"] ?? "")
        .split(delimiter)
        .filter((dir) => dir !== "")
        .some((dir) => existsSync(join(dir, program)));

/**
 * Whether this platform can hold Passwords' protected service, said in a sentence when it cannot. Whether this account
 * may get an administrator's yes is not known until it is asked: setup says so then. Pure but for the file checks.
 */
export const supportOf = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env, booted: () => boolean = () => existsSync("/run/systemd/system")): Omit<KeyringSupport, "hello"> => {
    if (platform === "win32") {
        return { canSetUp: true, platform: "windows" };
    }
    if (platform === "darwin") {
        return { canSetUp: false, why: NOT_ON_MAC, platform: "darwin" };
    }
    if (platform !== "linux") {
        return { canSetUp: false, why: `Passwords' protected service is not built for ${platform}.`, platform: "linux" };
    }
    const missing: string[] = LINUX_NEEDS.filter((need) => !onPath(need.program, env)).map((need) => need.what);
    if (!booted()) {
        missing.unshift("systemd running as this computer's init");
    }
    return missing.length === 0
        ? { canSetUp: true, platform: "linux" }
        : { canSetUp: false, why: `Passwords' protected service needs ${missing.join(", ")}, which this computer does not have.`, platform: "linux" };
};

const readSupport = async (summary: KeyringSummary): Promise<KeyringSupport> => {
    const base = supportOf(process.platform);
    // A running service says how it unlocks. Only a computer that may be offered setup asks Windows whether Hello could
    // sign here, a PowerShell start of a second or more: one whose service is installed and silent is offered a start or
    // a repair instead, never setup, so it is not asked.
    if (summary.state !== undefined) {
        return { ...base, hello: summary.state.unlock.includes("hello") };
    }
    const offeredSetup = !summary.setUp && summary.serviceInstalled !== true && summary.serviceDown !== true;
    return { ...base, hello: offeredSetup && base.canSetUp && (await helloHere(realRunner)) };
};

// What `keyring status --json` answers.
export interface KeyringStatusAnswer extends KeyringSummary {
    readonly ok: true;
    readonly askpass: AskpassAnswer;
    readonly support: KeyringSupport;
}

export const readKeyringStatus = async (): Promise<KeyringStatusAnswer> => {
    const [summary, askpass] = await Promise.all([readKeyringSummary(), readAskpassAnswer()]);
    return { ok: true, ...summary, askpass, support: await readSupport(summary) };
};

// An instant as the person at this computer reads it, on this computer's own clock.
export const clock = (ms: number): string => wallClockIn(ms, localZone());

/** The keyring's one row: not installed, not running, not set up, or running and locked or unlocked. Pure. */
export const keyringLine = (line: KeyringStatusLine): Item => {
    if (!line.installed) {
        return { tone: "skip", name: "keyring", meta: "not installed (`intentic-machine keyring setup`)" };
    }
    if (!line.running) {
        return line.serviceInstalled === true
            ? { tone: "fail", name: "keyring", meta: "its service is installed and its session helper does not answer (`intentic-machine keyring start` starts it)" }
            : { tone: "fail", name: "keyring", meta: "installed, not running (`intentic-machine keyring setup` starts it)" };
    }
    if (line.serviceDown === true) {
        return { tone: "fail", name: "keyring", meta: "its service does not answer (`intentic-machine keyring upgrade` repairs it)" };
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
    readonly serviceDown?: true;
    readonly serviceInstalled?: true;
}

export const keyringStatusLine = (summary: KeyringSummary): KeyringStatusLine => {
    const base: KeyringStatusLine = { installed: summary.installed, running: summary.running, setUp: summary.setUp };
    const flagged: KeyringStatusLine = summary.serviceDown === true ? { ...base, serviceDown: true } : base;
    const line: KeyringStatusLine = summary.serviceInstalled === true ? { ...flagged, serviceInstalled: true } : flagged;
    if (summary.state === undefined) {
        return line;
    }
    const known = { ...line, locked: summary.state.locked, version: summary.state.version };
    return summary.state.unlockedUntil === undefined ? known : { ...known, unlockedUntil: summary.state.unlockedUntil };
};
