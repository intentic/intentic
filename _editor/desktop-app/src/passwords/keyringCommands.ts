import type {
    KeyringCaptureSource,
    KeyringNeedAnswer,
    KeyringOrigin,
    KeyringPendingNeed,
    KeyringRemember,
    KeyringShareMode,
    KeyringSource,
    KeyringState,
} from "@intentic/sandbox-contract/schemas/keyring";
import { invoke } from "@tauri-apps/api/core";

// THE KEYRING ON THIS COMPUTER (src-tauri/src/keyring.rs), for the Passwords view (src/passwords): `intentic-machine
// keyring … --json`, whose one line of JSON is parsed here, as the agent's status is above. A refusal (`{"ok":false,…}`)
// is thrown as a KeyringRefusal carrying the keyring's own sentence. Whatever the app sends for `keyring app <op>` goes to
// Rust as the call's own argument and from there to the agent's standard input, never its command line.
export interface KeyringStatus {
    readonly installed: boolean;
    readonly running: boolean;
    readonly setUp: boolean;
    /** Present once the vault is set up and the keyring answers. */
    readonly state?: KeyringState;
    readonly askpass: { readonly installed: boolean; readonly path?: string };
    /** Whether this computer can keep a protected vault, and how it unlocks. Absent from an agent older than 2026-10-19. */
    readonly support?: { readonly canSetUp: boolean; readonly why?: string; readonly hello: boolean; readonly platform: `windows` | `linux` | `darwin` };
}
export interface KeyringShare {
    /** The sandbox, by its address or link id. */
    readonly sandbox: string;
    readonly machine: string;
    readonly mode: KeyringShareMode;
    readonly sharedAt: number;
}
/** One entry as `keyring list` answers it: names, rules and shares, never a value (the keyring's EntryInfoSchema). */
export interface KeyringEntry {
    readonly name: string;
    readonly kind: `password` | `text`;
    readonly programs: readonly string[];
    readonly packages: readonly string[];
    readonly hosts: readonly string[];
    readonly anyField: boolean;
    readonly username?: string | undefined;
    readonly askpass: readonly string[];
    readonly askpassRememberMinutes?: number | undefined;
    readonly note?: string | undefined;
    readonly title?: string | undefined;
    readonly source: KeyringSource;
    readonly backend?: { readonly backend: `1password` | `bitwarden` | `keepassxc` } | undefined;
    readonly shares: readonly KeyringShare[];
    readonly createdAt: number;
    readonly updatedAt: number;
    // The fields below are absent from a keyring older than 2026-10-19.
    readonly captured?: { readonly source: KeyringCaptureSource; readonly via: string; readonly at: number } | undefined;
    readonly fresh?: boolean | undefined;
    readonly unverified?: boolean | undefined;
    readonly lastUsedAt?: number | undefined;
    readonly versions?: number | undefined;
    readonly health?: { readonly weak: boolean; readonly reused: boolean } | undefined;
}
/** What a new vault's setup answers: the recovery key only when it was made just now, to be shown once. */
export interface KeyringSetupAnswer {
    readonly setUp: true;
    readonly alreadySetUp: boolean;
    readonly recoveryKey?: string;
    readonly state?: KeyringState;
}
/** A line of the keyring's record (its ActivityItemSchema): never a value. */
export interface KeyringActivityLine {
    readonly at: number;
    readonly op: string;
    readonly outcome: string;
    readonly secret?: string;
    readonly sandbox?: string;
    readonly program?: string;
    readonly target?: string;
    readonly asked?: boolean;
    readonly code?: string;
}
/** The vault's settings (its KeyringSettingsSchema). */
export interface KeyringSettings {
    readonly remember: KeyringRemember;
    readonly rememberAskedAt?: number;
    readonly neverSave: readonly KeyringOrigin[];
    readonly autoLockMinutes: number;
    readonly lockOnSleep: boolean;
}
export interface KeyringSourceStatus {
    readonly source: keyof KeyringRemember;
    readonly on: boolean;
    readonly ready: boolean;
    readonly available: boolean;
    readonly why?: string;
    readonly detail?: string;
    readonly asks?: string;
}
/**
 * Every `keyring app <op>`: what it is sent on stdin, and what its `ok` line holds. The shared interface the machine
 * agent's `keyring app` verb group answers (keyring-capture), restated as types since the line is passed through raw.
 */
