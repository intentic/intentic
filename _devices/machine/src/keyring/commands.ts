import { plural } from "@intentic/base/format";
import { askKeyring, type EntryInfo, type KeyringClientOptions, keyringPaths, KeyringUnavailable, sealForKeyring } from "@intentic/keyring";
import type { AutostartKind, Item, Ui } from "@intentic/local-agent";
import { civilDayIn, localZone } from "@intentic/sandbox-contract/time/zone";
import type { KeyringShareMode, KeyringState, SealedBox } from "@intentic/sandbox-contract/schemas/keyring";
import { buildChoiceParser, buildRouteMap, type CommandContext, numberParser } from "@stricli/core";
import { buildCommand } from "../cli-ui.js";
import { readLinks } from "../device/config.js";
import { MACHINE_VERSION } from "../version.js";
import { keyringAnswer } from "./answer.js";
import { askpassStatus, installAskpass, uninstallAskpass, type AskpassInstalled } from "./askpass.js";
import {
    type AddFlags,
    addPlan,
    backendConfig,
    type BackendFlags,
    type BackendName,
    editPatch,
    type EditFlags,
    editTakesValue,
    entryName,
    KeyringCliError,
    shareTarget,
    unshareTarget,
} from "./flags.js";
import { readConfirmed, readStdin } from "./secret-input.js";
import { type AskpassAnswer, clock, keyringLine, keyringStatusLine, readAskpassAnswer, readKeyringStatus } from "./keyring-status.js";
import { hardenKeyring, installKeyring, keyringState, startKeyring, uninstallKeyring, upgradeKeyring } from "./service.js";

/* `intentic-machine keyring …`: intentic-keyring on this computer, set up, kept and asked from a terminal, and from the
   desktop app, which runs these with --json (answer.ts). A value or a passphrase is never an argument: it is typed with
   echo off, or piped on stdin with --stdin, and a value is sealed to the vault's inbox key before it reaches the pipe, so
   whatever holds the pipe holds ciphertext. The keyring itself asks the person (Windows Hello, its passphrase) before
   anything here changes the vault. */

// The keyring's pipe, read at each call rather than at load: HOME is what names it, and a test moves HOME.
const pipe = (): KeyringClientOptions => ({ address: keyringPaths().address });

const json = { kind: "boolean", brief: "Print one JSON line, `ok` first (what the desktop app reads)", default: false } as const;

const NAME = { brief: "The entry's name, as `{{secret:NAME}}` spells it", parse: String, placeholder: "NAME" } as const;

interface JsonFlags {
    readonly json: boolean;
}

// The terminal handed to a hidden prompt: the live line stops repainting over it while the person types.
const prompted = async <T>(ui: Ui, read: () => Promise<T>): Promise<T> => {
    ui.suspend();
    try {
        return await read();
    } finally {
        ui.resume();
    }
};

// What every value sent in is sealed to: the vault's inbox key, which the keyring says in its state.
const inboxKey = async (): Promise<string> => {
    const state = await askKeyring(pipe(), { op: "state" });
    if (!state.ok) {
        throw new KeyringCliError(state.code, state.refusal);
    }
    // Before setup there is no vault, so no inbox key to seal to.
    if (!state.setUp || state.state.keys === undefined) {
        throw new KeyringCliError("no-keyring", "The keyring is not set up yet: set it up first with `intentic-machine keyring setup`.");
    }
    return state.state.keys.inbox;
};

// A value read the way the flags say, and sealed at once: the plain value lives only in this function.
const sealedValue = async (ui: Ui, name: string, from: "stdin" | "terminal", what: string): Promise<SealedBox> => {
    const key = await inboxKey();
    const value = from === "stdin" ? await readStdin() : await prompted(ui, async () => await readConfirmed(what));
    return sealForKeyring(key, name, value);
};

// ---- setup ----

interface SetupFlags extends JsonFlags {
    readonly passphraseStdin: boolean;
    readonly hello: boolean;
}

// The passphrase the keyring is set up with: its own rule is ten characters at least, said here before it is sent.
const PASSPHRASE_MIN = 10;

