import {
    type deviceContract,
    KeyringRefusalCodeSchema,
    type KeyringDeviceKeys,
    type KeyringGrant,
    type KeyringGrantTarget,
    type KeyringInboxResult,
    type KeyringPointer,
    type KeyringRefusalCode,
    type KeyringShareMode,
    type KeyringTypeResult,
    type SandboxKeyring,
    type SealedBox,
    type SignedKeyringGrant,
} from "@intentic/sandbox-contract";
import { grantNonce, keyFingerprint, seal, signGrant, unseal } from "@intentic/sandbox-contract/keyring-seal";
import type { ContractRouterClient } from "@orpc/contract";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { SandboxKeyringKeys } from "./keyring-keys.js";
import type { HeardKeyring, KeyringBook, KeyringCopies, ReleasedDeviceValues } from "./keyring-stores.js";

// The sandbox's side of the keyrings on the owner's computers (schemas/keyring.ts, _devices/keyring): the POINTERS each
// keyring shares with this sandbox, and every question that spends one, each carried by a grant this sandbox signs and
// answered, where a value rides, sealed to whoever the grant names. The machine relays both ways and reads nothing.
//
// Pointers are read when a computer connects, every minute while it stays, and on `refresh`; the rest of the daemon
// reads them from memory, never a round trip, and an offline computer's rows stay listed from what it last said. Each
// keyring's own keys are pinned the first time they are heard: a value this sandbox sends one is sealed to the pinned
// key, and a keyring reporting different keys is refused for that until it reconnects, when the new keys are pinned
// again with a warning in the log (a reinstalled keyring is the ordinary cause, and a person reconnecting it is the one
// moment the sandbox can tell apart from a key swapped under a live connection).

// What a log line carries beside its sentence: the computer, the secret's name, the error, how many items a delivery
// took. Never a value or a grant.
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

// The keyring's own code on an error the machine raised for it: a procedure with no refusal in its answer (copies, the
// sync ones) fails with SERVICE_UNAVAILABLE carrying the keyring's code, `locked` or `no-keyring`. That is the keyring's
// state, said again at every read, not news for the log.
const KeyringErrorSchema = z.object({ code: z.literal("SERVICE_UNAVAILABLE"), data: z.object({ code: KeyringRefusalCodeSchema }) });
export const keyringCodeOf = (error: Error): KeyringRefusalCode | undefined => KeyringErrorSchema.safeParse(error).data?.data.code;

export type KeyringClient = Pick<
    ContractRouterClient<typeof deviceContract>,
    "keyringShares" | "keyringRelease" | "keyringType" | "keyringInbox" | "keyringCopies"
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

type Refused = { readonly ok: false; readonly code: KeyringRefusalCode; readonly refusal: string };
const refused = (code: KeyringRefusalCode, refusal: string): Refused => ({ ok: false, code, refusal });

// Under the two minutes a keyring accepts, with room for a clock running a little behind.
const GRANT_TTL_MS = 90_000;
const DETAIL_MAX = 300;
const CONVERSATION_MAX = 200;
// A release, a typing or an inbox item may wait on a person at Windows Hello for as long as the machine waits on its
// keyring (130 s), and a little longer for the answer to come back; reading the shares never waits on anyone.
export const ASKING_TIMEOUT_MS = 140_000;
const READING_TIMEOUT_MS = 20_000;

const offline = (machine: string): string =>
    `${machine} is not connected with a keyring right now: the computer is asleep or offline, its agent is not running, or no keyring is installed there.`;

const deadline = (ms: number, signal: AbortSignal | undefined): AbortSignal => (signal === undefined ? AbortSignal.timeout(ms) : AbortSignal.any([AbortSignal.timeout(ms), signal]));

interface GrantBody {
    readonly secret: string;
    readonly target: KeyringGrantTarget;
    readonly purpose: "agent" | "owner";
    readonly detail: string;
    readonly conversationId?: string | undefined;
}

// What the link knows between calls. Everything a keyring said is in `memory`, loaded from the book once and written
// behind every change; the sets are this process's own reading of each computer.
interface LinkState {
    readonly deps: KeyringLinkDeps;
    readonly now: () => number;
    readonly memory: () => Promise<Map<string, HeardKeyring>>;
    // Which keyrings answered their last read in this process; an offline computer's are still listed, as not answering.
    readonly answering: Set<string>;
    // Keyrings that reported keys other than the pinned ones without reconnecting: nothing is sealed to them meanwhile.
    readonly mismatched: Set<string>;
    // Computers that connected since their keyring was last read, whose next report may re-pin its keys.
    readonly reconnected: Set<string>;
    // Keyrings installed and answering but not set up yet: no vault, so no keys, and nothing can be sealed to them.
    readonly notSetUp: Set<string>;
}