export interface KeyringAppOps {
    readonly reveal: { readonly in: { name: string; version?: number }; readonly out: { value: string; username?: string } };
    readonly copy: { readonly in: { name: string; field: `password` | `username` }; readonly out: { clearsAt: number } };
    readonly history: { readonly in: { name: string }; readonly out: { versions: readonly { version: number; at: number; captured?: KeyringEntry[`captured`] }[] } };
    readonly restore: { readonly in: { name: string; version: number }; readonly out: object };
    readonly undo: { readonly in: { name: string; at: number }; readonly out: object };
    readonly seen: { readonly in: { names: readonly string[] }; readonly out: object };
    readonly settings: { readonly in: Record<string, never>; readonly out: { settings: KeyringSettings } };
    readonly "set-settings": {
        readonly in: { patch: Partial<Omit<KeyringSettings, `remember` | `rememberAskedAt`>> & { remember?: Partial<KeyringRemember> } };
        readonly out: { settings: KeyringSettings };
    };
    readonly activity: { readonly in: { name?: string; limit?: number }; readonly out: { lines: readonly KeyringActivityLine[] } };
    readonly needs: { readonly in: Record<string, never>; readonly out: { pending: readonly KeyringPendingNeed[] } };
    readonly "answer-need": { readonly in: { id: string; answer: KeyringNeedAnswer; name?: string | undefined; value?: string | undefined }; readonly out: object };
    readonly save: {
        readonly in: { title: string; username?: string | undefined; value: string; kind: `password` | `text`; origins: readonly KeyringOrigin[]; note?: string | undefined };
        readonly out: { outcome: string; name: string };
    };
    readonly edit: {
        readonly in: {
            name: string;
            patch: { title?: string; username?: string; kind?: `password` | `text`; origins?: readonly KeyringOrigin[]; note?: string; anyField?: boolean };
            value?: string;
        };
        readonly out: object;
    };
    readonly import: {
        readonly in: {
            from: string;
            rows: readonly { origin: KeyringOrigin; title?: string | undefined; username?: string | undefined; value: string; note?: string | undefined }[];
        };
        readonly out: { saved: number; updated: number; unchanged: number; skipped: number };
    };
    readonly sources: { readonly in: Record<string, never>; readonly out: { sources: readonly KeyringSourceStatus[] } };
    readonly "setup-source": { readonly in: { source: keyof KeyringRemember }; readonly out: object };
}
export type KeyringAppOp = keyof KeyringAppOps;
/** The keyring said no, in its own words; `code` says which no (`locked`, `declined`, `agent-too-old`, …). */
export class KeyringRefusal extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = `KeyringRefusal`;
    }
}
interface KeyringLine {
    readonly ok: boolean;
    readonly code?: string;
    readonly refusal?: string;
}
const keyringAnswer = <T extends object>(raw: string): T => {
    // SAFETY: keyring.rs hands over the agent's own `--json` line, which always carries `ok` (a refusal its `code` and
    // `refusal`), and an `ok` line is the verb's own answer, shaped as the agent's keyring command documents it.
    const line = JSON.parse(raw) as KeyringLine & T;
    if (!line.ok) {
        throw new KeyringRefusal(line.code ?? `refused`, line.refusal ?? `The keyring said no.`);
    }
    return line;
};
/** Undefined when this computer has no machine agent at all. */
export const keyringStatus = async (): Promise<KeyringStatus | undefined> => {
    const raw = await invoke<string | null>(`keyring_status`);
    return raw === null ? undefined : keyringAnswer<KeyringStatus>(raw);
};
export const keyringList = async (): Promise<readonly KeyringEntry[]> =>
    keyringAnswer<{ entries: readonly KeyringEntry[] }>(await invoke<string>(`keyring_list`)).entries;
/** The protected vault set up: one administrator prompt, Windows Hello unless `hello` is off, a recovery key made. */
export const keyringSetup = async (hello: boolean): Promise<KeyringSetupAnswer> => keyringAnswer<KeyringSetupAnswer>(await invoke<string>(`keyring_setup`, { hello }));
export const keyringRemove = async (name: string): Promise<void> => {
    keyringAnswer<KeyringLine>(await invoke<string>(`keyring_remove`, { name }));
};
export const keyringShare = async (name: string, sandbox: string, mode: KeyringShareMode): Promise<void> => {
    keyringAnswer<KeyringLine>(await invoke<string>(`keyring_share`, { name, sandbox, mode }));
};
export const keyringUnshare = async (name: string, sandbox: string): Promise<void> => {
    keyringAnswer<KeyringLine>(await invoke<string>(`keyring_unshare`, { name, sandbox }));
};
export const keyringUnlock = async (minutes?: number): Promise<void> => {
    keyringAnswer<KeyringLine>(await invoke<string>(`keyring_unlock`, { minutes: minutes ?? null }));
};
export const keyringLock = async (): Promise<void> => {
    keyringAnswer<KeyringLine>(await invoke<string>(`keyring_lock`));
};
/** Update at the running keyring's consent, through the machine agent's verified download and service installer. */
export const keyringUpgrade = async (): Promise<void> => {
    keyringAnswer<KeyringLine>(await invoke<string>(`keyring_upgrade`));
};
/** One of the Passwords app's verbs, its input on the agent's stdin (keyring.rs `keyring_app`). */
export const keyringApp = async <Op extends KeyringAppOp>(op: Op, input: KeyringAppOps[Op][`in`]): Promise<KeyringAppOps[Op][`out`]> =>
    keyringAnswer<KeyringAppOps[Op][`out`]>(await invoke<string>(`keyring_app`, { op, input }));