const choosePassphrase = async (ui: Ui, fromStdin: boolean): Promise<string> => {
    if (!fromStdin) {
        ui.note(`Choose the keyring's passphrase: ${PASSPHRASE_MIN} characters or more. It opens the vault where Windows Hello cannot, and nothing can recover it.`);
    }
    const passphrase = fromStdin ? await readStdin() : await prompted(ui, async () => await readConfirmed("Passphrase"));
    if (passphrase.length < PASSPHRASE_MIN) {
        throw new KeyringCliError("usage", `The passphrase is shorter than ${PASSPHRASE_MIN} characters: choose a longer one.`);
    }
    return passphrase;
};

interface SetupAnswer {
    readonly ok: true;
    readonly path: string;
    readonly askpass: AskpassAnswer;
    readonly autostart: AutostartKind;
    readonly setUp: true;
    readonly alreadySetUp: boolean;
    readonly state?: KeyringState;
}

const setup = buildCommand<SetupFlags>({
    docs: { brief: "Install the keyring beside this agent, start it at login, and set up its vault" },
    parameters: {
        flags: {
            passphraseStdin: { kind: "boolean", brief: "Read the passphrase once from stdin instead of twice from the terminal", default: false },
            hello: { kind: "boolean", brief: "Also unlock with Windows Hello where this computer has it (--no-hello: the passphrase alone)", default: true },
            json,
        },
    },
    async func(this: CommandContext, flags: SetupFlags) {
        await keyringAnswer<SetupAnswer>(
            this,
            flags.json,
            { doing: "Setting up the keyring", failed: "The keyring was not set up." },
            async (ui) => {
                const installed = await installKeyring(MACHINE_VERSION, ui.note);
                const started = await startKeyring(ui.note);
                if (!started.state.ok) {
                    return started.state;
                }
                const base = { ok: true, path: installed.path, autostart: started.autostart, setUp: true } as const;
                if (started.state.setUp) {
                    return { ...base, alreadySetUp: true, askpass: await readAskpassAnswer(), state: started.state.state };
                }
                const passphrase = await choosePassphrase(ui, flags.passphraseStdin);
                const done = await askKeyring(pipe(), { op: "setup", passphrase, hello: flags.hello && process.platform === "win32" });
                if (!done.ok) {
                    return done;
                }
                const after = await keyringState();
                const state = after instanceof KeyringUnavailable || !after.ok ? undefined : after.state;
                const answer: SetupAnswer = { ...base, alreadySetUp: false, askpass: await readAskpassAnswer() };
                return state === undefined ? answer : { ...answer, state };
            },
            (result, ui) => {
                ui.done(result.alreadySetUp ? `The keyring was set up already, and is running from ${result.path}.` : `Set up the keyring at ${result.path}; it starts at every sign-in.`);
                ui.later([
                    ["keep a password in it", "intentic-machine keyring add NAME"],
                    ...(result.askpass.installed ? [] : ([["let ssh, sudo and git ask it", "intentic-machine keyring askpass install"]] as const)),
                ]);
            },
        );
    },
});

// ---- status ----

const status = buildCommand<JsonFlags>({
    docs: { brief: "Whether the keyring is installed, running, set up and unlocked, and whether ssh, sudo and git ask it" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(this, flags.json, { failed: "The keyring's status could not be read." }, readKeyringStatus, (result, ui) => {
            ui.report("intentic · keyring");
            ui.items([keyringLine(keyringStatusLine(result)), { tone: result.askpass.installed ? "ok" : "skip", name: "askpass", meta: result.askpass.installed ? "ssh, sudo -A and git ask the keyring" : "not set for ssh, sudo and git" }]);
            ui.fields([
                ["vault", keyringPaths().dir],
                ["log", keyringPaths().log],
                ...(result.askpass.path === undefined ? [] : ([["askpass", result.askpass.path]] as const)),
                ...(result.state === undefined ? [] : ([["pending", plural(result.state.pendingInbox, "value")]] as const)),
            ]);
        });
    },
});

// ---- unlock, lock ----

interface UnlockFlags extends JsonFlags {
    readonly minutes?: number;
}

