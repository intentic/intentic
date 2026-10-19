import type { deviceContract } from "@intentic/sandbox-contract/contracts/device.contract";
import type { KeyringCaptureItem, KeyringCaptureResult, KeyringDeviceKeys, KeyringGrantTarget, KeyringInboxResult, KeyringNeed, KeyringNeedResult, KeyringPhoneFillResult, KeyringPhoneKeys, KeyringPhonePairResult, KeyringPointer, KeyringRemember, KeyringRefusalCode, KeyringShareMode, KeyringTypeResult, SignedKeyringPhoneFill } from "@intentic/sandbox-contract/schemas/keyring";
import type { SandboxKeyring } from "@intentic/sandbox-contract/schemas/secrets";
import type { ContractRouterClient } from "@orpc/contract";
import type { SandboxKeyringKeys } from "./keyring-keys.js";
import type { KeyringBook, KeyringCopies, ReleasedDeviceValues } from "./keyring-stores.js";

// THE KEYRING LINK'S SHAPES (keyring-link.ts): what it is handed, what it answers, and what it says about each of the
// owner's computers. Kept apart from the link's workings so a reader of either has a page, not two.

export interface KeyringLogFields {
    readonly err?: unknown;
    readonly machine?: string;
    readonly secret?: string;
    readonly accepted?: number;
    readonly sent?: number;
}

// Where the link says what went wrong.
export interface KeyringLogger {
    readonly warn: (fields: KeyringLogFields, message: string) => void;
}

export type KeyringClient = Pick<
    ContractRouterClient<typeof deviceContract>,
    "keyringShares" | "keyringRelease" | "keyringType" | "keyringInbox" | "keyringCopies" | "keyringCapture" | "keyringNeed" | "keyringPhonePair" | "keyringPhoneFill"
>;

// The owner's computers as the link reaches them, read at each call: the hub is composed after the secrets slice.
export interface KeyringDevices {
    // Connections holding a socket now whose agent advertises a keyring (DEVICE_FEATURE_KEYRING).
    readonly ready: () => readonly string[];
    // The client for one of those; undefined for any other.
    readonly client: (machine: string) => KeyringClient | undefined;
}

export interface DevicePointer {
    readonly machine: string;
    readonly pointer: KeyringPointer;
    readonly online: boolean;
    readonly locked: boolean | undefined;
}

// One computer's keyring as the Passwords side of the sandbox reads it (the need relay, a terminal's or a phone's
// capture): whether it answers now, whether it has a vault, and what it last said of itself.
export interface KeyringComputer {
    readonly machine: string;
    readonly online: boolean;
    // Answering, set up, and with keys this sandbox pinned and still trusts: something can be sealed to it.
    readonly setUp: boolean;
    readonly locked: boolean | undefined;
    readonly remember: KeyringRemember | undefined;
    // Its pinned inbox key, what a capture is sealed to; undefined while it is not usable (see setUp).
    readonly inbox: string | undefined;
    // When a person last answered something there through this sandbox, else when it was last heard: how "most recently
    // active" is told, since a connection's heartbeat beats alike on every computer that is awake.
    readonly activeAt: number;
}

// The Passwords calls the machine relays to its keyring, each answered with the keyring's own refusal when the computer
// cannot be reached, never thrown.
export interface KeyringPasswordsCalls {
    readonly capture: (machine: string, item: KeyringCaptureItem) => Promise<KeyringCaptureResult>;
    readonly need: (machine: string, need: KeyringNeed, signal?: AbortSignal) => Promise<KeyringNeedResult>;
    readonly phonePair: (machine: string, keys: KeyringPhoneKeys, signal?: AbortSignal) => Promise<KeyringPhonePairResult>;
    readonly phoneFill: (machine: string, fill: SignedKeyringPhoneFill, signal?: AbortSignal) => Promise<KeyringPhoneFillResult>;
}

