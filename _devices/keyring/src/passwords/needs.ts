import { entriesFor } from "@intentic/sandbox-contract/policy/keyring-origins";
import { grantNonce } from "@intentic/sandbox-contract/keyring-seal";
import {
    KEYRING_GRANT_TTL_MAX_MS,
    type KeyringNeed,
    type KeyringNeedAnswer,
    type KeyringPendingNeed,
    type KeyringPointer,
    type KeyringShareMode,
    type SealedBox,
} from "@intentic/sandbox-contract/schemas/keyring";
import { type Answer, NOT_SET_UP, type Opened, refuse, type VaultAccess } from "./access.js";
import { applyCapture, openedValue } from "./capture.js";
import { candidateOf, entryInfoOf, liveEntries, placeWords, titleOf, withEntry } from "./entries.js";
import { hostOf, sandboxKey } from "../policy.js";
import type { EntryInfo, Refusal } from "../protocol.js";
import { PENDING_NEEDS_MAX, type StoredEntry, type VaultDocument } from "../vault.js";

// AN AGENT'S NEED: a sandbox asking for a credential by where it is used ("github.com", "ssh radar@build-01") rather
// than by name. The keyring finds the entries that serve that place and asks the person, in a prompt naming the sandbox,
// the place, the account and what it is for, whether this sandbox may use the one it found, and on what terms. A yes
// shares it (once: `each-use`; while I'm here; always: a copy); a no tells the sandbox nothing about what was there. A
// need nobody answers in time waits under Requests in the Passwords app for a day, and the sandbox is told `pending`.

const NEED_LIFE_MS = 24 * 60 * 60_000;

const NEED_CHOICES = [
    { id: "once", label: "Allow once" },
    { id: "while-here", label: "While I'm here" },
    { id: "always", label: "Always" },
    { id: "deny", label: "Deny" },
] as const satisfies readonly { readonly id: KeyringNeedAnswer; readonly label: string }[];

const MODE_OF = { once: "each-use", "while-here": "while-here", always: "copy" } as const satisfies Record<Exclude<KeyringNeedAnswer, "deny">, KeyringShareMode>;
const RANK = { "each-use": 0, "while-here": 1, copy: 2 } as const satisfies Record<KeyringShareMode, number>;

const answerOf = (choice: string | undefined): KeyringNeedAnswer => NEED_CHOICES.find((known) => known.id === choice)?.id ?? "once";

// Codes that mean nobody was there to answer, rather than a no.
const NOBODY = new Set<Refusal["code"]>(["busy", "locked", "unavailable"]);

const pointerOf = (entry: StoredEntry, mode: KeyringShareMode): KeyringPointer => ({
    name: entry.name,
    mode,
    kind: entry.rules.kind,
    programs: entry.rules.programs,
    packages: entry.rules.packages,
    hosts: entry.rules.hosts,
    anyField: entry.rules.anyField,
    source: entry.source,
    updatedAt: entry.updatedAt,
});

const whoAsks = (sandbox: string): string => `${hostOf(sandbox)}'s agent`;

const needWords = (sandbox: string, need: KeyringNeed, user: string | undefined): string => {
    const account = user === undefined ? "" : ` as ${user}`;
    const conversation = need.conversation === undefined ? "" : ` (conversation ${need.conversation})`;
    return `${whoAsks(sandbox)} wants to sign in to ${placeWords(need.origin)}${account}: ${need.detail}.${conversation}`;
};

type Shared = { readonly ok: true; readonly doc: VaultDocument; readonly pointer: KeyringPointer } | Refusal;

// Which of a need's matches the app's answer names: the one asked for, else the best; none, when the person typed one.
const pickedFor = (waiting: KeyringPendingNeed, name: string | undefined, sealed: SealedBox | undefined): { readonly ok: true; readonly name: string | undefined } | Refusal => {
    const chosen = name ?? waiting.matches[0];
    if (chosen !== undefined && !waiting.matches.includes(chosen)) {
        return refuse("unknown", `${chosen} is not one of the passwords that fit this request.`);
    }
    return chosen === undefined && sealed === undefined ? refuse("unknown", "Nothing fits this request: type the password once to answer it.") : { ok: true, name: chosen };
};

export class Needs {
    #pending: KeyringPendingNeed[] | undefined;

    constructor(private readonly vault: VaultAccess) {}