// What a call nobody answered says: the transport's error is logged, and carries no value, but a sentence the agent
// reads gets only that the computer did not answer.
const unanswered =
    (state: LinkState, machine: string, what: string) =>
    (error: Error): Refused => {
        state.deps.logger.warn({ err: error, machine }, `keyring: ${what} went unanswered`);
        return refused("unavailable", `The keyring on ${machine} did not answer: try again once the computer is reachable.`);
    };

const sandboxUrlOf = async (state: LinkState): Promise<string> => {
    const url = state.deps.publicUrl().replace(/\/+$/u, "");
    if (!URL.canParse(url)) {
        throw new Error("this sandbox has no public address yet, so no keyring can be asked for anything: its tunnel is not up");
    }
    return url;
};

const sandboxOrRefused = async (state: LinkState): Promise<{ readonly url: string } | Refused> =>
    sandboxUrlOf(state).then(
        (url) => ({ url }),
        (error: Error) => refused("unavailable", error.message),
    );

const signed = async (state: LinkState, body: GrantBody, nonce: string): Promise<{ readonly grant: SignedKeyringGrant; readonly sandbox: string } | Refused> => {
    const address = await sandboxOrRefused(state);
    if ("ok" in address) {
        return address;
    }
    const sandbox = address.url;
    const issuedAt = state.now();
    const grant: KeyringGrant = {
        v: 1,
        sandbox,
        secret: body.secret,
        target: body.target,
        purpose: body.purpose,
        ...opt("conversation", body.conversationId?.slice(0, CONVERSATION_MAX)),
        detail: (body.detail.trim() === "" ? body.secret : body.detail.trim()).slice(0, DETAIL_MAX),
        nonce,
        issuedAt,
        expiresAt: issuedAt + GRANT_TTL_MS,
    };
    try {
        return { grant: signGrant((await state.deps.keys.pairs()).sign, grant), sandbox };
    } catch {
        // A grant the schema refuses is a name or a target no keyring could carry; nothing about it is secret.
        return refused("not-shared", `"${body.secret}" is not a name a keyring entry can have, so no keyring can be asked for it.`);
    }
};

// The keys pinned for a keyring after this report: the first ones heard, kept while it reports the same, replaced only
// after the computer reconnected (said in the log either way), never under a live connection.
const pin = (state: LinkState, machine: string, previous: HeardKeyring | undefined, reported: KeyringDeviceKeys | undefined): HeardKeyring["pinned"] => {
    const pinned = previous?.pinned;
    if (reported === undefined) {
        return pinned;
    }
    if (pinned === undefined || (pinned.seal === reported.seal && pinned.inbox === reported.inbox)) {
        state.mismatched.delete(machine);
        return pinned ?? { seal: reported.seal, inbox: reported.inbox, at: state.now() };
    }
    if (state.reconnected.has(machine)) {
        state.deps.logger.warn({ machine }, "keyring: the keyring on this computer reports new keys since it reconnected; they are pinned in place of the old ones");
        state.mismatched.delete(machine);
        return { seal: reported.seal, inbox: reported.inbox, at: state.now() };
    }
    state.deps.logger.warn(
        { machine },
        "keyring: the keyring on this computer reports keys other than the ones pinned, without reconnecting; nothing is sealed to it until it reconnects",
    );
    state.mismatched.add(machine);
    return pinned;
};

// The copies one computer's keyring shares in `copy` mode, opened with this sandbox's key.
const openCopies = async (state: LinkState, machine: string, client: KeyringClient, wanted: ReadonlySet<string>): Promise<Map<string, string>> => {
    const opened = new Map<string, string>();
    if (wanted.size === 0) {
        return opened;
    }
    const [{ copies }, sandbox, { seal: own }] = await Promise.all([
        client.keyringCopies(undefined, { signal: AbortSignal.timeout(READING_TIMEOUT_MS) }),
        sandboxUrlOf(state),
        state.deps.keys.pairs(),
    ]);
    for (const copy of copies.filter((entry) => wanted.has(entry.name))) {
        try {
            opened.set(copy.name, unseal(own, copy.sealed, { kind: "copy", sandbox, secret: copy.name, updatedAt: copy.updatedAt }));
        } catch (error) {
            state.deps.logger.warn({ err: error, machine, secret: copy.name }, "keyring: a copy did not open with this sandbox's key; the one kept stays");
        }
    }
    return opened;
};

