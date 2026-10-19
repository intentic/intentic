import { entriesFor, entryNameFor, titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { type Answer, NOT_SET_UP, refuse, type VaultAccess } from "./access.js";
import type { Captures } from "./capture.js";
import { candidateOf, DEFAULT_SETTINGS, entryInfoOf, liveEntries, settingsOf, titleOf, usedEntry, withEntry } from "./entries.js";
import { typingDecision, type TypeTarget } from "../policy.js";
import type { EntryInfo } from "../protocol.js";
import type { Place, Seen } from "../typing/typist.js";

// FILL WITH INTENTIC, in a program on this computer: the session helper's chip beside a focused password field, or the
// app's Fill. The entry for the focused program is typed at the person's verified yes, through the same window and field
// checks as a sandbox's typing. Nothing saved for it: the keyring's own box asks for the value once, types it, and keeps
// it when Remember is left ticked. The keyring never watches keys: the person types into its box, not the program.

const PLACE: Place = { kind: "window" };
// The person asked for this fill: no list of the sandbox's narrows it.
const OWN_TARGET: TypeTarget = { kind: "window", programs: [], anyField: false };

export class Fills {
    constructor(
        private readonly vault: VaultAccess,
        private readonly captures: Captures,
    ) {}

    #shown(): EntryInfo[] {
        const held = this.vault.held();
        return held === undefined ? (this.vault.file()?.open.entries ?? []) : liveEntries(held.doc).map(entryInfoOf);
    }

    async fillWindow(name: string | undefined): Answer<"fill-window"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const looked = await this.vault.deps.typist.inspect(PLACE);
        if (!looked.ok) {
            return refuse("unavailable", looked.reason);
        }
        const program: KeyringOrigin = { kind: "program", program: looked.seen.focus.program === "" ? "unknown" : looked.seen.focus.program };
        const shown = name === undefined ? entriesFor(this.#shown().map(candidateOf), program)[0] : this.#shown().find((entry) => entry.name === name);
        const entry = shown === undefined ? undefined : this.#shown().find((candidate) => candidate.name === shown.name);
        return entry === undefined ? await this.#typeOnce(looked.seen, program) : await this.#fillWith(entry, looked.seen);
    }

    async #fillWith(shown: EntryInfo, seen: Seen): Answer<"fill-window"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const first = typingDecision({ target: OWN_TARGET, focus: seen.focus, rules: shown });
        if (first.verdict === "refuse") {
            return refuse(first.code, first.reason);
        }
        const reasons = first.verdict === "ask" ? ` Note: ${first.reasons.join(" and ")}.` : "";
        const opened = await this.vault.open(file, { title: `Fill ${titleOf(shown)} into ${seen.focus.program}?`, message: `Passwords types ${titleOf(shown)} into ${seen.focus.program}.${reasons}`, person: true });
        if ("ok" in opened) {
            return opened;
        }
        const entry = opened.doc.entries[shown.name];
        if (entry === undefined || entry.deleted === true) {
            return refuse("unknown", `There is no password named ${shown.name}.`);
        }
        const value = await this.vault.valueOf(opened.doc, entry);
        if (!value.ok) {
            return value;
        }
        const typed = await this.vault.typeInto(PLACE, seen, value.value, true);
        await this.vault.record({ op: "fill", outcome: typed.ok ? "granted" : "refused", secret: entry.name, program: seen.focus.program, asked: true, how: opened.how });
        if (!typed.ok) {
            return typed;
        }
        await this.vault.commit({ doc: withEntry(opened.doc, usedEntry(entry, this.vault.deps.now())), key: opened.key });
        return { ok: true, name: entry.name, program: typed.program, saved: false };
    }

    async #typeOnce(seen: Seen, program: KeyringOrigin): Answer<"fill-window"> {
        const box = this.vault.deps.consent.askValue;
        if (box === undefined) {
            return refuse("unavailable", "Nothing is saved for this program, and this computer cannot show Passwords' own box to type it once.");
        }
        const held = this.vault.held();
        const remember = (held === undefined ? (this.vault.file()?.open.settings ?? DEFAULT_SETTINGS) : settingsOf(held.doc)).remember.apps;
        const place = titleForOrigin(program);
        const answer = await box({ title: `Save a password for ${place}`, message: `Type the password for ${place} once. Passwords types it there for you.`, remember });
        if (answer.kind === "cancelled") {
            return refuse("declined", "The person at the computer closed the box.");
        }
        if (answer.kind === "unavailable") {
            return refuse("unavailable", answer.reason);
        }
        // The box had the keyboard: the program must have it back before anything is typed.
        const typed = await this.vault.typeInto(PLACE, seen, answer.value, true);
        if (!typed.ok) {
            return typed;
        }
        const now = this.vault.deps.now();
        const kept = answer.remember ? await this.captures.keep({ origin: program, username: answer.username, source: "app", via: seen.focus.program, kind: "password", at: now }, answer.value, true) : undefined;
        await this.vault.record({ op: "fill", outcome: "granted", secret: kept?.name, program: seen.focus.program, asked: true, how: "box" });
        return { ok: true, name: kept?.name ?? entryNameFor(place, answer.username, () => false), program: typed.program, saved: kept !== undefined && kept.outcome !== "skipped" };
    }
}
