import { entriesFor, gitOrigin, titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { type Answer, NOT_SET_UP, refuse, type VaultAccess } from "../passwords/access.js";
import type { Captures } from "../passwords/capture.js";
import { candidateOf, DEFAULT_SETTINGS, entryInfoOf, liveEntries, settingsOf, titleOf, usedEntry, withEntry } from "../passwords/entries.js";
import { hostOf, rememberedFresh } from "../policy.js";
import type { ValueNotice } from "../consent/consent.js";
import type { EntryInfo } from "../protocol.js";
import { askpassMatch, askpassPlace, normalMatcher, parseAskpassPrompt, type AskpassQuestion } from "./askpass.js";

// ANSWERING ssh, sudo AND git: intentic-askpass's prompt and git's credential helper. An entry whose matcher fits answers
// at the person's yes (or unasked for the minutes it remembers answers). A prompt nothing answers opens the keyring's
// own box ("ssh asks for radar@build-01's password"): the value typed there answers the program and, with Remember left
// ticked, is kept. A program that asks again within a minute of an answer is taken to have been answered wrongly: the
// box opens instead, and what is typed replaces the value that failed. One that does not ask again proves it.

const AGAIN_MS = 60_000;

interface Answered {
    readonly at: number;
    readonly name?: string | undefined;
}

// A user name typed into the box for git's `Username for` prompt, kept a minute with the password typed beside it for
// the `Password for` prompt git asks next.
interface Typed {
    readonly at: number;
    readonly value: string;
    readonly username: string | undefined;
    readonly remember: boolean;
}

// What the type-once box says for one prompt: who asks, for what, and whether this is a second try. Pure.
const boxNotice = ({ question, place, asker, again, remember, knownUser }: {
    readonly question: AskpassQuestion;
    readonly place: ReturnType<typeof askpassPlace>;
    readonly asker: string;
    readonly again: boolean;
    readonly remember: boolean;
    readonly knownUser: string | undefined;
}): ValueNotice => {
    const where = titleForOrigin(place.origin).replace(/^(ssh|git|sudo) /u, "");
    const wantsUser = question.wants === "username";
    return {
        title: wantsUser ? `${asker} asks who you sign in to ${where} as` : `${asker} asks for ${where}'s password`,
        message: again ? `${asker} asked again: the password it was given did not work. Type the right one once.` : `"${question.prompt}" Type it once: Passwords answers ${asker} with it.`,
        remember,
        // git signs in with an account: asked for beside the password, prefilled when the prompt named it.
        username: wantsUser || place.origin.kind === "git" ? { value: place.username ?? knownUser } : undefined,
    };
};

export class Askpass {
    // askpass answers given, by matcher, for entries that remember them.
    readonly #remembered = new Map<string, number>();
    // The last answer each prompt got, to tell a wrong one by the program asking again.
    readonly #answered = new Map<string, Answered>();
    readonly #typed = new Map<string, Typed>();

    constructor(
        private readonly vault: VaultAccess,
        private readonly captures: Captures,
    ) {}

    forget(): void {
        this.#remembered.clear();
        this.#typed.clear();
    }

    #shown(): EntryInfo[] {
        const held = this.vault.held();
        return held === undefined ? (this.vault.file()?.open.entries ?? []) : liveEntries(held.doc).map(entryInfoOf);
    }

    // Answers a minute old that were not asked for again worked: their entries are no longer unverified.
    async #settle(now: number): Promise<void> {
        const held = this.vault.held();
        let doc = held?.doc;
        for (const [key, answered] of this.#answered) {
            if (now - answered.at < AGAIN_MS) {
                continue;
            }
            this.#answered.delete(key);
            const entry = answered.name === undefined ? undefined : doc?.entries[answered.name];
            if (doc !== undefined && entry?.unverified === true) {
                doc = withEntry(doc, usedEntry(entry, answered.at));
            }
        }
        if (held !== undefined && doc !== undefined && doc !== held.doc) {
            await this.vault.commit({ doc, key: held.key });
        }
    }

    async askpass(prompt: string, parent: string | undefined): Answer<"askpass"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const now = this.vault.deps.now();
        await this.#settle(now);
        const question = parseAskpassPrompt(prompt);
        const key = normalMatcher(question.matchers[0] ?? `prompt:${question.prompt}`);
        const last = this.#answered.get(key);
        this.#answered.delete(key);
        const shown = file.open.entries.find((entry) => askpassMatch(question, entry.askpass) !== undefined);
        // Asked again within the minute for what the box answered, or for a capture not yet proved: that answer failed.
        // An entry that has worked before is only being used again (three sudo commands in a row).
        const doubtful = last !== undefined && (last.name === undefined || this.#shown().find((entry) => entry.name === last.name)?.unverified === true);
        const again = question.wants === "secret" && last !== undefined && now - last.at < AGAIN_MS && doubtful;
        const typed = this.#typed.get(key);
        if (question.wants === "secret" && typed !== undefined && now - typed.at < AGAIN_MS) {
            this.#typed.delete(key);
            return await this.#answerTyped(question, prompt, parent, typed, again);
        }
        if (shown === undefined || again) {
            return await this.#box(question, prompt, parent, again, shown?.username);
        }
        return await this.#answerWith(shown, question, parent, key);
    }

    async #answerWith(shown: EntryInfo, question: AskpassQuestion, parent: string | undefined, key: string): Answer<"askpass"> {
        const file = this.vault.file();
        const matcher = askpassMatch(question, shown.askpass);
        if (file === undefined || matcher === undefined) {
            return refuse("unknown", `No password answers "${question.prompt}".`);
        }
        if (question.wants === "username") {
            return shown.username === undefined ? refuse("unknown", `${shown.name} has no user name to answer with.`) : { ok: true, value: shown.username };
        }
        const now = this.vault.deps.now();
        const remembered = this.vault.held() !== undefined && rememberedFresh(this.#remembered.get(matcher), shown.askpassRememberMinutes, now);
        const asker = parent ?? "A program";
        const opened = await this.vault.open(file, { title: `Answer ${asker}'s prompt?`, message: `${asker} asks: "${question.prompt}". Passwords answers with ${titleOf(shown)}.`, person: !remembered });
        if ("ok" in opened) {
            await this.vault.record({ op: "askpass", outcome: "refused", code: opened.code, secret: shown.name, target: matcher });
            return opened;
        }
        const entry = opened.doc.entries[shown.name];
        if (entry === undefined || entry.deleted === true || askpassMatch(question, entry.rules.askpass) === undefined) {
            return refuse("unknown", `No password answers "${question.prompt}".`);
        }
        const value = await this.vault.valueOf(opened.doc, entry);
        if (!value.ok) {
            return value;
        }
        if (entry.rules.askpassRememberMinutes > 0) {
            this.#remembered.set(matcher, now);
        }
        this.#answered.set(key, { at: now, name: entry.name });
        await this.vault.record({ op: "askpass", outcome: "granted", secret: entry.name, target: matcher, asked: opened.asked, program: parent });
        return { ok: true, value: value.value };
    }

    // Nothing answers it, or what answered last did not work: the person types it once into the keyring's own box.
    async #box(question: AskpassQuestion, prompt: string, parent: string | undefined, again: boolean, knownUser: string | undefined): Answer<"askpass"> {
        const box = this.vault.deps.consent.askValue;
        if (box === undefined) {
            return refuse("unknown", `No password answers "${question.prompt}": \`intentic-machine keyring edit NAME --askpass ${question.matchers[0] ?? "prompt:…"}\` adds one.`);
        }
        const place = askpassPlace(question, prompt);
        const held = this.vault.held();
        const remember = (held === undefined ? (this.vault.file()?.open.settings ?? DEFAULT_SETTINGS) : settingsOf(held.doc)).remember.terminal;
        const wantsUser = question.wants === "username";
        const answer = await box(boxNotice({ question, place, asker: parent ?? programOf(place.origin), again, remember, knownUser }));
        if (answer.kind !== "answered") {
            await this.vault.record({ op: "askpass", outcome: "refused", code: answer.kind === "cancelled" ? "declined" : "unavailable", target: question.matchers[0] });
            return answer.kind === "cancelled" ? refuse("declined", "The person at the computer closed the box.") : refuse("unavailable", answer.reason);
        }
        const typed: Typed = { at: this.vault.deps.now(), value: answer.value, username: answer.username ?? place.username, remember: answer.remember };
        if (wantsUser) {
            // git asks for the password next, in a prompt of its own: answered from what was typed here.
            this.#typed.set(normalMatcher(question.matchers[0] ?? ""), typed);
            return typed.username === undefined ? refuse("unknown", "No user name was typed.") : { ok: true, value: typed.username };
        }
        return await this.#answerTyped(question, prompt, parent, typed, again);
    }

    async #answerTyped(question: AskpassQuestion, prompt: string, parent: string | undefined, typed: Typed, again: boolean): Answer<"askpass"> {
        const place = askpassPlace(question, prompt);
        const now = this.vault.deps.now();
        let name: string | undefined;
        if (typed.remember) {
            const draft = { origin: place.origin, username: typed.username ?? place.username, source: "askpass", via: parent ?? programOf(place.origin), kind: "password", at: now } as const;
            const kept = await this.captures.keep(again ? { ...draft, failed: true } : draft, typed.value, true);
            name = kept.name;
        }
        this.#answered.set(normalMatcher(question.matchers[0] ?? `prompt:${question.prompt}`), { at: now, name });
        await this.vault.record({ op: "askpass", outcome: "granted", secret: name, target: question.matchers[0], asked: true, how: "box", program: parent });
        return { ok: true, value: typed.value };
    }

    // ---- git's credential helper ----

    async gitCredential(action: "get" | "erase", url: string, username: string | undefined): Answer<"git-credential"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const origin: KeyringOrigin = { kind: "git", url: gitOrigin(url) };
        const match = entriesFor(this.#shown().map(candidateOf), origin, username).find((candidate) => username === undefined || candidate.username === undefined || candidate.username === username);
        if (match === undefined) {
            // Nothing here: git asks its next helper, or the prompt that reaches the keyring's box.
            return { ok: true };
        }
        return action === "get" ? await this.#gitGet(match.name, origin) : await this.#gitErase(match.name);
    }

    async #gitGet(name: string, origin: KeyringOrigin): Answer<"git-credential"> {
        const file = this.vault.file();
        const shown = this.#shown().find((entry) => entry.name === name);
        if (file === undefined || shown === undefined) {
            return { ok: true };
        }
        const now = this.vault.deps.now();
        const key = `git-credential:${normalMatcher(`git:${origin.kind === "git" ? origin.url : ""}`)}`;
        const remembered = this.vault.held() !== undefined && rememberedFresh(this.#remembered.get(key), shown.askpassRememberMinutes, now);
        const host = origin.kind === "git" ? hostOf(origin.url) : "";
        const opened = await this.vault.open(file, { title: `Sign git in to ${host}?`, message: `git asks for its sign-in to ${host}. Passwords answers with ${titleOf(shown)}${shown.username === undefined ? "" : ` (${shown.username})`}.`, person: !remembered });
        if ("ok" in opened) {
            await this.vault.record({ op: "git-credential", outcome: "refused", code: opened.code, secret: name, target: host });
            return opened;
        }
        const entry = opened.doc.entries[name];
        const value = entry === undefined || entry.deleted === true ? refuse("unknown", `There is no password named ${name}.`) : await this.vault.valueOf(opened.doc, entry);
        if (!value.ok) {
            return value;
        }
        if (shown.askpassRememberMinutes > 0) {
            this.#remembered.set(key, now);
        }
        await this.vault.record({ op: "git-credential", outcome: "granted", secret: name, target: host, asked: opened.asked });
        const answer: Extract<Awaited<Answer<"git-credential">>, { ok: true }> = { ok: true, value: value.value };
        if (entry?.rules.username !== undefined) {
            answer.username = entry.rules.username;
        }
        return answer;
    }

    // git says the value did not work. While unlocked: a capture not yet proved is taken back (its earlier value put back,
    // or the entry removed when it had none), and a proved one is marked so the next capture replaces it. Locked, there
    // is nothing to write it into without asking, and git's own prompt follows anyway.
    async #gitErase(name: string): Answer<"git-credential"> {
        const held = this.vault.held();
        const entry = held?.doc.entries[name];
        if (held === undefined || entry === undefined) {
            return { ok: true };
        }
        const now = this.vault.deps.now();
        const revision = held.doc.revision + 1;
        const [earlier, ...older] = entry.history ?? [];
        const erased =
            entry.unverified !== true
                ? { ...entry, failed: true, updatedAt: now, revision }
                : earlier === undefined
                  ? { name, rules: entry.rules, source: entry.source, shares: [], createdAt: entry.createdAt, updatedAt: now, revision, deleted: true }
                  : { ...entry, value: earlier.value, history: older, updatedAt: now, revision, unverified: false };
        await this.vault.commit({ doc: withEntry(held.doc, erased), key: held.key });
        await this.vault.record({ op: "git-credential", outcome: "done", secret: name, target: "erase" });
        return { ok: true };
    }
}

const programOf = (origin: KeyringOrigin): string => (origin.kind === "ssh" || origin.kind === "ssh-key" ? "ssh" : origin.kind === "sudo" ? "sudo" : origin.kind === "git" ? "git" : "A program");