const unlock = buildCommand<UnlockFlags>({
    docs: { brief: "Unlock the vault for a while: `while-here` entries answer their sandboxes unasked until then" },
    parameters: { flags: { minutes: { kind: "parsed", parse: numberParser, optional: true, brief: "For how long, 1 to 720 (default 60)" }, json } },
    async func(this: CommandContext, flags: UnlockFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Unlocking the keyring (it asks you)", failed: "The keyring was not unlocked." },
            async () => await askKeyring(pipe(), { op: "unlock", minutes: flags.minutes ?? 60 }),
            (result, ui) => ui.done(`Unlocked the keyring until ${clock(result.unlockedUntil)}.`),
        );
    },
});

const lock = buildCommand<JsonFlags>({
    docs: { brief: "Lock the vault now: every entry asks again before it answers" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Locking the keyring", failed: "The keyring was not locked." },
            async () => await askKeyring(pipe(), { op: "lock" }),
            (_result, ui) => ui.done("Locked the keyring."),
        );
    },
});

// ---- list ----

// What `list` says beside an entry whose askpass answer is remembered, in so many words: it is the weak spot.
export const REMEMBERED_WARNING = "a remembered answer can be collected by any program of yours while it lasts, the agent's commands included";

const shareWords = (entry: EntryInfo): string =>
    entry.shares.length === 0 ? "shared with no sandbox" : entry.shares.map((share) => `${URL.parse(share.sandbox)?.host ?? share.sandbox} (${share.mode})`).join(", ");

/** One entry's row in `keyring list`. Pure. */
export const entryItem = (entry: EntryInfo): Item => ({
    tone: entry.askpassRememberMinutes > 0 ? "warn" : "ok",
    name: entry.name,
    meta: [
        entry.kind,
        entry.source === "keyring" ? undefined : `from ${entry.source}`,
        shareWords(entry),
        entry.askpassRememberMinutes > 0 ? `askpass answer remembered ${entry.askpassRememberMinutes} min: ${REMEMBERED_WARNING}` : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(" · "),
});

const list = buildCommand<JsonFlags>({
    docs: { brief: "List the keyring's entries: names, rules and shares, never values" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { failed: "The keyring's entries could not be listed." },
            async () => await askKeyring(pipe(), { op: "list" }),
            (result, ui) => {
                ui.report("intentic · keyring entries", result.backends.length === 0 ? undefined : `reads from ${result.backends.join(", ")}`);
                if (result.entries.length === 0) {
                    ui.quiet("The keyring holds no entries yet.");
                    ui.later([["keep a password in it", "intentic-machine keyring add NAME"]]);
                    return;
                }
                ui.items(result.entries.map(entryItem));
            },
        );
    },
});

// ---- add, edit, remove ----

const ruleFlags = {
    kind: { kind: "enum", values: ["password", "text"], optional: true, brief: "A password (typed only into a password field) or text (default password)" },
    program: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "A program it may be typed into without asking, by file name or path (repeatable)" },
    package: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "An Android app it may be typed into, by package name (repeatable)" },
    host: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "A site it may go to, exact or *.domain (repeatable)" },
    username: { kind: "parsed", parse: String, optional: true, brief: "The user name that goes with it, for an askpass `Username for` prompt" },
    askpass: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "An askpass prompt it answers: ssh:user@host, ssh-key:/path, sudo, git:https://host, prompt:<text> (repeatable)" },
    rememberMinutes: { kind: "parsed", parse: numberParser, optional: true, brief: "Minutes an askpass answer is remembered without asking again (default 0: ask every time)" },
} as const;