export interface KeyringLink {
    // This sandbox's own public address, as the owner's computers dial it: what every grant names and every share is for.
    readonly sandboxUrl: () => Promise<string>;
    // Every computer with a keyring this sandbox has heard or reaches now, as GET /secrets/keyrings answers it.
    readonly keyrings: () => Promise<readonly SandboxKeyring[]>;
    // Every entry each keyring shares here, from memory, an offline computer's included as offline.
    readonly pointers: () => Promise<readonly DevicePointer[]>;
    // The entry of that name, from the computer that answers now if several share one.
    readonly pointer: (name: string) => Promise<DevicePointer | undefined>;
    // The keys pinned for a computer's keyring; undefined before it was heard, while it reports others without having
    // reconnected, or while it is not set up.
    readonly deviceKeys: (machine: string) => Promise<KeyringDeviceKeys | undefined>;
    // One value for one use in one lane, asked of that computer's keyring under a fresh grant and opened here; kept
    // after only to mask (never to answer another use), and refused with the keyring's own code and words.
    readonly release: (args: {
        readonly machine: string;
        readonly secret: string;
        readonly lane: "shell" | "code" | "browser" | "desktop";
        readonly detail: string;
        readonly conversationId?: string;
        readonly signal?: AbortSignal;
    }) => Promise<{ readonly ok: true; readonly value: string; readonly asked: boolean } | { readonly ok: false; readonly code: KeyringRefusalCode; readonly refusal: string }>;
    // Typing into the focused window or phone app on `machine`: its keyring's own entry, a sandbox-held `value` sealed to
    // that keyring, or with `relayFrom` an entry another computer's keyring holds, sealed by that one straight to this
    // one under the typing grant's nonce, so the value never opens in the sandbox.
    readonly type: (args: {
        readonly machine: string;
        readonly secret: string;
        readonly target: Extract<KeyringGrantTarget, { kind: "window" | "android" }>;
        readonly value?: string;
        readonly relayFrom?: string;
        readonly purpose: "agent" | "owner";
        readonly detail: string;
        readonly conversationId?: string;
        readonly signal?: AbortSignal;
    }) => Promise<KeyringTypeResult>;
    // A value sent to that computer's keyring to keep, sealed to its inbox key; taken in at its next unlock.
    readonly inbox: (args: {
        readonly machine: string;
        readonly name: string;
        readonly value: string;
        readonly mode: KeyringShareMode;
        readonly kind: "password" | "text";
        readonly programs: string[];
        readonly hosts: string[];
    }) => Promise<KeyringInboxResult>;
    // Reads one keyring's shares and copies now, or every connected one's.
    readonly refresh: (machine?: string) => Promise<void>;
    // Every computer whose keyring this sandbox heard, most recently active first.
    readonly computers: () => Promise<readonly KeyringComputer[]>;
    readonly passwords: KeyringPasswordsCalls;
    // Hears every refresh that read a computer's shares, so a need waiting on that computer can see its yes.
    readonly onRefreshed: (listener: (machine: string) => void) => () => void;
}

// The link as the daemon runs it: the API above, and the watcher's word that a computer just connected.
export interface KeyringLinkRunner extends KeyringLink {
    readonly arrived: (machine: string) => Promise<void>;
}

export interface KeyringLinkDeps {
    readonly devices: () => KeyringDevices;
    // The address the owner's computers paired with (the config's public URL); empty before the tunnel exists.
    readonly publicUrl: () => string;
    readonly keys: Pick<SandboxKeyringKeys, "pairs">;
    readonly book: KeyringBook;
    readonly copies: KeyringCopies;
    readonly released: Pick<ReleasedDeviceValues, "add">;
    // A keyring's sync key and the computers it is paired with, as last heard (keyring-sync.ts).
    readonly syncOf: (machine: string) => { readonly key: string; readonly peers: readonly string[] } | undefined;
    readonly logger: KeyringLogger;
    readonly now?: () => number;
}