// The copies kept, after one computer's were read: what it sent replaces what was kept, and a copy whose entry no
// computer shares in that mode any more goes. Only a pointer gone from the shares drops a copy: an empty or unreadable
// list of copies (a locked keyring answers one) means nothing to refresh now.
const refreshCopies = async (state: LinkState, machine: string, client: KeyringClient, pointers: readonly KeyringPointer[]): Promise<void> => {
    const wanted = new Set(pointers.filter((pointer) => pointer.mode === "copy").map((pointer) => pointer.name));
    const opened = await openCopies(state, machine, client, wanted).catch((error: Error) => {
        if (keyringCodeOf(error) === undefined) {
            state.deps.logger.warn({ err: error, machine }, "keyring: the copies could not be read; the ones kept stay");
        }
        return new Map<string, string>();
    });
    const heard = [...(await state.memory()).values()];
    const shared = new Set(heard.flatMap((entry) => entry.pointers.filter((pointer) => pointer.mode === "copy").map((pointer) => pointer.name)));
    await state.deps.copies.change((current) => {
        const kept = Object.entries(current).filter(([name]) => shared.has(name) && !opened.has(name));
        const next = Object.fromEntries([...kept, ...opened]);
        const same = Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([name, value]) => current[name] === value);
        return same ? current : next;
    });
};

const mark = (set: Set<string>, machine: string, on: boolean): void => {
    if (on) {
        set.add(machine);
    } else {
        set.delete(machine);
    }
};

// What one keyring says now: its state, the entries it shares here, its keys against the pinned ones, then its copies.
// A keyring that does not answer says nothing about its entries: what it shared last stays listed, as offline.
const refreshOne = async (state: LinkState, machine: string): Promise<void> => {
    const client = state.deps.devices().client(machine);
    if (client === undefined) {
        state.answering.delete(machine);
        return;
    }
    const shares = await client.keyringShares(undefined, { signal: AbortSignal.timeout(READING_TIMEOUT_MS) }).catch((error: Error) => {
        if (keyringCodeOf(error) === undefined) {
            state.deps.logger.warn({ err: error, machine }, "keyring: the shares could not be read");
        }
        return undefined;
    });
    if (shares === undefined) {
        state.answering.delete(machine);
        return;
    }
    const book = await state.memory();
    const previous = book.get(machine);
    const { keyring } = shares;
    const pinned = pin(state, machine, previous, keyring?.keys);
    const kept = keyring === undefined ? previous?.keyring : { version: keyring.version, locked: keyring.locked, pendingInbox: keyring.pendingInbox };
    const heard: HeardKeyring = {
        pointers: keyring === undefined ? (previous?.pointers ?? []) : shares.pointers,
        ...opt("keyring", kept),
        ...opt("pinned", pinned),
        heardAt: state.now(),
    };
    book.set(machine, heard);
    mark(state.answering, machine, keyring !== undefined);
    mark(state.notSetUp, machine, keyring !== undefined && keyring.keys === undefined);
    state.reconnected.delete(machine);
    await state.deps.book.set(machine, heard);
    if (keyring !== undefined) {
        await refreshCopies(state, machine, client, heard.pointers);
    }
};

const pointersOf = async (state: LinkState): Promise<readonly DevicePointer[]> => {
    const ready = new Set(state.deps.devices().ready());
    return [...(await state.memory())].flatMap(([machine, heard]) => {
        const online = ready.has(machine) && state.answering.has(machine);
        return heard.pointers.map((pointer) => ({ machine, pointer, online, locked: online ? heard.keyring?.locked : undefined }));
    });
};

const keyringsOf = async (state: LinkState): Promise<readonly SandboxKeyring[]> => {
    const ready = new Set(state.deps.devices().ready());
    const book = await state.memory();
    return [...new Set([...book.keys(), ...ready])].toSorted().map((machine): SandboxKeyring => {
        const heard = book.get(machine);
        const online = ready.has(machine) && state.answering.has(machine);
        const sync = online ? state.deps.syncOf(machine) : undefined;
        return {
            machine,
            online,
            ...opt("locked", online ? heard?.keyring?.locked : undefined),
            ...opt("version", heard?.keyring?.version),
            ...opt("pendingInbox", online ? heard?.keyring?.pendingInbox : undefined),
            shared: heard?.pointers.length ?? 0,
            ...opt("sync", sync === undefined ? undefined : { fingerprint: keyFingerprint(sync.key), peers: [...sync.peers] }),
        };
    });
};