const add = buildCommand<AddFlags, [string]>({
    docs: { brief: "Keep a new entry: a value typed now (or piped with --stdin), or one read from a password manager at each use" },
    parameters: {
        positional: { kind: "tuple", parameters: [NAME] },
        flags: {
            stdin: { kind: "boolean", brief: "Read the value from stdin (one trailing newline is dropped)", default: false },
            ...ruleFlags,
            anyField: { kind: "boolean", brief: "May be typed into a field the program does not mark as a password field", default: false },
            backend: { kind: "enum", values: ["1password", "bitwarden", "keepassxc"], optional: true, brief: "Read the value from this password manager at each use, instead of keeping it" },
            ref: { kind: "parsed", parse: String, optional: true, brief: "With --backend: op://Vault/Item/field, a Bitwarden item, or a KeePassXC Group/Entry" },
            field: { kind: "parsed", parse: String, optional: true, brief: "With --backend bitwarden: password, username, totp or notes" },
            attribute: { kind: "parsed", parse: String, optional: true, brief: "With --backend keepassxc: the attribute to read (default Password)" },
            replace: { kind: "boolean", brief: "Replace an entry of the same name", default: false },
            json,
        },
    },
    async func(this: CommandContext, flags: AddFlags, name: string) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Adding ${name} to the keyring (it asks you)`, failed: `${name} was not added.` },
            async (ui) => {
                const plan = addPlan(name, flags);
                const sealed = plan.needsValue ? await sealedValue(ui, plan.name, flags.stdin ? "stdin" : "terminal", `The value of ${plan.name}`) : undefined;
                const answer = await askKeyring(pipe(), { op: "add", name: plan.name, sealed, backend: plan.backend, rules: plan.rules, replace: plan.replace });
                return answer.ok ? { ok: true as const, name: plan.name } : answer;
            },
            (result, ui) => {
                ui.done(`Added ${result.name} to the keyring.`);
                ui.later([["share it with a sandbox", `intentic-machine keyring share ${result.name} --sandbox URL --mode each-use`]]);
            },
        );
    },
});

const edit = buildCommand<EditFlags, [string]>({
    docs: { brief: "Change an entry's rules (a list flag replaces the whole list; --program \"\" empties it), or its value: alone, it asks for a new one" },
    parameters: {
        positional: { kind: "tuple", parameters: [NAME] },
        flags: {
            stdin: { kind: "boolean", brief: "Read a new value from stdin (one trailing newline is dropped)", default: false },
            ...ruleFlags,
            anyField: { kind: "enum", values: ["on", "off"], optional: true, brief: "Whether it may be typed into a field not marked as a password field" },
            json,
        },
    },
    async func(this: CommandContext, flags: EditFlags, name: string) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Changing ${name} (the keyring asks you)`, failed: `${name} was not changed.` },
            async (ui) => {
                const entry = entryName(name);
                const patch = editPatch(flags);
                const takes = editTakesValue(flags, patch);
                const sealed = takes === "none" ? undefined : await sealedValue(ui, entry, takes, `The new value of ${entry}`);
                const answer = await askKeyring(pipe(), { op: "edit", name: entry, patch, sealed });
                return answer.ok ? { ok: true as const, name: entry, valueChanged: sealed !== undefined } : answer;
            },
            (result, ui) => ui.done(result.valueChanged ? `Changed the value of ${result.name}.` : `Changed the rules of ${result.name}.`),
        );
    },
});

const remove = buildCommand<JsonFlags, [string]>({
    docs: { brief: "Remove an entry, and with it every share of it" },
    parameters: { positional: { kind: "tuple", parameters: [NAME] }, flags: { json } },
    async func(this: CommandContext, flags: JsonFlags, name: string) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Removing ${name} (the keyring asks you)`, failed: `${name} was not removed.` },
            async () => {
                const entry = entryName(name);
                const answer = await askKeyring(pipe(), { op: "remove", name: entry });
                return answer.ok ? { ok: true as const, name: entry } : answer;
            },
            (result, ui) => ui.done(`Removed ${result.name} from the keyring.`),
        );
    },
});

// ---- share, unshare ----

interface ShareFlags extends JsonFlags {
    readonly sandbox?: string;
    readonly mode: KeyringShareMode;
}

const sandboxFlag = { kind: "parsed", parse: String, optional: true, brief: "The sandbox: its address, or its link's id (`intentic-machine status` lists them)" } as const;

const share = buildCommand<ShareFlags, [string]>({
    docs: { brief: "Share an entry with a sandbox linked to this computer: each-use, while-here or copy" },
    parameters: {
        positional: { kind: "tuple", parameters: [NAME] },
        flags: {
            sandbox: sandboxFlag,
            mode: {
                kind: "enum",
                values: ["each-use", "while-here", "copy"],
                brief: "each-use asks you every time; while-here answers while unlocked; copy keeps a copy in the sandbox",
            },
            json,
        },
    },
    async func(this: CommandContext, flags: ShareFlags, name: string) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Sharing ${name} (the keyring asks you)`, failed: `${name} was not shared.` },
            async () => {
                const entry = entryName(name);
                const link = shareTarget(await readLinks(), flags.sandbox);
                const answer = await askKeyring(pipe(), { op: "share", name: entry, sandbox: link.sandboxUrl, machine: link.id, mode: flags.mode });
                return answer.ok ? { ok: true as const, name: entry, sandbox: link.sandboxUrl, machine: link.id, mode: flags.mode, fingerprint: answer.fingerprint } : answer;
            },
            (result, ui) => {
                ui.note(`The sandbox's signing key is ${result.fingerprint}, as the prompt showed it.`);
                ui.done(`Shared ${result.name} with ${result.sandbox} (${result.mode}).`);
            },
        );
    },
});

