import type { KeyringSandboxKeys } from "@intentic/sandbox-contract/schemas/keyring";
import type { Audit, AuditRecord } from "../audit.js";
import type { BackendReader } from "../backends.js";
import type { Consent } from "../consent/consent.js";
import type { KeysFile } from "../keys.js";
import type { KeyringOp, KeyringResponse, Refusal } from "../protocol.js";
import type { Place, Seen, Typist } from "../typing/typist.js";
import type { OpenPart, ScryptCost, StoredEntry, VaultDocument, VaultFile } from "../vault.js";

// WHAT THE KEYRING'S OPS SHARE: the facts it is built with, and the handful of moves on the vault every op is made of
// (open it, asking when the rules say; write it; keep a record). core.ts owns the vault and hands this to the files that
// answer the Passwords app's ops (capture.ts, app-ops.ts, fills.ts, needs.ts, phone.ts, askpass/answer.ts), so each
// keeps to its own op and none holds the vault key longer than core.ts lets it.

export interface KeyringDeps {
    readonly vault: {
        readonly read: () => Promise<VaultFile | undefined>;
        readonly write: (file: VaultFile) => Promise<void>;
    };
    readonly keys: {
        readonly read: () => Promise<KeysFile>;
        readonly write: (keys: KeysFile) => Promise<void>;
    };
    readonly consent: Consent;
    readonly typist: Typist;
    readonly backends: BackendReader;
    // A sandbox's public keys, fetched from its own address (GET /keyring/keys): never from whoever asked for the share.
    readonly fetchKeys: (sandbox: string) => Promise<KeyringSandboxKeys>;
    readonly audit: Audit;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly version: string;
    // The Windows Hello credential's name for this user.
    readonly helloCredential: string;
    readonly scrypt?: ScryptCost;
    // How long an agent's need waits for the person before it is kept under Requests. Default: as long as a grant lives.
    readonly needWaitMs?: number;
}

export type Answer<K extends KeyringOp> = Promise<KeyringResponse<K>>;

export const refuse = (code: Refusal["code"], refusal: string): Refusal => ({ ok: false, code, refusal });
export const NOT_SET_UP = "Passwords is not set up on this computer yet: `intentic-machine keyring setup` sets it up.";

// The value an entry's typing or release sees: a kept value, or one read from its password manager.
export type ValueRead = { readonly ok: true; readonly value: string } | Refusal;

// The inner document, opened for one op, what the person was shown and said, and which answer they chose when offered
// several.
export interface Opened {
    readonly doc: VaultDocument;
    readonly key: Buffer;
    readonly asked: boolean;
    readonly how: string | undefined;
    readonly choice?: string | undefined;
}

export interface OpenRequest {
    readonly title: string;
    readonly message: string;
    // Ask even while unlocked.
    readonly person: boolean;
    // Answers to choose among (consent.ts ChoicePrompt), first the default.
    readonly choices?: readonly { readonly id: string; readonly label: string }[];
}

// What arrived while locked and is written with the open part, when a commit changes it.
export type PendingParts = Partial<Pick<OpenPart, "pendingInbox" | "pendingSync" | "pendingCaptures" | "pendingNeeds" | "pendingSeen">>;

export interface VaultAccess {
    readonly deps: KeyringDeps;
    readonly file: () => VaultFile | undefined;
    readonly keys: () => Promise<KeysFile>;
    // The inner document while unlocked.
    readonly held: () => { readonly key: Buffer; readonly doc: VaultDocument } | undefined;
    readonly open: (file: VaultFile, request: OpenRequest) => Promise<Opened | Refusal>;
    readonly commit: (opened: { readonly doc: VaultDocument; readonly key: Buffer }, pending?: PendingParts) => Promise<void>;
    readonly writeOpen: (open: OpenPart) => Promise<void>;
    readonly record: (record: AuditRecord) => Promise<void>;
    readonly valueOf: (doc: VaultDocument, entry: StoredEntry) => Promise<ValueRead>;
    readonly fetchKeys: (sandbox: string) => Promise<KeyringSandboxKeys | Refusal>;
    // Types `value` where `seen` is, looking again first when a prompt took the keyboard (core.ts).
    readonly typeInto: (place: Place, seen: Seen, value: string, asked: boolean) => Answer<"type">;
}
