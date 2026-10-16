import {
    KeyringGrantSchema,
    type KeyringGrant,
    type KeyringGrantTarget,
    type KeyringRefusalCode,
    type KeyringShareMode,
    type SignedKeyringGrant,
} from "@intentic/sandbox-contract";
import { verifyGrant } from "@intentic/sandbox-contract/keyring-seal";
import { z } from "zod";
import type { EntryPatch, EntryRules, ShareInfo } from "./protocol.js";
import type { SandboxPin, StoredEntry } from "./vault.js";

// THE KEYRING'S DECISIONS, as pure functions of the facts in hand: whether a grant is the sandbox's and unspent, whether
// a share lets a value go without asking, whether the focused window may receive it, and whether an edit widens what an
// entry allows. Nothing here reads a file, a clock or a window: core.ts gathers the facts and acts on the verdict, so
// every rule is a unit test away.

export type Refused = { readonly ok: false; readonly code: KeyringRefusalCode; readonly reason: string };
const refuse = (code: KeyringRefusalCode, reason: string): Refused => ({ ok: false, code, reason });

export const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        // allow(silent-catch): a name that is not a URL is shown as it was given, which is all a prompt needs of it
        return url;
    }
};

// A sandbox's address as the keyring files it: without trailing slashes, so a link named `https://x.dev/` and a grant
// naming `https://x.dev` are the same sandbox.
export const sandboxKey = (url: string): string => url.replace(/\/+$/u, "");

// ---- grants ----

// Read before the signature is checked, and only to choose the key that checks it.
const GrantSandboxSchema = z.object({ sandbox: z.string().url() });

export const grantSandboxOf = (signed: SignedKeyringGrant): string | undefined => {
    try {
        const parsed = GrantSandboxSchema.safeParse(JSON.parse(Buffer.from(signed.payload, "base64url").toString("utf8")));
        return parsed.success ? parsed.data.sandbox : undefined;
    } catch {
        // allow(silent-catch): a payload that is not JSON names no sandbox, and the caller refuses it as a bad grant
        return undefined;
    }
};

// Nonces already answered, each kept until its grant would have expired anyway: past that, verifyGrant refuses the
// grant as expired, so forgetting the nonce reopens nothing.
export class NonceBook {
    readonly #spent = new Map<string, number>();

    // Bounded, so a flood of valid grants cannot grow it past what two minutes of honest use holds.
    constructor(private readonly max = 50_000) {}

    #prune(now: number): void {
        for (const [nonce, expiresAt] of this.#spent) {
            if (expiresAt <= now) {
                this.#spent.delete(nonce);
            }
        }
        while (this.#spent.size >= this.max) {
            const oldest = this.#spent.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.#spent.delete(oldest.value);
        }
    }

    // Spends `nonce`; false if it was spent already.
    spend(nonce: string, expiresAt: number, now: number): boolean {
        this.#prune(now);
        if (this.#spent.has(nonce)) {
            return false;
        }
        this.#spent.set(nonce, expiresAt);
        return true;
    }
}

export interface GrantFacts {
    // The sandbox's pinned keys, by its address.
    readonly pinOf: (sandbox: string) => SandboxPin | undefined;
    readonly nonces: NonceBook;
    readonly now: number;
}

// The grant, if the sandbox it names signed it with the key pinned for it, it has not expired, and its nonce is unspent.
// The nonce is spent here, before anyone is asked, so two copies of one grant racing each other get one answer.
export const acceptGrant = (signed: SignedKeyringGrant, facts: GrantFacts): { readonly ok: true; readonly grant: KeyringGrant } | Refused => {
    const sandbox = grantSandboxOf(signed);
    if (sandbox === undefined) {
        return refuse("bad-grant", "The grant could not be read.");
    }
    const pin = facts.pinOf(sandboxKey(sandbox));
    if (pin === undefined) {
        return refuse("not-shared", `This keyring shares nothing with ${hostOf(sandbox)}.`);
    }
    const verdict = verifyGrant(pin.sign, signed, facts.now);
    if (!verdict.ok) {
        return refuse(verdict.code, `${verdict.reason.charAt(0).toUpperCase()}${verdict.reason.slice(1)}.`);
    }
    if (!facts.nonces.spend(verdict.grant.nonce, verdict.grant.expiresAt, facts.now)) {
        return refuse("replayed", "This grant was answered already: the sandbox asks again with a new one.");
    }
    return { ok: true, grant: KeyringGrantSchema.parse(verdict.grant) };
};

// The live share of `entry` with `sandbox`, if there is one.
export const shareWith = (entry: StoredEntry | undefined, sandbox: string): ShareInfo | undefined =>
    entry === undefined || entry.deleted === true ? undefined : entry.shares.find((share) => share.sandbox === sandboxKey(sandbox));