const deviceKeysOf = async (state: LinkState, machine: string): Promise<KeyringDeviceKeys | undefined> => {
    const pinned = (await state.memory()).get(machine)?.pinned;
    const usable = pinned !== undefined && !state.mismatched.has(machine) && !state.notSetUp.has(machine);
    return usable ? { seal: pinned.seal, inbox: pinned.inbox } : undefined;
};

// Why nothing can be sealed to a keyring this sandbox holds no usable key for.
const untrusted = (state: LinkState, machine: string): Refused => {
    if (state.notSetUp.has(machine)) {
        return refused(
            "no-keyring",
            `The keyring on ${machine} is installed but not set up yet, so it has no vault to keep a value in or to type one from: set it up on that computer first (intentic-machine keyring setup).`,
        );
    }
    return refused(
        "unavailable",
        state.mismatched.has(machine)
            ? `The keyring on ${machine} reports keys other than the ones this sandbox pinned for it, so nothing is sent to it until the computer reconnects.`
            : `This sandbox has not heard the keyring on ${machine} yet, so it has no key to seal the value to.`,
    );
};

// The pinned keys of a keyring this sandbox is about to seal something to, read once more if it was never heard.
const trustedKeys = async (state: LinkState, machine: string): Promise<KeyringDeviceKeys | Refused> => {
    const known = await deviceKeysOf(state, machine);
    if (known !== undefined) {
        return known;
    }
    // Read again only a keyring never heard: one whose keys are refused or missing says the same thing a moment later.
    if (!state.mismatched.has(machine) && !state.notSetUp.has(machine)) {
        await refreshOne(state, machine);
    }
    return (await deviceKeysOf(state, machine)) ?? untrusted(state, machine);
};

type ReleaseArgs = Parameters<KeyringLink["release"]>[0];
type TypeArgs = Parameters<KeyringLink["type"]>[0];
type InboxArgs = Parameters<KeyringLink["inbox"]>[0];

const releaseOne = async (state: LinkState, { machine, secret, lane, detail, conversationId, signal }: ReleaseArgs): ReturnType<KeyringLink["release"]> => {
    const client = state.deps.devices().client(machine);
    if (client === undefined) {
        return refused("unavailable", offline(machine));
    }
    const nonce = grantNonce();
    const grant = await signed(state, { secret, target: { kind: "sandbox", lane }, purpose: "agent", detail, conversationId }, nonce);
    if ("ok" in grant) {
        return grant;
    }
    const answer = await client.keyringRelease(grant.grant, { signal: deadline(ASKING_TIMEOUT_MS, signal) }).catch(unanswered(state, machine, "a release"));
    if (!answer.ok) {
        return refused(answer.code, answer.refusal);
    }
    let value: string;
    try {
        value = unseal((await state.deps.keys.pairs()).seal, answer.sealed, { kind: "release", sandbox: grant.sandbox, secret, nonce });
    } catch {
        return refused("bad-grant", `What the keyring on ${machine} sent for ${secret} did not open with this sandbox's key, so it was not used.`);
    }
    // Kept to mask from here on, never to answer a second use (released-values in keyring-stores.ts).
    state.deps.released.add(secret, value);
    return { ok: true, value, asked: answer.asked };
};

// The secret, released by `from`'s keyring sealed straight to `machine`'s, under the nonce the typing grant carries.
const relayed = async (state: LinkState, from: string, machine: string, body: GrantBody, nonce: string, signal: AbortSignal | undefined): Promise<SealedBox | Refused> => {
    const holder = state.deps.devices().client(from);
    if (holder === undefined) {
        return refused("unavailable", offline(from));
    }
    const keys = await trustedKeys(state, machine);
    if ("ok" in keys) {
        return keys;
    }
    const grant = await signed(state, { ...body, target: { kind: "relay", sealTo: keys.seal, toMachine: machine } }, nonce);
    if ("ok" in grant) {
        return grant;
    }
    const answer = await holder.keyringRelease(grant.grant, { signal: deadline(ASKING_TIMEOUT_MS, signal) }).catch(unanswered(state, from, "a relay"));
    return answer.ok ? answer.sealed : refused(answer.code, answer.refusal);
};