    // The waiting needs, read once from the open part (the keyring may have restarted), each kept a day.
    #list(): KeyringPendingNeed[] {
        const now = this.vault.deps.now();
        this.#pending = (this.#pending ?? this.vault.file()?.open.pendingNeeds ?? []).filter((need) => now - need.at < NEED_LIFE_MS);
        return this.#pending;
    }

    async #save(pending: KeyringPendingNeed[]): Promise<void> {
        this.#pending = pending.slice(-PENDING_NEEDS_MAX);
        const file = this.vault.file();
        if (file !== undefined) {
            await this.vault.writeOpen({ ...file.open, pendingNeeds: this.#pending });
        }
    }

    #shown(): EntryInfo[] {
        const held = this.vault.held();
        return held === undefined ? (this.vault.file()?.open.entries ?? []) : liveEntries(held.doc).map(entryInfoOf);
    }

    async need(asked: string, need: KeyringNeed): Answer<"need"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("no-keyring", NOT_SET_UP);
        }
        const sandbox = sandboxKey(asked);
        const matches = entriesFor(this.#shown().map(candidateOf), need.origin, need.username).map((match) => match.name);
        if (matches.length === 0 && !need.typeOnce) {
            return refuse("unknown", `Nothing is saved on this computer for ${placeWords(need.origin)}.`);
        }
        const waiting: KeyringPendingNeed = { id: grantNonce(), sandbox, need, matches, at: this.vault.deps.now() };
        const answered = matches.length > 0 ? this.#askMatch(waiting, matches) : this.#askTypeOnce(waiting);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<"late">((resolve) => {
            timer = setTimeout(() => resolve("late"), this.vault.deps.needWaitMs ?? KEYRING_GRANT_TTL_MAX_MS);
            timer.unref?.();
        });
        const first = await Promise.race([answered, late]);
        clearTimeout(timer);
        if (first !== "late" && !(!first.ok && NOBODY.has(first.code))) {
            await this.vault.record({ op: "need", outcome: first.ok ? "granted" : "refused", secret: first.ok ? first.pointer.name : undefined, sandbox, code: first.ok ? undefined : first.code, detail: need.detail, asked: true });
            return first;
        }
        await this.#save([...this.#list(), waiting]);
        // The prompt may still be open: its answer, when it comes, settles the request it left waiting.
        if (first === "late") {
            void answered.then(async (settled) => {
                if (settled.ok || !NOBODY.has(settled.code)) {
                    await this.#save(this.#list().filter((other) => other.id !== waiting.id));
                }
            });
        }
        await this.vault.record({ op: "need", outcome: "pending", sandbox, detail: need.detail });
        return refuse("pending", `Nobody answered at the computer yet: the request waits in Passwords under Requests.`);
    }

    // A match: the person chooses how it is shared, then says a verified yes to that.
    async #askMatch(waiting: KeyringPendingNeed, matches: readonly string[]): Answer<"need"> {
        const file = this.vault.file();
        const shown = this.#shown().find((entry) => entry.name === matches[0]);
        if (file === undefined || shown === undefined) {
            return refuse("unknown", `Nothing is saved on this computer for ${placeWords(waiting.need.origin)}.`);
        }
        const opened = await this.vault.open(file, { title: `Let ${whoAsks(waiting.sandbox)} sign in?`, message: needWords(waiting.sandbox, waiting.need, shown.username), person: true, choices: NEED_CHOICES });
        if ("ok" in opened) {
            return opened;
        }
        const answer = answerOf(opened.choice);
        if (answer === "deny") {
            return refuse("declined", "The person at the computer said no.");
        }
        return await this.#shareAnswer(opened, shown.name, waiting.sandbox, answer, false);
    }

    // No match, and the sandbox asked for the box: the person types it once, then says how it is shared.
    async #askTypeOnce(waiting: KeyringPendingNeed): Answer<"need"> {
        const file = this.vault.file();
        const box = this.vault.deps.consent.askValue;
        if (file === undefined || box === undefined) {
            return refuse("unavailable", "This computer cannot show Passwords' own box to type it once.");
        }
        const place = placeWords(waiting.need.origin);
        const typed = await box({
            title: `${whoAsks(waiting.sandbox)} needs a password for ${place}`,
            message: `${whoAsks(waiting.sandbox)} needs a password for ${place} (${waiting.need.detail}): type it once. Passwords keeps it here and shares it with ${hostOf(waiting.sandbox)} as you choose next.`,
            remember: true,
            username: { value: waiting.need.username },
        });
        if (typed.kind !== "answered") {
            return typed.kind === "cancelled" ? refuse("declined", "The person at the computer closed the box.") : refuse("unavailable", typed.reason);
        }
        const opened = await this.vault.open(file, { title: `Share ${place} with ${hostOf(waiting.sandbox)}?`, message: needWords(waiting.sandbox, waiting.need, typed.username ?? waiting.need.username), person: true, choices: NEED_CHOICES });
        if ("ok" in opened) {
            return opened;
        }
        const answer = answerOf(opened.choice);
        const now = this.vault.deps.now();
        const draft = { origin: waiting.need.origin, username: typed.username ?? waiting.need.username, source: "agent", via: hostOf(waiting.sandbox), kind: "password", at: now } as const;
        const saved = applyCapture(opened.doc, draft, typed.value, { now, deliberate: true });
        if (saved.name === undefined) {
            return refuse("declined", `${place} is on the never-save list.`);
        }
        const doc = saved.doc;
        if (answer === "deny") {
            await this.vault.commit({ doc, key: opened.key });
            return refuse("declined", "Saved here, and not shared: the person said no to sharing it.");
        }
        return await this.#shareAnswer({ ...opened, doc }, saved.name, waiting.sandbox, answer, true);
    }

    async #shareAnswer(opened: Opened, name: string, sandbox: string, answer: Exclude<KeyringNeedAnswer, "deny">, saved: boolean): Answer<"need"> {
        const shared = await this.#shareInto(opened.doc, name, sandbox, MODE_OF[answer]);
        if (!shared.ok) {
            return shared;
        }
        await this.vault.commit({ doc: shared.doc, key: opened.key });
        return { ok: true, pointer: shared.pointer, asked: true, saved };
    }

    // The entry shared with `sandbox` at `mode`, or at the wider share it has already. Keys are pinned from the sandbox's
    // own address the first time, as `share` pins them.
    async #shareInto(doc: VaultDocument, name: string, sandbox: string, wanted: KeyringShareMode): Promise<Shared> {
        const entry = doc.entries[name];
        if (entry === undefined || entry.deleted === true) {
            return refuse("unknown", `There is no password named ${name}.`);
        }
        let pin = doc.pins[sandbox];
        const now = this.vault.deps.now();
        if (pin === undefined) {
            const keys = await this.vault.fetchKeys(sandbox);
            if ("ok" in keys) {
                return keys;
            }
            pin = { sign: keys.sign, seal: keys.seal, fetchedAt: now };
        }
        const before = entry.shares.find((share) => share.sandbox === sandbox);
        // A backed entry has no value to keep a copy of: "Always" goes unasked while here instead.
        const asked: KeyringShareMode = wanted === "copy" && entry.backend !== undefined ? "while-here" : wanted;
        const mode = before !== undefined && RANK[before.mode] > RANK[asked] ? before.mode : asked;
        const share = { sandbox, machine: before?.machine ?? hostOf(sandbox), mode, sharedAt: now };
        const shared: StoredEntry = { ...entry, shares: [...entry.shares.filter((other) => other.sandbox !== sandbox), share], updatedAt: now, revision: doc.revision + 1 };
        return { ok: true, doc: withEntry({ ...doc, pins: { ...doc.pins, [sandbox]: pin } }, shared), pointer: pointerOf(shared, mode) };
    }

    needs(): Awaited<Answer<"needs">> {
        return { ok: true, pending: this.#list() };
    }

    // The value the person typed once in the app, for a need nothing matched: kept as an entry of its own.
    #typedIn(doc: VaultDocument, waiting: KeyringPendingNeed, sealed: SealedBox, at: number | undefined): { readonly ok: true; readonly doc: VaultDocument; readonly name: string | undefined } | Refusal {
        const draft = { origin: waiting.need.origin, username: waiting.need.username, source: "agent", via: "Passwords", kind: "password", at: at ?? waiting.at, sealed } as const;
        const value = openedValue(doc, draft);
        if (!value.ok) {
            return value;
        }
        const saved = applyCapture(doc, draft, value.value, { now: this.vault.deps.now(), deliberate: true });
        return { ok: true, doc: saved.doc, name: saved.name };
    }

    async answerNeed(id: string, answer: KeyringNeedAnswer, name: string | undefined, sealed: SealedBox | undefined, at: number | undefined): Answer<"answer-need"> {
        const file = this.vault.file();
        const waiting = this.#list().find((need) => need.id === id);
        if (file === undefined || waiting === undefined) {
            return refuse("unknown", "That request is not waiting any more.");
        }
        const rest = this.#list().filter((need) => need.id !== id);
        if (answer === "deny") {
            await this.#save(rest);
            await this.vault.record({ op: "answer-need", outcome: "refused", code: "declined", sandbox: waiting.sandbox });
            return { ok: true };
        }
        const picked = pickedFor(waiting, name, sealed);
        if (!picked.ok) {
            return picked;
        }
        const chosen = picked.name;
        const shown = this.#shown().find((entry) => entry.name === chosen);
        const what = shown === undefined ? placeWords(waiting.need.origin) : titleOf(shown);
        const opened = await this.vault.open(file, { title: `Let ${whoAsks(waiting.sandbox)} use ${what}?`, message: needWords(waiting.sandbox, waiting.need, shown?.username ?? waiting.need.username), person: true });
        if ("ok" in opened) {
            return opened;
        }
        const typedIn = chosen === undefined && sealed !== undefined ? this.#typedIn(opened.doc, waiting, sealed, at) : { ok: true as const, doc: opened.doc, name: chosen };
        if (!typedIn.ok) {
            return typedIn;
        }
        const { doc, name: target } = typedIn;
        if (target === undefined) {
            return refuse("declined", `${placeWords(waiting.need.origin)} is on the never-save list.`);
        }
        const shared = await this.#shareInto(doc, target, waiting.sandbox, MODE_OF[answer]);
        if (!shared.ok) {
            return shared;
        }
        await this.vault.commit({ doc: shared.doc, key: opened.key }, { pendingNeeds: rest });
        this.#pending = rest;
        await this.vault.record({ op: "answer-need", outcome: "granted", secret: target, sandbox: waiting.sandbox, target: answer, asked: true });
        return { ok: true };
    }
}