// Whether handing out a value under `mode` needs a person: `each-use` always; `while-here` and `copy` only while
// locked, since the person's unlock is what opens them. A `copy` is already in the sandbox; asked to release one, the
// keyring treats it like `while-here`.
export const modeNeedsPerson = (mode: KeyringShareMode, unlocked: boolean): boolean => mode === "each-use" || !unlocked;

export type ReleaseTarget = Extract<KeyringGrantTarget, { readonly kind: "sandbox" | "relay" }>;
export type TypeTarget = Extract<KeyringGrantTarget, { readonly kind: "window" | "android" }>;

export const releaseTargetOf = (target: KeyringGrantTarget): { readonly ok: true; readonly target: ReleaseTarget } | Refused =>
    target.kind === "sandbox" || target.kind === "relay"
        ? { ok: true, target }
        : refuse("bad-grant", "This grant asks for typing, which is not a release: the sandbox sends it as a typing.");

export const typeTargetOf = (target: KeyringGrantTarget): { readonly ok: true; readonly target: TypeTarget } | Refused =>
    target.kind === "window" || target.kind === "android"
        ? { ok: true, target }
        : refuse("bad-grant", "This grant asks for a release, which is not a typing: the sandbox sends it as a release.");

// ---- typing ----

// The focused window or field as a typist found it. `program` is the executable's file name (or the Android package),
// `path` its whole path where the platform tells it.
export interface Focus {
    readonly program: string;
    readonly path: string;
    // What the platform says of the focused field. `unknown` where it cannot say (X11, Wayland, macOS), which is
    // treated as not a password field: a password is never typed where it might be echoed on a strength of a guess.
    readonly field: "password" | "text" | "unknown";
}

