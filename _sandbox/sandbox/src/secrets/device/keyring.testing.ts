import type {
    KeyringCaptureResult,
    KeyringCopies as KeyringCopiesAnswer,
    KeyringDeviceKeys,
    KeyringInboxItem,
    KeyringNeedResult,
    KeyringPhoneFillResult,
    KeyringPhoneKeys,
    KeyringPhonePairResult,
    KeyringPointer,
    KeyringShares,
    KeyringSyncItem,
    KeyringSyncState,
    KeyringTypeInput,
    SignedKeyringGrant,
    SignedKeyringPhoneFill,
} from "@intentic/sandbox-contract/schemas/keyring";
import { newSealKeyPair, newSignKeyPair, type KeyringKeyPair } from "@intentic/sandbox-contract/keyring-seal";
import type { SandboxKeyringKeys, SandboxKeyringPairs } from "./keyring-keys.js";
import type { KeyringClient, KeyringDevices } from "./keyring-link.js";
import type { HeardKeyring, KeyringBook, KeyringCopies, ReleasedDeviceValues } from "./keyring-stores.js";
import type { KeyringSyncClient, KeyringSyncDevices } from "./keyring-sync.js";

// In-memory stand-ins for the keyring stores and a computer's keyring as the link reaches it, shared by the suites that
// drive the link, the device-held secrets and the routes over them. Not part of the build.

export const SANDBOX_URL = "https://sandbox-7.example.dev";

export const memoryKeyringBook = (): KeyringBook & { readonly book: Map<string, HeardKeyring> } => {
    const book = new Map<string, HeardKeyring>();
    return {
        book,
        all: async () => Object.fromEntries(book),
        set: async (machine, heard) => {
            book.set(machine, heard);
        },
    };
};

export const memoryKeyringCopies = (): KeyringCopies => {
    let copies: Readonly<Record<string, string>> = {};
    return {
        all: async () => copies,
        change: async (change) => {
            copies = change(copies);
        },
    };
};

export const memoryReleasedValues = (): ReleasedDeviceValues => {
    const values = new Map<string, string>();
    return {
        add: (name, value) => void values.set(name, value),
        all: () => Object.fromEntries(values),
        reset: async () => {},
    };
};

export const memorySandboxKeys = (): SandboxKeyringKeys & SandboxKeyringPairs => {
    const pairs = { sign: newSignKeyPair(), seal: newSealKeyPair() };
    return { ...pairs, pairs: async () => pairs, publicKeys: async () => ({ sign: pairs.sign.publicKey, seal: pairs.seal.publicKey }) };
};

export const pointerOf = (name: string, over: Partial<KeyringPointer> = {}): KeyringPointer => ({
    name,
    mode: "while-here",
    kind: "password",
    programs: [],
    packages: [],
    hosts: [],
    anyField: false,
    source: "keyring",
    updatedAt: 1_000,
    ...over,
});

// One computer's keyring as the machine relays it: what each procedure answers, and every call it was asked, in order.
export interface FakeKeyring {
    readonly keys: { readonly seal: KeyringKeyPair; readonly inbox: KeyringKeyPair; readonly sync: KeyringKeyPair };
    readonly calls: { readonly procedure: string; readonly input: unknown }[];
    readonly client: KeyringClient & KeyringSyncClient;
    shares: (keys: KeyringDeviceKeys) => KeyringShares;
    release: (grant: SignedKeyringGrant) => Promise<Awaited<ReturnType<KeyringClient["keyringRelease"]>>>;
    type: (input: KeyringTypeInput) => Promise<Awaited<ReturnType<KeyringClient["keyringType"]>>>;
    inbox: (item: KeyringInboxItem) => Promise<Awaited<ReturnType<KeyringClient["keyringInbox"]>>>;
    capture: (item: Parameters<KeyringClient["keyringCapture"]>[0]) => Promise<KeyringCaptureResult>;
    need: (need: Parameters<KeyringClient["keyringNeed"]>[0]) => Promise<KeyringNeedResult>;
    phonePair: (phone: KeyringPhoneKeys) => Promise<KeyringPhonePairResult>;
    phoneFill: (fill: SignedKeyringPhoneFill) => Promise<KeyringPhoneFillResult>;
    copies: () => KeyringCopiesAnswer;
    outbox: KeyringSyncItem[];
    peers: KeyringSyncState["peers"];
}