// What a typing carries besides its grant: a sandbox-held value sealed to the typing keyring, a box another computer's
// keyring sealed to it, or nothing when that keyring holds the entry itself.
const valueFor = async (state: LinkState, args: TypeArgs, body: GrantBody, nonce: string): Promise<SealedBox | undefined | Refused> => {
    if (args.value === undefined) {
        return args.relayFrom === undefined || args.relayFrom === args.machine ? undefined : relayed(state, args.relayFrom, args.machine, body, nonce, args.signal);
    }
    const keys = await trustedKeys(state, args.machine);
    if ("ok" in keys) {
        return keys;
    }
    const address = await sandboxOrRefused(state);
    return "ok" in address ? address : seal(keys.seal, args.value, { kind: "type", sandbox: address.url, secret: args.secret, nonce });
};

const typeOne = async (state: LinkState, args: TypeArgs): Promise<KeyringTypeResult> => {
    const client = state.deps.devices().client(args.machine);
    if (client === undefined) {
        return refused("unavailable", offline(args.machine));
    }
    const nonce = grantNonce();
    const body: GrantBody = { secret: args.secret, target: args.target, purpose: args.purpose, detail: args.detail, conversationId: args.conversationId };
    const sealed = await valueFor(state, args, body, nonce);
    if (sealed !== undefined && "ok" in sealed) {
        return sealed;
    }
    const grant = await signed(state, body, nonce);
    if ("ok" in grant) {
        return grant;
    }
    return client
        .keyringType({ grant: grant.grant, ...opt("sealed", sealed) }, { signal: deadline(ASKING_TIMEOUT_MS, args.signal) })
        .catch(unanswered(state, args.machine, "a typing"));
};

const inboxOne = async (state: LinkState, { machine, name, value, mode, kind, programs, hosts }: InboxArgs): Promise<KeyringInboxResult> => {
    const client = state.deps.devices().client(machine);
    if (client === undefined) {
        return refused("no-keyring", offline(machine));
    }
    const keys = await trustedKeys(state, machine);
    if ("ok" in keys) {
        return keys;
    }
    const address = await sandboxOrRefused(state);
    if ("ok" in address) {
        return address;
    }
    const sandbox = address.url;
    const sealed = seal(keys.inbox, value, { kind: "inbox", sandbox, secret: name });
    const answer = await client
        .keyringInbox({ name, sealed, mode, kind, programs, hosts, sandbox }, { signal: AbortSignal.timeout(ASKING_TIMEOUT_MS) })
        .catch(unanswered(state, machine, "an inbox item"));
    if (answer.ok) {
        // Taken in at once, it is a pointer now; waiting for an unlock, the next read after it finds it.
        await refreshOne(state, machine);
    }
    return answer;
};

// One choice among the computers sharing a name: one that answers now first, then the most recently changed entry.
const preferred = (left: DevicePointer, right: DevicePointer): number =>
    Number(right.online) - Number(left.online) || right.pointer.updatedAt - left.pointer.updatedAt;

export const createKeyringLink = (deps: KeyringLinkDeps): KeyringLinkRunner => {
    let loading: Promise<Map<string, HeardKeyring>> | undefined;
    const memory = (): Promise<Map<string, HeardKeyring>> => {
        loading ??= deps.book.all().then(
            (book) => new Map(Object.entries(book)),
            (error: Error) => {
                deps.logger.warn({ err: error }, "keyring: what the keyrings last said could not be read; starting from nothing");
                return new Map<string, HeardKeyring>();
            },
        );
        return loading;
    };
    const state: LinkState = {
        deps,
        now: deps.now ?? Date.now,
        memory,
        answering: new Set(),
        mismatched: new Set(),
        reconnected: new Set(),
        notSetUp: new Set(),
    };
    const refresh = async (machine?: string): Promise<void> => {
        await Promise.all((machine === undefined ? deps.devices().ready() : [machine]).map((target) => refreshOne(state, target)));
    };
    return {
        sandboxUrl: () => sandboxUrlOf(state),
        keyrings: () => keyringsOf(state),
        pointers: () => pointersOf(state),
        pointer: async (name) =>
            (await pointersOf(state))
                .filter((entry) => entry.pointer.name === name)
                .toSorted(preferred)
                .at(0),
        deviceKeys: (machine) => deviceKeysOf(state, machine),
        release: (args) => releaseOne(state, args),
        type: (args) => typeOne(state, args),
        inbox: (args) => inboxOne(state, args),
        refresh,
        arrived: async (machine) => {
            state.reconnected.add(machine);
            await refreshOne(state, machine);
        },
    };
};