const SEPARATOR = /[\\/]/u;
const windowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") || path.includes("\\");
const pathKey = (path: string): string => (windowsPath(path) ? path.replace(/\//gu, "\\").toLowerCase() : path);

export const basenameOf = (path: string): string => path.split(SEPARATOR).at(-1) ?? path;

// A program on a list matches by its file name without case (`FortiClient.exe`, `ssh`), or, written with a separator,
// by its whole path: without case on Windows, exactly elsewhere.
export const programMatches = (list: readonly string[], focus: Focus): boolean =>
    list.some((item) => (SEPARATOR.test(item) ? focus.path !== "" && pathKey(item) === pathKey(focus.path) : item.toLowerCase() === focus.program.toLowerCase()));

export type TypingVerdict =
    | { readonly verdict: "type" }
    // Allowed with a person's yes, for these reasons, each a sentence fragment the prompt lists.
    | { readonly verdict: "ask"; readonly reasons: readonly string[] }
    | { readonly verdict: "refuse"; readonly code: "guard"; readonly reason: string };

export interface TypingCase {
    readonly target: TypeTarget;
    readonly focus: Focus;
    // The keyring's own entry, whose rules are the ones in force; absent for a value the sandbox sent, whose guard is
    // the grant's own.
    readonly rules?: EntryRules;
}

const fieldReason = (focus: Focus): string =>
    focus.field === "unknown" ? "this computer cannot tell whether the focused field is a password field" : "the focused field is not a password field";

const guard = (reason: string): TypingVerdict => ({ verdict: "refuse", code: "guard", reason });

// Whether a value may be typed where the focus is. For the keyring's own entry, its program (or package) list and its
// `anyField` decide, a miss asks the person, and the grant's own list only narrows: a program the sandbox did not name
// is refused outright. For a value the sandbox sent, the grant's list and `anyField` are the only guard and a miss is a
// refusal: the sandbox asked its own person before sending it, and nobody here can widen its word.
export const typingDecision = (typing: TypingCase): TypingVerdict =>
    typing.rules === undefined ? sentValueDecision(typing.target, typing.focus) : entryDecision(typing.target, typing.focus, typing.rules);

// One target's terms, the same for a window and a phone: the list the grant names, how a focus is matched against a
// list, and the word for what is on it.
interface TargetTerms {
    readonly theirs: readonly string[];
    // The grant's `anyField`; a phone target carries none, and a password field is what it may then go to.
    readonly anyField: boolean | undefined;
    readonly matches: (list: readonly string[]) => boolean;
    readonly what: string;
}

const termsOf = (target: TypeTarget, focus: Focus): TargetTerms =>
    target.kind === "window"
        ? { theirs: target.programs, anyField: target.anyField, matches: (list) => programMatches(list, focus), what: "program" }
        : { theirs: target.packages, anyField: undefined, matches: (list) => list.includes(focus.program), what: "app" };

const sentValueDecision = (target: TypeTarget, focus: Focus): TypingVerdict => {
    const terms = termsOf(target, focus);
    if (!terms.matches(terms.theirs)) {
        const named = terms.theirs.length > 0;
        return guard(named ? `${focus.program} is not one of the ${terms.what}s the sandbox named for this value.` : `The sandbox named no ${terms.what} this value may be typed into.`);
    }
    const passwordOnly = terms.anyField !== true;
    return passwordOnly && focus.field !== "password" ? guard(`The sandbox allows this value in a password field only, and ${fieldReason(focus)}.`) : { verdict: "type" };
};

const entryDecision = (target: TypeTarget, focus: Focus, rules: EntryRules): TypingVerdict => {
    const terms = termsOf(target, focus);
    const narrowedAway = terms.theirs.length > 0 && !terms.matches(terms.theirs);
    if (narrowedAway) {
        return guard(`${focus.program} is not one of the ${terms.what}s the sandbox asked to type into.`);
    }
    const ours = target.kind === "window" ? rules.programs : rules.packages;
    const reasons: string[] = [];
    if (ours.length === 0) {
        reasons.push(`the entry names no ${terms.what} it may be typed into`);
    } else if (!terms.matches(ours)) {
        reasons.push(`${focus.program} is not on the entry's list`);
    }
    const anyField = rules.anyField && terms.anyField !== false;
    const fieldMisses = rules.kind === "password" && !anyField && focus.field !== "password";
    if (fieldMisses) {
        reasons.push(fieldReason(focus));
    }
    return reasons.length === 0 ? { verdict: "type" } : { verdict: "ask", reasons };
};

// ---- edits ----

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const added = (before: readonly string[], after: readonly string[] | undefined, same: (a: string, b: string) => boolean): string[] =>
    (after ?? []).filter((item) => !before.some((had) => same(had, item)));

// What an edit widens, each in words for the prompt; empty for an edit that only narrows (or changes nothing an entry
// allows). Widening asks the person; narrowing does not, since it can only make the keyring say no more often.
export const wideningOf = (before: EntryRules, patch: EntryPatch, newValue: boolean): string[] => {
    const reasons: string[] = [];
    const list = (label: string, items: string[]): void => {
        if (items.length > 0) {
            reasons.push(`adds ${label} ${items.join(", ")}`);
        }
    };
    list("programs", added(before.programs, patch.programs, sameText));
    list("Android apps", added(before.packages, patch.packages, (a, b) => a === b));
    list("sites", added(before.hosts, patch.hosts, sameText));
    list("askpass prompts", added(before.askpass, patch.askpass, (a, b) => a === b));
    if (patch.anyField === true && !before.anyField) {
        reasons.push("lets it be typed into any field, not only password fields");
    }
    if (patch.kind === "text" && before.kind === "password") {
        reasons.push("makes it text, typed into any field");
    }
    if (patch.askpassRememberMinutes !== undefined && patch.askpassRememberMinutes > before.askpassRememberMinutes) {
        reasons.push(`remembers an askpass answer for ${String(patch.askpassRememberMinutes)} minutes`);
    }
    if (newValue) {
        reasons.push("gives it a new value");
    }
    return reasons;
};

// The rules as applyPatch builds them, the two optional fields set only when present.
type WritableRules = { -readonly [K in keyof EntryRules]: EntryRules[K] };

export const applyPatch = (before: EntryRules, patch: EntryPatch): EntryRules => {
    const after: WritableRules = {
        kind: patch.kind ?? before.kind,
        programs: patch.programs ?? before.programs,
        packages: patch.packages ?? before.packages,
        hosts: patch.hosts ?? before.hosts,
        anyField: patch.anyField ?? before.anyField,
        askpass: patch.askpass ?? before.askpass,
        askpassRememberMinutes: patch.askpassRememberMinutes ?? before.askpassRememberMinutes,
    };
    const username = patch.username ?? before.username;
    if (username !== undefined) {
        after.username = username;
    }
    const note = patch.note ?? before.note;
    if (note !== undefined) {
        after.note = note;
    }
    return after;
};

// ---- time ----

export const MINUTE_MS = 60_000;

export const isUnlocked = (unlockedUntil: number | undefined, now: number): boolean => unlockedUntil !== undefined && now < unlockedUntil;

// Whether an askpass answer given at `answeredAt` still stands for an entry that remembers answers for `minutes`.
export const rememberedFresh = (answeredAt: number | undefined, minutes: number, now: number): boolean =>
    minutes > 0 && answeredAt !== undefined && now - answeredAt < minutes * MINUTE_MS;