interface UnshareFlags extends JsonFlags {
    readonly sandbox?: string;
}

const unshare = buildCommand<UnshareFlags, [string]>({
    docs: { brief: "Stop sharing an entry with a sandbox" },
    parameters: { positional: { kind: "tuple", parameters: [NAME] }, flags: { sandbox: sandboxFlag, json } },
    async func(this: CommandContext, flags: UnshareFlags, name: string) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Unsharing ${name}`, failed: `${name} is still shared.` },
            async () => {
                const entry = entryName(name);
                const sandbox = unshareTarget(await readLinks(), flags.sandbox);
                const answer = await askKeyring(pipe(), { op: "unshare", name: entry, sandbox });
                return answer.ok ? { ok: true as const, name: entry, sandbox } : answer;
            },
            (result, ui) => ui.done(`${result.name} is no longer shared with ${result.sandbox}.`),
        );
    },
});

// ---- backend ----

const BACKENDS: readonly BackendName[] = ["1password", "bitwarden", "keepassxc"];

const backend = buildCommand<BackendFlags, [BackendName]>({
    docs: { brief: "Tell the keyring how to reach a password manager its entries read from" },
    parameters: {
        positional: { kind: "tuple", parameters: [{ brief: "1password, bitwarden or keepassxc", parse: buildChoiceParser(BACKENDS), placeholder: "1password|bitwarden|keepassxc" }] },
        flags: {
            cli: { kind: "parsed", parse: String, optional: true, brief: "The manager's command (default op, bw or keepassxc-cli)" },
            account: { kind: "parsed", parse: String, optional: true, brief: "1password: the account to read from" },
            tokenEntry: { kind: "parsed", parse: String, optional: true, brief: "1password: the entry holding a service-account token, for reads without the app's prompt" },
            passwordEntry: { kind: "parsed", parse: String, optional: true, brief: "bitwarden, keepassxc: the entry holding the master or database password" },
            database: { kind: "parsed", parse: String, optional: true, brief: "keepassxc: the database file" },
            keyFile: { kind: "parsed", parse: String, optional: true, brief: "keepassxc: the database's key file" },
            json,
        },
    },
    async func(this: CommandContext, flags: BackendFlags, name: BackendName) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Setting up ${name} for the keyring (it asks you)`, failed: `${name} was not set up.` },
            async () => {
                const answer = await askKeyring(pipe(), { op: "backend", config: backendConfig(name, flags) });
                return answer.ok ? { ok: true as const, backend: name } : answer;
            },
            (result, ui) => ui.done(`The keyring reads entries from ${result.backend} from now on.`),
        );
    },
});

// ---- askpass ----

const askpassDrawn = (result: AskpassInstalled, ui: Ui, installed: boolean): void => {
    if (result.profile !== undefined && installed) {
        ui.note(`Written to ${result.file ?? ""}, which your next sign-in reads. A terminal's shell reads its profile instead: add these lines to it.`);
        for (const line of result.profile) {
            ui.note(line);
        }
        ui.note("sudo asks askpass only as `sudo -A`.");
    }
    if (result.profile !== undefined && !installed) {
        ui.note("Remove these lines from your shell profile, where you added them:");
        for (const line of result.profile) {
            ui.note(line);
        }
    }
    ui.done(installed ? "ssh, sudo -A and git ask the keyring for passwords from now on." : "ssh, sudo and git no longer ask the keyring.");
};

const askpassInstall = buildCommand<JsonFlags>({
    docs: { brief: "Point ssh, sudo -A and git at intentic-askpass for your user" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Pointing ssh, sudo and git at the keyring", failed: "askpass was not set up." },
            async () => ({ ok: true as const, ...(await installAskpass()) }),
            (result, ui) => askpassDrawn(result, ui, true),
        );
    },
});

