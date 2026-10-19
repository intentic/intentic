import { serialLock } from "@intentic/base/async";
import {
    type KeyringGrant,
    type KeyringInboxItem,
    type KeyringPointer,
    type KeyringSandboxKeys,
    KeyringSandboxKeysSchema,
    type KeyringState,
    type KeyringSyncItem,
    type KeyringSyncPeer,
    type SealedBox,
} from "@intentic/sandbox-contract/schemas/keyring";
import { keyFingerprint, newSealKeyPair, seal, unseal } from "@intentic/sandbox-contract/keyring-seal";
import type { z } from "zod";
import { type Answer, type KeyringDeps, NOT_SET_UP, type Opened, type OpenRequest, type PendingParts, refuse, type ValueRead, type VaultAccess } from "./passwords/access.js";
import { AppOps } from "./passwords/app-ops.js";
import { Askpass } from "./askpass/answer.js";
import type { AuditRecord } from "./audit.js";
import { Captures, seenIn } from "./passwords/capture.js";
import type { ConsentAnswer, VaultOpener } from "./consent/consent.js";
import { DEFAULT_SETTINGS, entryInfoOf, healthOf, liveEntries, usedEntry, withEntry } from "./passwords/entries.js";
import { Fills } from "./passwords/fills.js";
import { type KeysFile, pinOf, samePin } from "./keys.js";
import { Needs } from "./passwords/needs.js";
import { Phones } from "./passwords/phone.js";
import {
    acceptGrant,
    applyPatch,
    hostOf,
    isUnlocked,
    MINUTE_MS,
    modeNeedsPerson,
    NonceBook,
    releaseTargetOf,
    sandboxKey,
    shareWith,
    type TypeTarget,
    typeTargetOf,
    typingDecision,
    wideningOf,
} from "./policy.js";
import type { EntryInfo, EntryRules, KeyringRequest, KeyringResponse, Refusal, ShareInfo } from "./protocol.js";
import type { Place, Seen } from "./typing/typist.js";
import {
    emptyOpenPart,
    helloChallenge,
    helloWrapOf,
    newVaultKey,
    openDocument,
    type OpenPart,
    PENDING_INBOX_MAX,
    PENDING_SYNC_MAX,
    type SandboxPin,
    SCRYPT_COST,
    sealDocument,
    type SealedCopy,
    type StoredEntry,
    StoredEntrySchema,
    unwrapHello,
    unwrapPassphrase,
    VALUE_MAX_BYTES,
    type VaultDocument,
    type VaultFile,
    type Wrap,
    wrapWithHello,
    wrapWithPassphrase,
} from "./vault.js";

// THE KEYRING ITSELF: every op of the pipe (protocol.ts), answered from the vault, the keys file, a person's yes and the
// focused window. The rules are policy.ts's; this file gathers the facts they need, asks when they say to, and writes
// what changed. Three facts about the vault shape everything here:
// - While locked, only the OPEN part of vault.json and keys.json can be read: names, rules, shares, pins, ciphertext.
//   Anything that hands out a value or changes the vault needs the inner document, which only a person's unlock opens.
// - Unlocked (`while-here`), the inner document and its key stay in this process's memory until the unlock ends or
//   `lock`; locked, a single use opens it, does its one thing, and lets it go.
// - The open part and keys.json can be rewritten by any process of this user, so they are never trusted to grant
//   anything: a decision that lets a value go is always checked again against the inner document once it is open.

export type { KeyringDeps } from "./passwords/access.js";

type Op = KeyringRequest["op"];
type RequestOf<K extends Op> = Extract<KeyringRequest, { op: K }>;

// The ops intentic-machine relays for a sandbox, as against the ones this computer's own programs send.
const RELAYED_OPS = ["shares", "release", "type", "inbox", "copies", "sync-state", "sync-pair", "sync-outbox", "sync-deliver", "capture", "need", "phone-pair", "phone-fill"] as const;
type RelayedOp = (typeof RELAYED_OPS)[number];
type RelayedRequest = RequestOf<RelayedOp>;
// The Passwords app's ops from this computer's own programs (the app, the native host, the session helper).
const APP_OPS = [
    "capture-batch",
    "undo-capture",
    "seen",
    "reveal",
    "copy",
    "history",
    "restore",
    "settings",
    "set-settings",
    "activity",
    "fill-window",
    "fill-value",
    "candidates",
    "needs",
    "answer-need",
] as const;
type AppOp = (typeof APP_OPS)[number];
type AppRequest = RequestOf<AppOp>;
type LocalRequest = Exclude<KeyringRequest, RelayedRequest | AppRequest>;
const RELAYED = new Set<Op>(RELAYED_OPS);
const APP = new Set<Op>(APP_OPS);
const isRelayed = (request: KeyringRequest): request is RelayedRequest => RELAYED.has(request.op);
const isApp = (request: KeyringRequest): request is AppRequest => APP.has(request.op);

const fromConsent = (answer: Extract<ConsentAnswer, { ok: false }>): Refusal => refuse(answer.code, answer.reason);

interface Merged {
    readonly doc: VaultDocument;
    readonly accepted: number;
}

// How long a fresh unlock lasts after setup: long enough to add the first entries without asking again.
const SETUP_UNLOCK_MINUTES = 15;
// After a person answers a prompt, the window they were in takes a moment to get the keyboard back.
const FOCUS_SETTLE_MS = 400;

// A sync item carries one entry, without its shares: each computer shares its own entries with its own sandboxes.
const SyncEntrySchema = StoredEntrySchema.omit({ shares: true, revision: true });
type SyncEntry = z.infer<typeof SyncEntrySchema>;