export const fakeKeyring = (pointers: readonly KeyringPointer[] = []): FakeKeyring => {
    const keys = { seal: newSealKeyPair(), inbox: newSealKeyPair(), sync: newSealKeyPair() };
    const calls: { procedure: string; input: unknown }[] = [];
    const fake: FakeKeyring = {
        keys,
        calls,
        shares: (reported) => ({
            keyring: { version: "1.0.0", locked: false, unlock: ["passphrase"], keys: reported, pendingInbox: 0 },
            pointers: [...pointers],
        }),
        release: async () => ({ ok: false, code: "declined", refusal: "the person said no" }),
        type: async () => ({ ok: true, program: "FortiClient.exe", field: "password", asked: false }),
        inbox: async () => ({ ok: true, pending: true }),
        capture: async () => ({ ok: true, outcome: "saved", name: "CAPTURED", title: "captured" }),
        need: async () => ({ ok: false, code: "unknown", refusal: "nothing here fits" }),
        phonePair: async () => ({ ok: true, fingerprint: "AB12" }),
        phoneFill: async () => ({ ok: false, code: "declined", refusal: "the person said no" }),
        copies: () => ({ copies: [] }),
        outbox: [],
        peers: [],
        client: {
            keyringShares: async () => {
                calls.push({ procedure: "keyringShares", input: undefined });
                return fake.shares({ seal: keys.seal.publicKey, inbox: keys.inbox.publicKey });
            },
            keyringRelease: async (grant) => {
                calls.push({ procedure: "keyringRelease", input: grant });
                return fake.release(grant);
            },
            keyringType: async (input) => {
                calls.push({ procedure: "keyringType", input });
                return fake.type(input);
            },
            keyringInbox: async (item) => {
                calls.push({ procedure: "keyringInbox", input: item });
                return fake.inbox(item);
            },
            keyringCapture: async (item) => {
                calls.push({ procedure: "keyringCapture", input: item });
                return fake.capture(item);
            },
            keyringNeed: async (need) => {
                calls.push({ procedure: "keyringNeed", input: need });
                return fake.need(need);
            },
            keyringPhonePair: async (phone) => {
                calls.push({ procedure: "keyringPhonePair", input: phone });
                return fake.phonePair(phone);
            },
            keyringPhoneFill: async (fill) => {
                calls.push({ procedure: "keyringPhoneFill", input: fill });
                return fake.phoneFill(fill);
            },
            keyringCopies: async () => {
                calls.push({ procedure: "keyringCopies", input: undefined });
                return fake.copies();
            },
            keyringSyncState: async () => {
                calls.push({ procedure: "keyringSyncState", input: undefined });
                return { key: keys.sync.publicKey, peers: fake.peers, revision: 0 };
            },
            keyringSyncPair: async (input) => {
                calls.push({ procedure: "keyringSyncPair", input });
                return { ok: true };
            },
            keyringSyncOutbox: async () => {
                calls.push({ procedure: "keyringSyncOutbox", input: undefined });
                return { items: fake.outbox };
            },
            keyringSyncDeliver: async (input) => {
                calls.push({ procedure: "keyringSyncDeliver", input });
                return { accepted: input.items.length };
            },
        },
    };
    return fake;
};

// The owner's computers: each named keyring answers while `online` holds its name.
export const fakeDevices = (keyrings: Readonly<Record<string, FakeKeyring>>): KeyringDevices & KeyringSyncDevices & { readonly online: Set<string> } => {
    const online = new Set(Object.keys(keyrings));
    return {
        online,
        ready: () => [...online],
        client: (machine) => (online.has(machine) ? keyrings[machine]?.client : undefined),
    };
};

// No computer at all: what a suite that never reaches a keyring stands the link up with.
export const NO_DEVICES: KeyringDevices & KeyringSyncDevices = { ready: () => [], client: () => undefined };