const askpassUninstall = buildCommand<JsonFlags>({
    docs: { brief: "Stop ssh, sudo and git asking intentic-askpass" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Taking ssh, sudo and git off the keyring", failed: "askpass is still set." },
            async () => ({ ok: true as const, ...(await uninstallAskpass()) }),
            (result, ui) => askpassDrawn(result, ui, false),
        );
    },
});

const askpassStatusCommand = buildCommand<JsonFlags>({
    docs: { brief: "Whether ssh, sudo and git ask intentic-askpass for your user" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { failed: "askpass's status could not be read." },
            async () => ({ ok: true as const, ...(await askpassStatus()) }),
            (result, ui) => {
                ui.report("intentic · askpass");
                ui.items([{ tone: result.installed ? "ok" : "skip", name: "askpass", meta: result.installed ? "ssh, sudo -A and git ask the keyring" : "not set" }]);
                ui.fields(Object.entries(result.variables).map(([variable, value]) => [variable, value ?? ""] as const));
            },
        );
    },
});

// ---- sync ----

const syncStatus = buildCommand<JsonFlags>({
    docs: { brief: "The keyring's sync key and the keyrings on your other computers it keeps in step with" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { failed: "The keyring's sync could not be read." },
            async () => await askKeyring(pipe(), { op: "sync-state" }),
            (result, ui) => {
                ui.report("intentic · keyring sync", `revision ${result.sync.revision}`);
                ui.fields([["sync key", result.sync.key]]);
                if (result.sync.peers.length === 0) {
                    ui.quiet("Paired with no other computer's keyring.");
                    return;
                }
                ui.items(result.sync.peers.map((peer) => ({ tone: "ok", name: peer.device, meta: `paired ${civilDayIn(peer.pairedAt, localZone())}` })));
            },
        );
    },
});

// ---- upgrade, harden, uninstall ----

const upgrade = buildCommand<JsonFlags>({
    docs: { brief: "Move the keyring to this agent's release, once the running keyring has asked you" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Updating the keyring to ${MACHINE_VERSION}`, failed: "The keyring was not updated." },
            async (ui) => await upgradeKeyring(MACHINE_VERSION, ui.note),
            (result, ui) => ui.done(result.upgraded ? `Updated the keyring from ${result.from} to ${result.to}.` : `The keyring is already on ${result.to}. Nothing to do.`),
        );
    },
});

const harden = buildCommand<JsonFlags>({
    docs: { brief: "Windows: move the vault under a service of its own, out of reach of your user's processes (one UAC prompt)" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Hardening the keyring", failed: "The keyring was not hardened." },
            async (ui) => ({ ok: true as const, ...(await hardenKeyring(ui.note)) }),
            (result, ui) => ui.done(`The vault is held by the ${result.service} service now; its helper starts at every sign-in.`),
        );
    },
});

const uninstall = buildCommand<JsonFlags>({
    docs: { brief: "Remove the keyring from this computer, keeping its vault" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Removing the keyring", failed: "The keyring was not removed." },
            async (ui) => {
                // ssh, sudo and git must not be left asking a program that is gone.
                await uninstallAskpass();
                return { ok: true as const, ...(await uninstallKeyring(ui.note)) };
            },
            (result, ui) => {
                ui.note(`The vault stays in ${result.vault}${result.hardened ? " (hardened: under %ProgramData%\\Intentic\\Keyring)" : ""}: set the keyring up again and the same passphrase opens it.`);
                ui.done("Removed the keyring from this computer.");
            },
        );
    },
});

export const keyringCommands = {
    setup,
    status,
    unlock,
    lock,
    list,
    add,
    edit,
    remove,
    share,
    unshare,
    backend,
    askpass: buildRouteMap({
        routes: { install: askpassInstall, uninstall: askpassUninstall, status: askpassStatusCommand },
        docs: { brief: "Let ssh, sudo and git ask the keyring for passwords" },
    }),
    sync: buildRouteMap({ routes: { status: syncStatus }, docs: { brief: "The keyring's sync with your other computers" } }),
    upgrade,
    harden,
    uninstall,
};