const syncEntryOf = (entry: StoredEntry): SyncEntry => {
    const sent: SyncEntry = { name: entry.name, rules: entry.rules, source: entry.source, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    if (entry.backend !== undefined) {
        sent.backend = entry.backend;
    }
    if (entry.value !== undefined) {
        sent.value = entry.value;
    }
    if (entry.deleted === true) {
        sent.deleted = true;
    }
    return sent;
};

const pointerOf = (entry: EntryInfo, share: ShareInfo): KeyringPointer => ({
    name: entry.name,
    mode: share.mode,
    kind: entry.kind,
    programs: entry.programs,
    packages: entry.packages,
    hosts: entry.hosts,
    anyField: entry.anyField,
    source: entry.source,
    updatedAt: entry.updatedAt,
});

const modeWords = (mode: ShareInfo["mode"]): string =>
    mode === "each-use" ? "it asks you each time" : mode === "while-here" ? "it goes unasked while the keyring is unlocked" : "a copy is kept in that sandbox";

const rulesWords = (rules: EntryRules): string => {
    const programs = rules.programs.length === 0 ? "no program named" : `programs ${rules.programs.join(", ")}`;
    const field = rules.kind === "password" && !rules.anyField ? "password fields only" : "any field";
    return `${programs}; ${field}`;
};

export class Keyring {
    #file: VaultFile | undefined;
    #keys: KeysFile | undefined;
    #unlocked: { key: Buffer; doc: VaultDocument; until: number } | undefined;
    readonly #nonces = new NonceBook();
    readonly #lock = serialLock();
    #loaded = false;
    // The Passwords app's ops, each in a file of its own, reaching the vault through #access alone.
    readonly #access: VaultAccess;
    readonly #captures: Captures;
    readonly #appOps: AppOps;
    readonly #fills: Fills;
    readonly #needs: Needs;
    readonly #phones: Phones;
    readonly #askpass: Askpass;

    constructor(private readonly deps: KeyringDeps) {
        this.#access = {
            deps,
            file: () => this.#file,
            keys: async () => await this.#load(),
            held: () => this.#held(),
            open: async (file, request) => await this.#open(file, request),
            commit: async (opened, pending) => await this.#commit(opened, pending),
            writeOpen: async (open) => await this.#writeOpen(open),
            record: async (record) => await this.#record(record),
            valueOf: async (doc, entry) => await this.#valueOf(doc, entry),
            fetchKeys: async (sandbox) => await this.#fetchKeys(sandbox),
            typeInto: async (place, seen, value, asked) => await this.#typeInto(place, seen, value, asked),
        };
        this.#captures = new Captures(this.#access);
        this.#appOps = new AppOps(this.#access);
        this.#fills = new Fills(this.#access, this.#captures);
        this.#needs = new Needs(this.#access);
        this.#phones = new Phones(this.#access);
        this.#askpass = new Askpass(this.#access, this.#captures);
    }

    // ---- files and the vault's state ----

    async #load(): Promise<KeysFile> {
        if (!this.#loaded || this.#keys === undefined) {
            this.#file = await this.deps.vault.read();
            this.#keys = await this.deps.keys.read();
            this.#loaded = true;
        }
        return this.#keys;
    }

    #held(): { key: Buffer; doc: VaultDocument } | undefined {
        if (this.#unlocked !== undefined && !isUnlocked(this.#unlocked.until, this.deps.now())) {
            this.#forget();
        }
        return this.#unlocked;
    }

    #forget(): void {
        this.#unlocked?.key.fill(0);
        this.#unlocked = undefined;
        this.#askpass.forget();
        this.deps.backends.forget();
    }

    #opener(file: VaultFile): VaultOpener {
        const withPassphrase = async (passphrase: string): Promise<Buffer | undefined> => await unwrapPassphrase(file.wraps, passphrase);
        const hello = helloWrapOf(file.wraps);
        return hello === undefined
            ? { withPassphrase }
            : { withPassphrase, hello: { credential: hello.credential, challenge: hello.challenge, withSignature: (signature) => unwrapHello(hello, signature) } };
    }

    // Asks the person when `person` says to or the vault is locked, and opens the inner document with what the answer gave.
    // Offered choices, the person picks one in the keyring's own dialog first, and the verified yes then names it.
    async #open(file: VaultFile, request: OpenRequest): Promise<Opened | Refusal> {
        const held = this.#held();
        if (held !== undefined && !request.person) {
            return { doc: held.doc, key: held.key, asked: false, how: undefined };
        }
        const picked = await this.#choose(request);
        if (!picked.ok) {
            return picked;
        }
        const chosen = picked.choice;
        const label = request.choices?.find((choice) => choice.id === chosen)?.label;
        const message = label === undefined ? request.message : `${request.message} You chose: ${label}.`;
        const answer = await this.deps.consent.ask({ title: request.title, message, unlock: held === undefined, opener: this.#opener(file) });
        if (!answer.ok) {
            return fromConsent(answer);
        }
        if (held !== undefined) {
            return { doc: held.doc, key: held.key, asked: true, how: answer.how, choice: chosen };
        }
        if (answer.vaultKey === undefined) {
            return refuse("locked", "Passwords could not be opened with that answer: unlock it with its recovery key.");
        }
        try {
            return { doc: openDocument(answer.vaultKey, file.sealed), key: answer.vaultKey, asked: true, how: answer.how, choice: chosen };
        } catch (error) {
            return refuse("unavailable", error instanceof Error ? error.message : "The vault could not be opened.");
        }
    }

    // The choice a request offers, by its id: the dialog's answer, or the first choice where no dialog can be shown.
    async #choose(request: OpenRequest): Promise<{ readonly ok: true; readonly choice: string | undefined } | Refusal> {
        const choices = request.choices;
        const choose = this.deps.consent.choose;
        if (choices === undefined || choices.length === 0 || choose === undefined) {
            return { ok: true, choice: choices?.[0]?.id };
        }
        const picked = await choose({ title: request.title, message: request.message, choices });
        if (picked.kind === "cancelled") {
            return refuse("declined", "The person at the computer said no.");
        }
        return { ok: true, choice: picked.kind === "chosen" ? picked.id : choices[0]?.id };
    }

    // The copies kept in sandboxes, sealed afresh to each one's key whenever the document changes.
    #copiesOf(doc: VaultDocument, entries: readonly StoredEntry[]): Record<string, SealedCopy[]> {
        const copies = new Map<string, SealedCopy[]>();
        for (const entry of entries) {
            for (const share of entry.shares) {
                const pin = doc.pins[share.sandbox];
                if (share.mode === "copy" && entry.value !== undefined && pin !== undefined) {
                    const sealed = seal(pin.seal, entry.value, { kind: "copy", sandbox: share.sandbox, secret: entry.name, updatedAt: entry.updatedAt });
                    copies.set(share.sandbox, [...(copies.get(share.sandbox) ?? []), { name: entry.name, sealed, updatedAt: entry.updatedAt }]);
                }
            }
        }
        return Object.fromEntries(copies);
    }

    // Writes a changed document: the sealed part, the open part rebuilt from it, and the pins keys.json carries for
    // checking a grant while locked.
    async #commit(opened: { doc: VaultDocument; key: Buffer }, pending?: PendingParts): Promise<void> {
        const file = this.#file;
        if (file === undefined) {
            throw new Error("committing a vault that was never set up");
        }
        const doc = { ...opened.doc, revision: opened.doc.revision + 1 };
        const entries = Object.values(doc.entries).filter((entry) => entry.deleted !== true);
        const open: OpenPart = {
            entries: entries.map(entryInfoOf),
            backends: doc.backends.map((backend) => backend.backend),
            peers: doc.peers,
            revision: doc.revision,
            copies: this.#copiesOf(doc, entries),
            pendingInbox: pending?.pendingInbox ?? file.open.pendingInbox,
            pendingSync: pending?.pendingSync ?? file.open.pendingSync,
        };
        this.#openExtras(open, doc, file.open, pending);
        const next: VaultFile = { ...file, sealed: sealDocument(opened.key, doc), open };
        await this.deps.vault.write(next);
        this.#file = next;
        const keys = await this.#load();
        this.#keys = { ...keys, inbox: doc.inbox.publicKey, sync: doc.sync.publicKey, sandboxes: doc.pins };
        await this.deps.keys.write(this.#keys);
        if (this.#unlocked !== undefined) {
            this.#unlocked = { ...this.#unlocked, doc };
        }
    }

    // The Passwords app's parts of the open part: the settings and phones as the inner document has them, and what waits.
    #openExtras(open: OpenPart, doc: VaultDocument, before: OpenPart, pending: PendingParts | undefined): void {
        if (doc.settings !== undefined) {
            open.settings = doc.settings;
        }
        const phones = Object.entries(doc.phones ?? {}).map(([device, pin]) => ({ device, label: pin.keys.label, pairedAt: pin.pairedAt }));
        if (phones.length > 0) {
            open.phones = phones;
        }
        const captures = pending?.pendingCaptures ?? before.pendingCaptures;
        if (captures !== undefined && captures.length > 0) {
            open.pendingCaptures = captures;
        }
        const needs = pending?.pendingNeeds ?? before.pendingNeeds;
        if (needs !== undefined && needs.length > 0) {
            open.pendingNeeds = needs;
        }
        const seen = pending?.pendingSeen ?? before.pendingSeen;
        if (seen !== undefined && seen.length > 0) {
            open.pendingSeen = seen;
        }
    }

    // Writes only the open part, for what arrives while locked.
    async #writeOpen(open: OpenPart): Promise<void> {
        const file = this.#file;
        if (file !== undefined) {
            const next: VaultFile = { ...file, open };
            await this.deps.vault.write(next);
            this.#file = next;
        }
    }

    async #record(record: AuditRecord): Promise<void> {
        try {
            await this.deps.audit(record);
        } catch {
            // allow(silent-catch): a full disk must not turn a decision already made into a different one
        }
    }

    async #valueOf(doc: VaultDocument, entry: StoredEntry): Promise<ValueRead> {
        if (entry.backend !== undefined) {
            const read = await this.deps.backends.read(entry.backend, doc.backends, (name) => Promise.resolve(doc.entries[name]?.value));
            return read.ok ? read : refuse(read.code, read.reason);
        }
        return entry.value === undefined ? refuse("unknown", `${entry.name} holds no value.`) : { ok: true, value: entry.value };
    }

    async #fetchKeys(sandbox: string): Promise<KeyringSandboxKeys | Refusal> {
        try {
            return KeyringSandboxKeysSchema.parse(await this.deps.fetchKeys(sandbox));
        } catch (error) {
            const why = error instanceof Error ? `: ${error.message}` : "";
            return refuse("unavailable", `${hostOf(sandbox)} did not hand over its keys${why}. Is the sandbox running and reachable from this computer?`);
        }
    }

    #shown(name: string): EntryInfo | undefined {
        return this.#file?.open.entries.find((entry) => entry.name === name);
    }

    // ---- dispatch ----

    async handle(request: KeyringRequest): Promise<KeyringResponse<Op>> {
        await this.#load();
        if (isRelayed(request)) {
            return await this.#relayed(request);
        }
        return isApp(request) ? await this.#app(request) : await this.#local(request);
    }

    // What this computer's own programs ask: its CLI, the desktop app, intentic-askpass.
    async #local(request: LocalRequest): Promise<KeyringResponse<Op>> {
        switch (request.op) {
            case "state":
                return await this.state();
            case "setup":
                return await this.#lock(async () => await this.setup(request.passphrase, request.hello));
            case "unlock":
                return await this.#lock(async () => await this.unlock(request.minutes));
            case "lock":
                this.#forget();
                await this.#record({ op: "lock", outcome: "done" });
                return { ok: true };
            case "list":
                return this.list();
            case "add":
                return await this.#lock(async () => await this.add(request));
            case "edit":
                return await this.#lock(async () => await this.edit(request));
            case "remove":
                return await this.#lock(async () => await this.remove(request.name));
            case "share":
                return await this.#lock(async () => await this.share(request));
            case "unshare":
                return await this.#lock(async () => await this.unshare(request.name, request.sandbox));
            case "backend":
                return await this.#lock(async () => await this.backend(request.config));
            case "askpass":
                return await this.#askpass.askpass(request.prompt, request.parent);
            case "git-credential":
                return await this.#lock(async () => await this.#askpass.gitCredential(request.action, request.url, request.username));
            case "consent-upgrade":
                return await this.consentUpgrade(request.version);
        }
    }

    // The Passwords app's own ops on this computer (2026-10-19): its list's companions, its settings, its fills.
    async #app(request: AppRequest): Promise<KeyringResponse<Op>> {
        switch (request.op) {
            case "capture-batch":
                return await this.#lock(async () => await this.#captures.batch(request.items, request.from));
            case "undo-capture":
                return await this.#lock(async () => await this.#captures.undo(request.name, request.at));
            case "seen":
                return await this.#lock(async () => await this.#captures.seen(request.names));
            case "reveal":
                return await this.#appOps.reveal(request.name, request.version);
            case "copy":
                return await this.#appOps.copy(request.name, request.field, request.clearAfterSeconds);
            case "history":
                return await this.#appOps.history(request.name);
            case "restore":
                return await this.#lock(async () => await this.#appOps.restore(request.name, request.version));
            case "settings": {
                const phones = this.#file?.open.phones;
                return phones === undefined ? { ok: true, settings: this.#appOps.settings() } : { ok: true, settings: this.#appOps.settings(), phones };
            }
            case "set-settings":
                return await this.#lock(async () => await this.#appOps.setSettings(request.patch));
            case "activity":
                return await this.#appOps.activity(request.name, request.limit);
            case "fill-window":
                return await this.#lock(async () => await this.#fills.fillWindow(request.name));
            case "fill-value":
                return await this.#lock(async () => await this.#appOps.fillValue(request.origin, request.name));
            case "candidates":
                return this.#appOps.candidates(request.origin);
            case "needs":
                return this.#needs.needs();
            case "answer-need":
                return await this.#lock(async () => await this.#needs.answerNeed(request.id, request.answer, request.name, request.sealed, request.at));
        }
    }

    // What intentic-machine relays for a sandbox.
    async #relayed(request: RelayedRequest): Promise<KeyringResponse<Op>> {
        switch (request.op) {
            case "shares":
                return this.shares(request.sandbox);
            case "release":
                return await this.release(request.grant);
            case "type":
                return await this.type(request.input.grant, request.input.sealed);
            case "inbox":
                return await this.#lock(async () => await this.inbox(request.item));
            case "copies":
                return { ok: true, copies: this.#file?.open.copies[sandboxKey(request.sandbox)] ?? [] };
            case "sync-state":
                return await this.syncState();
            case "sync-pair":
                return await this.#lock(async () => await this.syncPair(request.pair));
            case "sync-outbox":
                return await this.#lock(async () => await this.syncOutbox());
            case "sync-deliver":
                return await this.#lock(async () => await this.syncDeliver(request.deliver.items));
            case "capture":
                return await this.#lock(async () => await this.#captures.capture(request.item, request.sandbox));
            // Not under the lock: a need may wait minutes on a person, and the vault's other ops must not wait with it.
            case "need":
                return await this.#needs.need(request.sandbox, request.need);
            case "phone-pair":
                return await this.#lock(async () => await this.#phones.pair(request.sandbox, request.phone));
            case "phone-fill":
                return await this.#lock(async () => await this.#phones.fill(request.sandbox, request.fill));
        }
    }

    // ---- the vault's own ops ----

    async state(): Answer<"state"> {
        const file = this.#file;
        const keys = await this.#load();
        const held = this.#held();
        const hello = this.deps.consent.hello;
        const helloReady = hello !== undefined && (file === undefined || helloWrapOf(file.wraps) !== undefined) && (await hello.available());
        const state: KeyringState = {
            version: this.deps.version,
            locked: held === undefined,
            unlock: helloReady ? ["hello", "passphrase"] : ["passphrase"],
            pendingInbox: file?.open.pendingInbox.length ?? 0,
            pendingCaptures: file?.open.pendingCaptures?.length ?? 0,
        };
        if (file !== undefined) {
            state.remember = (held === undefined ? file.open.settings : held.doc.settings)?.remember ?? DEFAULT_SETTINGS.remember;
        }
        if (this.#unlocked !== undefined && held !== undefined) {
            state.unlockedUntil = this.#unlocked.until;
        }
        if (file !== undefined && keys.inbox !== undefined) {
            state.keys = { seal: keys.seal.publicKey, inbox: keys.inbox };
        }
        return { ok: true, state, setUp: file !== undefined };
    }

    async setup(passphrase: string, withHello: boolean): Answer<"setup"> {
        if (this.#file !== undefined) {
            return refuse("declined", "This keyring is set up already. To start over, move ~/.intentic/keyring/vault.json aside first: it is the only copy of what it holds.");
        }
        const key = newVaultKey();
        const doc: VaultDocument = { v: 1, revision: 0, entries: {}, inbox: newSealKeyPair(), sync: newSealKeyPair(), peers: [], backends: [], pins: {} };
        const wraps: Wrap[] = [await wrapWithPassphrase(key, passphrase, this.deps.scrypt ?? SCRYPT_COST)];
        const hello = this.deps.consent.hello;
        let how = "passphrase";
        if (withHello && hello !== undefined && (await hello.available())) {
            const challenge = helloChallenge();
            const enrolled = await hello.enrol(this.deps.helloCredential, challenge, {
                title: "Set up the Intentic keyring",
                message: "Windows Hello will unlock the keyring on this computer. The passphrase you chose still opens it if Hello is ever reset.",
            });
            if (enrolled.ok) {
                wraps.push(wrapWithHello(key, { credential: this.deps.helloCredential, challenge, signature: enrolled.value.signature, publicKey: enrolled.value.publicKey }));
                how = "hello";
            }
        }
        this.#file = { v: 1, wraps, sealed: sealDocument(key, doc), open: emptyOpenPart() };
        this.#unlocked = { key, doc, until: this.deps.now() + SETUP_UNLOCK_MINUTES * MINUTE_MS };
        await this.#commit({ doc, key });
        await this.#record({ op: "setup", outcome: "done", how });
        return { ok: true };
    }

    async unlock(minutes: number): Answer<"unlock"> {
        const file = this.#file;
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const pending = file.open.pendingInbox;
        const captured = file.open.pendingCaptures?.length ?? 0;
        const waiting = pending.length === 0 ? "" : ` Waiting to be taken in: ${pending.map((item) => `${item.item.name} from ${hostOf(item.item.sandbox)}`).join(", ")}.`;
        const saving = captured === 0 ? "" : ` And save ${String(captured)} new ${captured === 1 ? "password" : "passwords"}.`;
        const opened = await this.#open(file, {
            title: "Unlock the Intentic keyring",
            message: `For ${String(minutes)} minutes, entries shared "while you're here" go to their sandboxes without asking.${waiting}${saving}`,
            person: true,
        });
        if ("ok" in opened) {
            await this.#record({ op: "unlock", outcome: "refused", code: opened.code });
            return opened;
        }
        const until = this.deps.now() + minutes * MINUTE_MS;
        this.#unlocked = { key: opened.key, doc: opened.doc, until };
        await this.#takeInPending(opened);
        await this.#record({ op: "unlock", outcome: "done", how: opened.how });
        return { ok: true, unlockedUntil: until };
    }

    // What arrived while locked: inbox items (named in the unlock prompt, so its yes takes them in) and sync items.
    async #takeInPending(opened: { doc: VaultDocument; key: Buffer }): Promise<void> {
        const file = this.#file;
        const captures = file?.open.pendingCaptures ?? [];
        const seen = file?.open.pendingSeen ?? [];
        if (file === undefined || (file.open.pendingInbox.length === 0 && file.open.pendingSync.length === 0 && captures.length === 0 && seen.length === 0)) {
            return;
        }
        let doc = opened.doc;
        for (const { item } of file.open.pendingInbox) {
            const taken = await this.#inboxInto(doc, item);
            if (taken.ok) {
                doc = taken.doc;
            } else {
                await this.#record({ op: "inbox", outcome: "refused", code: taken.refusal.code, secret: item.name, sandbox: item.sandbox, reason: taken.refusal.refusal });
            }
        }
        doc = this.#mergeSync(doc, file.open.pendingSync).doc;
        doc = seenIn(this.#captures.takeIn(doc, captures), new Set(seen));
        await this.#commit({ doc, key: opened.key }, { pendingInbox: [], pendingSync: [], pendingCaptures: [], pendingSeen: [] });
    }

    list(): KeyringResponse<"list"> {
        const held = this.#held();
        const open = this.#file?.open;
        if (held === undefined) {
            return { ok: true, entries: open?.entries ?? [], backends: open?.backends ?? [] };
        }
        // Worked out here, from the values, while they are in memory anyway; only the verdict leaves.
        const live = liveEntries(held.doc);
        const health = healthOf(live);
        const entries = live.map((entry) => {
            const info = entryInfoOf(entry);
            const verdict = health.get(entry.name);
            if (verdict !== undefined) {
                info.health = verdict;
            }
            return info;
        });
        return { ok: true, entries, backends: open?.backends ?? [] };
    }

    // The value an add or edit brought, opened from the inbox it was sealed to.
    #sentValue(doc: VaultDocument, name: string, sealed: SealedBox): { ok: true; value: string } | Refusal {
        let value: string;
        try {
            value = unseal(doc.inbox, sealed, { kind: "inbox", sandbox: "local", secret: name });
        } catch {
            return refuse("bad-grant", "The value was not sealed to this keyring's inbox: `intentic-machine keyring status` names the right key.");
        }
        return Buffer.byteLength(value, "utf8") > VALUE_MAX_BYTES ? refuse("bad-grant", `A value holds at most ${String(VALUE_MAX_BYTES / 1024)} KiB.`) : { ok: true, value };
    }

    #addedEntry(request: RequestOf<"add">, before: StoredEntry | undefined, value: string | undefined, revision: number): StoredEntry {
        const now = this.deps.now();
        const fresh = before === undefined || before.deleted === true;
        const entry: StoredEntry = {
            name: request.name,
            rules: request.rules,
            source: request.backend?.backend ?? "keyring",
            shares: fresh ? [] : before.shares,
            createdAt: fresh ? now : before.createdAt,
            updatedAt: now,
            revision,
        };
        if (request.backend !== undefined) {
            entry.backend = request.backend;
        }
        if (value !== undefined) {
            entry.value = value;
        }
        return entry;
    }

    async add(request: RequestOf<"add">): Answer<"add"> {
        const file = this.#file;
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        if ((request.sealed === undefined) === (request.backend === undefined)) {
            return refuse("bad-grant", "An entry takes either a value or a password manager to read it from, not both and not neither.");
        }
        const existing = this.#shown(request.name);
        if (existing !== undefined && !request.replace) {
            return refuse("declined", `The keyring has an entry named ${request.name} already: replace it with --replace, or change it with \`keyring edit\`.`);
        }
        const source = request.backend === undefined ? "the value you typed" : `${request.backend.backend} (${request.backend.ref})`;
        const opened = await this.#open(file, {
            title: existing === undefined ? `Add ${request.name} to the keyring?` : `Replace ${request.name} in the keyring?`,
            message: `${request.name}: ${source}. ${rulesWords(request.rules)}.`,
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const value = request.sealed === undefined ? undefined : this.#sentValue(opened.doc, request.name, request.sealed);
        if (value !== undefined && !value.ok) {
            return value;
        }
        const entry = this.#addedEntry(request, opened.doc.entries[request.name], value?.value, opened.doc.revision + 1);
        await this.#commit({ doc: withEntry(opened.doc, entry), key: opened.key });
        await this.#record({ op: "add", outcome: "done", secret: request.name, asked: opened.asked });
        return { ok: true };
    }

    async edit(request: RequestOf<"edit">): Answer<"edit"> {
        const file = this.#file;
        const shown = this.#shown(request.name);
        if (file === undefined || shown === undefined) {
            return refuse("unknown", `The keyring has no entry named ${request.name}.`);
        }
        const widening = wideningOf(shown, request.patch, request.sealed !== undefined);
        const opened = await this.#open(file, {
            title: `Change ${request.name}?`,
            message: widening.length === 0 ? `This change only narrows where ${request.name} may go.` : `This change ${widening.join("; ")}.`,
            person: widening.length > 0,
        });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[request.name];
        if (entry === undefined || entry.deleted === true) {
            return refuse("unknown", `The keyring has no entry named ${request.name}.`);
        }
        // The open part may have been rewritten: what the person was not asked about must not widen anything.
        if (!opened.asked && wideningOf(entry.rules, request.patch, request.sealed !== undefined).length > 0) {
            return refuse("declined", "The entry on file differs from what this change was judged against: ask again.");
        }
        const value = request.sealed === undefined ? undefined : this.#sentValue(opened.doc, request.name, request.sealed);
        if (value !== undefined && !value.ok) {
            return value;
        }
        const changed: StoredEntry = { ...entry, rules: applyPatch(entry.rules, request.patch), updatedAt: this.deps.now(), revision: opened.doc.revision + 1 };
        if (value !== undefined) {
            changed.value = value.value;
        }
        await this.#commit({ doc: withEntry(opened.doc, changed), key: opened.key });
        await this.#record({ op: "edit", outcome: "done", secret: request.name, asked: opened.asked, reason: widening.join("; ") });
        return { ok: true };
    }

    async remove(name: string): Answer<"remove"> {
        const file = this.#file;
        if (file === undefined || this.#shown(name) === undefined) {
            return refuse("unknown", `The keyring has no entry named ${name}.`);
        }
        const opened = await this.#open(file, { title: `Remove ${name} from the keyring?`, message: "Every sandbox it is shared with loses it, and a paired keyring removes it too.", person: true });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[name];
        if (entry === undefined) {
            return refuse("unknown", `The keyring has no entry named ${name}.`);
        }
        const tombstone: StoredEntry = { name, rules: entry.rules, source: entry.source, shares: [], createdAt: entry.createdAt, updatedAt: this.deps.now(), revision: opened.doc.revision + 1, deleted: true };
        await this.#commit({ doc: withEntry(opened.doc, tombstone), key: opened.key });
        await this.#record({ op: "remove", outcome: "done", secret: name });
        return { ok: true };
    }

    async share(asked: RequestOf<"share">): Answer<"share"> {
        const request = { ...asked, sandbox: sandboxKey(asked.sandbox) };
        const file = this.#file;
        const shown = this.#shown(request.name);
        if (file === undefined || shown === undefined) {
            return refuse("unknown", `The keyring has no entry named ${request.name}.`);
        }
        if (request.mode === "copy" && shown.backend !== undefined) {
            return refuse("declined", `${request.name} is read from ${shown.backend.backend} at each use, so no copy of it can be kept in a sandbox.`);
        }
        const keys = await this.#fetchKeys(request.sandbox);
        if ("ok" in keys) {
            return keys;
        }
        const fingerprint = keyFingerprint(keys.sign);
        const known = (await this.#load()).sandboxes[request.sandbox];
        const changed = known !== undefined && (known.sign !== keys.sign || known.seal !== keys.seal);
        const warning = changed ? " Its keys have CHANGED since this keyring last saw it: say no unless you know why." : "";
        const opened = await this.#open(file, {
            title: `Share ${request.name} with ${hostOf(request.sandbox)}?`,
            message: `${request.name} goes to the sandbox at ${hostOf(request.sandbox)} (this computer is "${request.machine}" there): ${modeWords(request.mode)}. The sandbox's key is ${fingerprint}.${warning}`,
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[request.name];
        if (entry === undefined || entry.deleted === true) {
            return refuse("unknown", `The keyring has no entry named ${request.name}.`);
        }
        const now = this.deps.now();
        const share: ShareInfo = { sandbox: request.sandbox, machine: request.machine, mode: request.mode, sharedAt: now };
        const shared: StoredEntry = { ...entry, shares: [...entry.shares.filter((other) => other.sandbox !== request.sandbox), share], updatedAt: now, revision: opened.doc.revision + 1 };
        const doc = withEntry({ ...opened.doc, pins: { ...opened.doc.pins, [request.sandbox]: { sign: keys.sign, seal: keys.seal, fetchedAt: now } } }, shared);
        await this.#commit({ doc, key: opened.key });
        await this.#record({ op: "share", outcome: "done", secret: request.name, sandbox: request.sandbox, target: request.mode });
        return { ok: true, fingerprint };
    }

    async unshare(name: string, asked: string): Answer<"unshare"> {
        const sandbox = sandboxKey(asked);
        const file = this.#file;
        if (file === undefined || this.#shown(name) === undefined) {
            return refuse("unknown", `The keyring has no entry named ${name}.`);
        }
        // Narrowing: asked only when the vault is locked, since writing needs it open.
        const opened = await this.#open(file, { title: `Stop sharing ${name} with ${hostOf(sandbox)}?`, message: "The sandbox loses it, and a copy kept there is dropped at its next refresh.", person: false });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[name];
        if (entry === undefined) {
            return refuse("unknown", `The keyring has no entry named ${name}.`);
        }
        const unshared: StoredEntry = { ...entry, shares: entry.shares.filter((share) => share.sandbox !== sandbox), revision: opened.doc.revision + 1 };
        await this.#commit({ doc: withEntry(opened.doc, unshared), key: opened.key });
        await this.#record({ op: "unshare", outcome: "done", secret: name, sandbox });
        return { ok: true };
    }

    async backend(config: RequestOf<"backend">["config"]): Answer<"backend"> {
        const file = this.#file;
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const opened = await this.#open(file, { title: `Read entries from ${config.backend}?`, message: `The keyring will run ${config.cli} to read the entries that name ${config.backend}.`, person: true });
        if ("ok" in opened) {
            return opened;
        }
        const backends = [...opened.doc.backends.filter((other) => other.backend !== config.backend), config];
        await this.#commit({ doc: { ...opened.doc, backends }, key: opened.key });
        await this.#record({ op: "backend", outcome: "done", target: config.backend });
        return { ok: true };
    }

    // ---- what a sandbox asks for ----

    shares(sandbox: string): KeyringResponse<"shares"> {
        const entries = this.#file?.open.entries ?? [];
        const pointers = entries.flatMap((entry) => entry.shares.filter((share) => share.sandbox === sandboxKey(sandbox)).map((share) => pointerOf(entry, share)));
        return { ok: true, pointers };
    }

    // The grant's entry and share, the vault opened as the share's mode says, re-checked against the inner document.
    async #grantedEntry(grant: KeyringGrant, prompt: { title: string; message: string }, extraPerson: boolean): Promise<{ opened: Opened; entry: StoredEntry } | Refusal> {
        const file = this.#file;
        const shownShare = this.#shown(grant.secret)?.shares.find((share) => share.sandbox === sandboxKey(grant.sandbox));
        if (file === undefined || shownShare === undefined) {
            return refuse("not-shared", `${grant.secret} is not shared with ${hostOf(grant.sandbox)} here.`);
        }
        const unlocked = this.#held() !== undefined;
        const opened = await this.#open(file, { ...prompt, person: modeNeedsPerson(shownShare.mode, unlocked) || extraPerson });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[grant.secret];
        const share = shareWith(entry, grant.sandbox);
        if (entry === undefined || share === undefined) {
            return refuse("not-shared", `${grant.secret} is not shared with ${hostOf(grant.sandbox)} here.`);
        }
        if (!samePin(pinOf(await this.#load(), sandboxKey(grant.sandbox)), opened.doc.pins[sandboxKey(grant.sandbox)])) {
            return refuse("bad-grant", `The keys on file for ${hostOf(grant.sandbox)} were changed outside the keyring: share ${grant.secret} with it again.`);
        }
        // The mode on file is the one in force: one the open part understated is not given away unasked.
        if (!opened.asked && modeNeedsPerson(share.mode, unlocked)) {
            return refuse("declined", "The share on file differs from what this use was judged against: the sandbox asks again.");
        }
        return { opened, entry };
    }

    async release(signed: RequestOf<"release">["grant"]): Answer<"release"> {
        const keys = await this.#load();
        const accepted = acceptGrant(signed, { pinOf: (sandbox) => pinOf(keys, sandbox), nonces: this.#nonces, now: this.deps.now() });
        if (!accepted.ok) {
            await this.#record({ op: "release", outcome: "refused", code: accepted.code, reason: accepted.reason });
            return refuse(accepted.code, accepted.reason);
        }
        const grant = accepted.grant;
        const target = releaseTargetOf(grant.target);
        if (!target.ok) {
            return refuse(target.code, target.reason);
        }
        const where = target.target.kind === "relay" ? `to be typed on ${target.target.toMachine}` : `for ${grant.detail}`;
        const conversation = grant.conversation === undefined ? "" : ` (conversation ${grant.conversation})`;
        const granted = await this.#grantedEntry(grant, { title: `Release ${grant.secret} to ${hostOf(grant.sandbox)}?`, message: `${hostOf(grant.sandbox)} asks for ${grant.secret} ${where}.${conversation}` }, false);
        if ("ok" in granted) {
            await this.#record({ op: "release", outcome: "refused", code: granted.code, secret: grant.secret, sandbox: grant.sandbox, reason: granted.refusal });
            return granted;
        }
        const value = await this.#valueOf(granted.opened.doc, granted.entry);
        const pin = granted.opened.doc.pins[sandboxKey(grant.sandbox)];
        if (!value.ok || pin === undefined) {
            return value.ok ? refuse("not-shared", `${grant.secret} is not shared with ${hostOf(grant.sandbox)} here.`) : value;
        }
        const sealed =
            target.target.kind === "relay"
                ? seal(target.target.sealTo, value.value, { kind: "type", sandbox: grant.sandbox, secret: grant.secret, nonce: grant.nonce })
                : seal(pin.seal, value.value, { kind: "release", sandbox: grant.sandbox, secret: grant.secret, nonce: grant.nonce });
        await this.#markUsed(granted.opened, granted.entry);
        await this.#record({
            op: "release",
            outcome: "granted",
            secret: grant.secret,
            sandbox: grant.sandbox,
            target: target.target.kind === "relay" ? `relay:${target.target.toMachine}` : target.target.lane,
            asked: granted.opened.asked,
            how: granted.opened.how,
            detail: grant.detail,
            conversation: grant.conversation,
        });
        return { ok: true, sealed, asked: granted.opened.asked };
    }

    async type(signed: RequestOf<"type">["input"]["grant"], box: SealedBox | undefined): Answer<"type"> {
        const keys = await this.#load();
        const accepted = acceptGrant(signed, { pinOf: (sandbox) => pinOf(keys, sandbox), nonces: this.#nonces, now: this.deps.now() });
        if (!accepted.ok) {
            await this.#record({ op: "type", outcome: "refused", code: accepted.code, reason: accepted.reason });
            return refuse(accepted.code, accepted.reason);
        }
        const grant = accepted.grant;
        const target = typeTargetOf(grant.target);
        if (!target.ok) {
            return refuse(target.code, target.reason);
        }
        const place: Place = target.target.kind === "window" ? { kind: "window" } : { kind: "android", serial: target.target.serial };
        const countdown = target.target.kind === "window" ? (target.target.countdownSeconds ?? 0) : 0;
        if (countdown > 0) {
            await this.deps.sleep(countdown * 1000);
        }
        const looked = await this.deps.typist.inspect(place);
        if (!looked.ok) {
            return refuse("unavailable", looked.reason);
        }
        const typed = box === undefined ? await this.#typeOwn(grant, target.target, place, looked.seen) : await this.#typeSent(grant, target.target, place, looked.seen, box, keys);
        await this.#record({
            op: "type",
            outcome: typed.ok ? "granted" : "refused",
            secret: grant.secret,
            sandbox: grant.sandbox,
            program: looked.seen.focus.program,
            asked: typed.ok ? typed.asked : undefined,
            code: typed.ok ? undefined : typed.code,
            reason: typed.ok ? undefined : typed.refusal,
            detail: grant.detail,
            conversation: grant.conversation,
        });
        return typed;
    }

    // A value the sandbox sent: its own guard (the grant's) decides, and the keyring only types.
    async #typeSent(grant: KeyringGrant, target: TypeTarget, place: Place, seen: Seen, box: SealedBox, keys: KeysFile): Answer<"type"> {
        const verdict = typingDecision({ target, focus: seen.focus });
        if (verdict.verdict !== "type") {
            return refuse("guard", verdict.verdict === "refuse" ? verdict.reason : "The sandbox's guard does not cover this window.");
        }
        let value: string;
        try {
            value = unseal(keys.seal, box, { kind: "type", sandbox: grant.sandbox, secret: grant.secret, nonce: grant.nonce });
        } catch {
            return refuse("bad-grant", "The value was not sealed to this keyring for this grant.");
        }
        return await this.#typeInto(place, seen, value, false);
    }

    // The keyring's own entry: its rules decide, a miss asks the person, and the grant's list only narrows.
    async #typeOwn(grant: KeyringGrant, target: TypeTarget, place: Place, seen: Seen): Answer<"type"> {
        const shown = this.#shown(grant.secret);
        if (shown === undefined) {
            return refuse("not-shared", `${grant.secret} is not shared with ${hostOf(grant.sandbox)} here.`);
        }
        const first = typingDecision({ target, focus: seen.focus, rules: shown });
        if (first.verdict === "refuse") {
            return refuse(first.code, first.reason);
        }
        const reasons = first.verdict === "ask" ? ` It asks because ${first.reasons.join(" and ")}.` : "";
        const granted = await this.#grantedEntry(
            grant,
            { title: `Type ${grant.secret} into ${seen.focus.program}?`, message: `${hostOf(grant.sandbox)} asks to type ${grant.secret} into ${seen.focus.program} (${grant.detail}).${reasons}` },
            first.verdict === "ask",
        );
        if ("ok" in granted) {
            return granted;
        }
        // Judged again on the rules on file, which a rewritten open part cannot loosen.
        const onFile = typingDecision({ target, focus: seen.focus, rules: granted.entry.rules });
        if (onFile.verdict === "refuse" || (onFile.verdict === "ask" && !granted.opened.asked)) {
            return refuse("guard", onFile.verdict === "refuse" ? onFile.reason : "The entry on file differs from what this use was judged against: the sandbox asks again.");
        }
        const value = await this.#valueOf(granted.opened.doc, granted.entry);
        if (!value.ok) {
            return value;
        }
        const typed = await this.#typeInto(place, seen, value.value, granted.opened.asked);
        if (typed.ok) {
            await this.#markUsed(granted.opened, granted.entry);
        }
        return typed;
    }

    // An entry handed out or typed: when, for the app's "last used", and proof that a captured value works.
    async #markUsed(opened: Opened, entry: StoredEntry): Promise<void> {
        await this.#commit({ doc: withEntry(opened.doc, usedEntry(entry, this.deps.now())), key: opened.key });
    }

    // Types after looking again when a prompt took the keyboard for a moment: the window the person said yes to must be
    // the one that has it back.
    async #typeInto(place: Place, seen: Seen, value: string, asked: boolean): Answer<"type"> {
        let now = seen;
        if (asked) {
            await this.deps.sleep(FOCUS_SETTLE_MS);
            const again = await this.deps.typist.inspect(place);
            if (!again.ok || again.seen.focus.program !== seen.focus.program || again.seen.handle !== seen.handle) {
                return refuse("guard", `The focus left ${seen.focus.program} while you answered: put the cursor back where it goes and ask again.`);
            }
            now = again.seen;
        }
        const typed = await this.deps.typist.type(place, now, value);
        if (!typed.ok) {
            return refuse("guard", typed.partly ? `${typed.reason} Part of it was typed: clear that field before trying again.` : typed.reason);
        }
        return { ok: true, program: now.focus.program, field: now.focus.field === "password" ? "password" : "text", asked };
    }

    async inbox(item: KeyringInboxItem): Answer<"inbox"> {
        const file = this.#file;
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        if (this.#held() === undefined) {
            const others = file.open.pendingInbox.filter((other) => other.item.name !== item.name || other.item.sandbox !== item.sandbox);
            await this.#writeOpen({ ...file.open, pendingInbox: [...others, { item, receivedAt: this.deps.now() }].slice(-PENDING_INBOX_MAX) });
            await this.#record({ op: "inbox", outcome: "pending", secret: item.name, sandbox: item.sandbox });
            return { ok: true, pending: true };
        }
        const opened = await this.#open(file, {
            title: `Keep ${item.name} from ${hostOf(item.sandbox)}?`,
            message: `${hostOf(item.sandbox)} sends ${item.name} to be kept in this keyring, shared back with it: ${modeWords(item.mode)}.`,
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const taken = await this.#inboxInto(opened.doc, item);
        if (!taken.ok) {
            return taken.refusal;
        }
        await this.#commit({ doc: taken.doc, key: opened.key });
        await this.#record({ op: "inbox", outcome: "done", secret: item.name, sandbox: item.sandbox, asked: true });
        return { ok: true, pending: false };
    }

    // An inbox item opened and made an entry shared back with its sandbox, whose keys come from its own address.
    async #inboxInto(doc: VaultDocument, item: KeyringInboxItem): Promise<{ ok: true; doc: VaultDocument } | { ok: false; refusal: Refusal }> {
        let value: string;
        try {
            value = unseal(doc.inbox, item.sealed, { kind: "inbox", sandbox: item.sandbox, secret: item.name });
        } catch {
            return { ok: false, refusal: refuse("bad-grant", `${item.name} was not sealed to this keyring's inbox.`) };
        }
        const now = this.deps.now();
        const sandbox = sandboxKey(item.sandbox);
        let pin: SandboxPin | undefined = doc.pins[sandbox];
        if (pin === undefined) {
            const fetched = await this.#fetchKeys(item.sandbox);
            if ("ok" in fetched) {
                return { ok: false, refusal: fetched };
            }
            pin = { sign: fetched.sign, seal: fetched.seal, fetchedAt: now };
        }
        const before = doc.entries[item.name];
        const kept = before === undefined || before.deleted === true ? [] : before.shares.filter((share) => share.sandbox !== sandbox);
        const entry: StoredEntry = {
            name: item.name,
            rules: { kind: item.kind, programs: item.programs, packages: [], hosts: item.hosts, anyField: false, askpass: [], askpassRememberMinutes: 0 },
            source: "keyring",
            value,
            shares: [...kept, { sandbox, machine: hostOf(sandbox), mode: item.mode, sharedAt: now }],
            createdAt: before === undefined || before.deleted === true ? now : before.createdAt,
            updatedAt: now,
            revision: doc.revision + 1,
        };
        return { ok: true, doc: withEntry({ ...doc, pins: { ...doc.pins, [sandbox]: pin } }, entry) };
    }

    // ---- keeping two keyrings in step ----

    async syncState(): Answer<"sync-state"> {
        const keys = await this.#load();
        const file = this.#file;
        if (file === undefined || keys.sync === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        return { ok: true, sync: { key: keys.sync, peers: file.open.peers, revision: file.open.revision } };
    }

    async syncPair(pair: RequestOf<"sync-pair">["pair"]): Answer<"sync-pair"> {
        const file = this.#file;
        const keys = await this.#load();
        if (file === undefined || keys.sync === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const opened = await this.#open(file, {
            title: `Pair with the keyring on ${pair.peer.device}?`,
            message: `This keyring (${pair.self}) is ${keyFingerprint(keys.sync)}; the one on ${pair.peer.device} is ${keyFingerprint(pair.peer.key)}. Say yes only if ${pair.peer.device} shows these same two. Paired, each keeps the other's entries in step.`,
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const peer: KeyringSyncPeer = { device: pair.peer.device, key: pair.peer.key, pairedAt: this.deps.now() };
        const peers = [...opened.doc.peers.filter((other) => other.key !== peer.key && other.device !== peer.device), peer];
        // A new peer is sent everything once: its mark starts before the first revision.
        await this.#commit({ doc: { ...opened.doc, peers, syncSent: { ...opened.doc.syncSent, [peer.key]: -1 } }, key: opened.key });
        await this.#record({ op: "sync-pair", outcome: "done", target: peer.device, asked: true });
        return { ok: true };
    }

    // One peer's share of the outbox: every entry changed since it was last sent, one sealed item each.
    #outboxFor(doc: VaultDocument, peer: KeyringSyncPeer): KeyringSyncItem[] {
        const since = doc.syncSent?.[peer.key] ?? -1;
        return Object.values(doc.entries)
            .filter((entry) => entry.revision > since)
            .map((entry) => ({
                from: doc.sync.publicKey,
                to: peer.key,
                revision: entry.revision,
                sealed: seal(peer.key, JSON.stringify(syncEntryOf(entry)), { kind: "sync", account: doc.sync.publicKey, device: peer.key, revision: entry.revision }),
            }));
    }

    // Only while unlocked: sealing an entry needs its value, and a sync is not worth a prompt.
    async syncOutbox(): Answer<"sync-outbox"> {
        const held = this.#held();
        if (held === undefined || held.doc.peers.length === 0) {
            return { ok: true, items: [] };
        }
        const items = held.doc.peers.flatMap((peer) => this.#outboxFor(held.doc, peer));
        if (items.length > 0) {
            const syncSent = Object.fromEntries(held.doc.peers.map((peer) => [peer.key, held.doc.revision]));
            await this.#commit({ doc: { ...held.doc, syncSent: { ...held.doc.syncSent, ...syncSent } }, key: held.key });
        }
        return { ok: true, items };
    }

    async syncDeliver(items: readonly KeyringSyncItem[]): Answer<"sync-deliver"> {
        const file = this.#file;
        const keys = await this.#load();
        if (file === undefined || keys.sync === undefined) {
            return { ok: true, accepted: 0 };
        }
        const peers = new Set(file.open.peers.map((peer) => peer.key));
        const ours = items.filter((item) => item.to === keys.sync && peers.has(item.from));
        const held = this.#held();
        if (held === undefined) {
            await this.#writeOpen({ ...file.open, pendingSync: [...file.open.pendingSync, ...ours].slice(-PENDING_SYNC_MAX) });
            return { ok: true, accepted: ours.length };
        }
        const merged = this.#mergeSync(held.doc, ours);
        if (merged.accepted > 0) {
            await this.#commit({ doc: merged.doc, key: held.key });
        }
        return { ok: true, accepted: merged.accepted };
    }

    // One item opened and checked as an entry of this vault, or undefined for one that does not open or parse.
    #syncedEntry(doc: VaultDocument, item: KeyringSyncItem): StoredEntry | undefined {
        try {
            const incoming = SyncEntrySchema.parse(JSON.parse(unseal(doc.sync, item.sealed, { kind: "sync", account: item.from, device: item.to, revision: item.revision })));
            const local = doc.entries[incoming.name];
            const shares = incoming.deleted === true ? [] : (local?.shares ?? []);
            return StoredEntrySchema.parse({ ...incoming, shares, revision: doc.revision + 1 });
        } catch {
            // allow(silent-catch): an item that does not open or parse is not the paired keyring's, and is counted out
            return undefined;
        }
    }

    // Items merged: the newer change of an entry wins, a removal included; shares stay this computer's.
    #mergeSync(doc: VaultDocument, items: readonly KeyringSyncItem[]): Merged {
        const peers = new Set(doc.peers.map((peer) => peer.key));
        const entries = { ...doc.entries };
        let accepted = 0;
        for (const item of items) {
            const incoming = peers.has(item.from) && item.to === doc.sync.publicKey ? this.#syncedEntry(doc, item) : undefined;
            if (incoming !== undefined) {
                const local = entries[incoming.name];
                if (local === undefined || local.updatedAt < incoming.updatedAt) {
                    entries[incoming.name] = incoming;
                }
                accepted++;
            }
        }
        return { doc: { ...doc, entries }, accepted };
    }

    // ---- this computer's own programs ----

    async consentUpgrade(version: string): Answer<"consent-upgrade"> {
        const file = this.#file;
        const answer = await this.deps.consent.ask({
            title: `Replace the keyring with version ${version}?`,
            message: `intentic-machine asks to replace the keyring program on this computer with release ${version}. Say yes if you started this update.`,
            unlock: false,
            opener: file === undefined ? undefined : this.#opener(file),
        });
        await this.#record({ op: "consent-upgrade", outcome: answer.ok ? "done" : "refused", target: version });
        return answer.ok ? { ok: true } : fromConsent(answer);
    }
}
