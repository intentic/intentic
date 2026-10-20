import { existsSync } from "node:fs";
import { askKeyring, type EntryPatch, KeyringSettingsPatchSchema, type KeyringClientOptions, keyringPaths, type KeyringRequest, sealForKeyring } from "@intentic/keyring";
import { seal } from "@intentic/sandbox-contract/keyring-seal";
import { mergeRules, type OriginRules, rulesForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import { KEYRING_CAPTURE_BATCH_MAX, type KeyringCaptureItem, KeyringNeedAnswerSchema, KeyringOriginSchema, KeyringSecretNameSchema, type SealedBox } from "@intentic/sandbox-contract/schemas/keyring";
import { buildRouteMap, type CommandContext } from "@stricli/core";
import { z } from "zod";
import { buildCommand } from "../cli-ui.js";
import { keyringAnswer, type Refusal } from "./answer.js";
import { askpassStatus, installAskpass } from "./askpass.js";
import { KeyringCliError } from "./flags.js";
import { gitHelperStatus, installGitHelper } from "./git-helper.js";
import { installNativeHost, nativeHostStatus } from "./native-host-install.js";
import { pushKeyringChanged } from "./sandbox-push.js";

/* `intentic-machine keyring app <op> --json`: the Passwords app's verbs, as the desktop app calls them. Each reads ONE
   JSON object on stdin, never a value on its command line, and prints one JSON line (answer.ts). A value the app sends
   in (save, import, a request answered by typing it once, a new value in an edit) is sealed here to the vault's inbox
   key before it reaches the keyring's pipe, for `{ kind: "capture", via: "Passwords", at }` or, for an edit, the inbox
   purpose `keyring edit` uses. The keyring asks the person for whatever needs a yes. */

const pipe = (): KeyringClientOptions => ({ address: keyringPaths().address });
const ask = async <R extends KeyringRequest>(request: R): ReturnType<typeof askKeyring<R>> => await askKeyring(pipe(), request);

// An import of a few thousand rows is far more than one value: the cap is the keyring's own batch, generously.
const STDIN_MAX = 16 * 1024 * 1024;
const VIA = "Passwords";

// One JSON object on stdin, parsed with the verb's own schema.
const readRequest = async <T>(schema: z.ZodType<T>, input: NodeJS.ReadableStream = process.stdin): Promise<T> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > STDIN_MAX) {
            throw new KeyringCliError("usage", "What came on stdin is larger than any request the Passwords app sends.");
        }
        chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    let result: ReturnType<typeof schema.safeParse>;
    try {
        result = schema.safeParse(JSON.parse(text === "" ? "{}" : text));
    } catch {
        throw new KeyringCliError("usage", "stdin did not hold one JSON object.");
    }
    if (!result.success) {
        throw new KeyringCliError("usage", `stdin's request is not one this verb reads: ${result.error.issues.map((issue) => `${issue.path.join(".") || "request"} ${issue.message}`).join("; ")}.`);
    }
    return result.data;
};

const inboxKey = async (): Promise<string> => {
    const state = await ask({ op: "state" });
    if (!state.ok) {
        throw new KeyringCliError(state.code, state.refusal);
    }
    if (!state.setUp || state.state.keys === undefined) {
        throw new KeyringCliError("no-keyring", "Passwords is not set up on this computer yet.");
    }
    return state.state.keys.inbox;
};

const sealedCapture = (inbox: string, value: string, at: number): SealedBox => seal(inbox, value, { kind: "capture", via: VIA, at });

const value = z.string().min(1).max(32 * 1024);
const origins = z.array(KeyringOriginSchema).min(1).max(32);
const kind = z.enum(["password", "text"]);

/** Where an entry's origins put it, as the four rule lists an edit replaces. Pure. */
const originPatch = (list: readonly z.infer<typeof KeyringOriginSchema>[]): EntryPatch => {
    const rules = list.map(rulesForOrigin).reduce<OriginRules>((all, one) => mergeRules(all, one), { programs: [], packages: [], hosts: [], askpass: [] });
    return { programs: [...rules.programs], packages: [...rules.packages], hosts: [...rules.hosts], askpass: [...rules.askpass] };
};

// ---- the sources Passwords remembers from ----

const SOURCES = ["browser", "terminal", "apps", "phone", "sandbox"] as const;
type Source = (typeof SOURCES)[number];

export interface SourceState {
    readonly source: Source;
    readonly on: boolean;
    readonly ready: boolean;
    readonly available: boolean;
    readonly why?: string;
    readonly detail?: string;
    // What `setup-source` does for it, in words, when it needs doing.
    readonly asks?: string;
}

// Where the AT-SPI bus a Linux desktop exposes its password fields on lives, by distribution.
const ATSPI = ["/usr/libexec/at-spi-bus-launcher", "/usr/lib/at-spi-bus-launcher", "/usr/lib/at-spi2-core/at-spi-bus-launcher", "/usr/lib/x86_64-linux-gnu/at-spi-bus-launcher"];

const sourceStates = async (remember: Record<Source, boolean>, phonesPaired: number): Promise<SourceState[]> => {
    const desktop = process.platform === "win32" || process.platform === "linux";
    const [askpass, git, browsers] = await Promise.all([askpassStatus(), gitHelperStatus(), nativeHostStatus()]);
    const apps = process.platform === "win32" || (process.platform === "linux" && ATSPI.some((path) => existsSync(path)));
    const browser: SourceState =
        browsers.browsers.length === 0
            ? { source: "browser", on: remember.browser, ready: false, available: false, why: "No Chrome, Chromium, Brave or Edge has been run here." }
            : { source: "browser", on: remember.browser, ready: browsers.ready.length > 0, available: desktop, detail: browsers.browsers.join(", "), asks: "Lets the Intentic extension reach Passwords in each browser found." };
    const terminal: SourceState = { source: "terminal", on: remember.terminal, ready: askpass.installed && git.installed, available: true, asks: "Points ssh, sudo and git at Passwords for your user." };
    return [
        browser,
        terminal,
        apps
            ? { source: "apps", on: remember.apps, ready: true, available: true }
            : { source: "apps", on: remember.apps, ready: false, available: false, why: process.platform === "linux" ? "This desktop does not run the accessibility bus (AT-SPI) that shows password fields." : "Not on this computer's system yet." },
        { source: "phone", on: remember.phone, ready: phonesPaired > 0, available: true, ...(phonesPaired > 0 ? { detail: `${String(phonesPaired)} paired` } : { asks: "Pairing starts on the phone, in the Intentic app." }) },
        { source: "sandbox", on: remember.sandbox, ready: true, available: true },
    ];
};

// ---- the verbs ----

interface JsonFlags {
    readonly json: boolean;
}

const json = { kind: "boolean", brief: "Print one JSON line, `ok` first (what the desktop app reads)", default: false } as const;

// One verb: the request parsed from stdin with its schema, the work, and a line for a person reading a terminal.
const verb = <T, A extends { readonly ok: boolean }>(brief: string, failed: string, schema: z.ZodType<T>, work: (request: T) => Promise<A | Refusal>) =>
    buildCommand<JsonFlags>({
        docs: { brief },
        parameters: { flags: { json } },
        async func(this: CommandContext, flags: JsonFlags) {
            await keyringAnswer<A>(this, flags.json, { failed }, async () => await work(await readRequest(schema)), (_result, ui) => ui.done("Done."));
        },
    });

const Empty = z.object({}).strict();
const NameSchema = z.object({ name: KeyringSecretNameSchema }).strict();

const reveal = verb("Show an entry's value, or an earlier one (asks you)", "The value was not shown.", z.object({ name: KeyringSecretNameSchema, version: z.number().int().nonnegative().optional() }).strict(), async (request) => {
    return await ask(request.version === undefined ? { op: "reveal", name: request.name } : { op: "reveal", name: request.name, version: request.version });
});

const copy = verb("Put an entry's password or user name on the clipboard for a while", "Nothing was copied.", z.object({ name: KeyringSecretNameSchema, field: z.enum(["password", "username"]), clearAfterSeconds: z.number().int().min(5).max(300).optional() }).strict(), async (request) => {
    return await ask({ op: "copy", name: request.name, field: request.field, clearAfterSeconds: request.clearAfterSeconds ?? 30 });
});

const history = verb("An entry's earlier values: when, and from where (never the values)", "The history was not read.", NameSchema, async (request) => await ask({ op: "history", name: request.name }));

const restore = verb("Put an earlier value back (asks you)", "Nothing was put back.", z.object({ name: KeyringSecretNameSchema, version: z.number().int().nonnegative() }).strict(), async (request) => {
    return await ask({ op: "restore", name: request.name, version: request.version });
});

const undo = verb("Take back what a capture just did", "Nothing was undone.", z.object({ name: KeyringSecretNameSchema, at: z.number().int() }).strict(), async (request) => {
    return await ask({ op: "undo-capture", name: request.name, at: request.at });
});

const seen = verb("Mark entries as looked at", "Nothing was marked.", z.object({ names: z.array(KeyringSecretNameSchema).max(5000) }).strict(), async (request) => await ask({ op: "seen", names: request.names }));

const settings = verb("What Passwords remembers, and its other settings", "The settings were not read.", Empty, async () => await ask({ op: "settings" }));

const setSettings = verb("Change the settings (turning remembering on asks you)", "The settings were not changed.", z.object({ patch: KeyringSettingsPatchSchema }).strict(), async (request) => {
    return await ask({ op: "set-settings", patch: request.patch });
});

const activity = verb("What Passwords did, newest first: for one entry or all", "The activity was not read.", z.object({ name: KeyringSecretNameSchema.optional(), limit: z.number().int().min(1).max(500).optional() }).strict(), async (request) => {
    return await ask(request.name === undefined ? { op: "activity", limit: request.limit ?? 100 } : { op: "activity", name: request.name, limit: request.limit ?? 100 });
});

const needs = verb("Agents' requests waiting for an answer", "The requests were not read.", Empty, async () => await ask({ op: "needs" }));

const answerNeed = verb("Answer an agent's request (asks you)", "The request was not answered.", z.object({ id: z.string(), answer: KeyringNeedAnswerSchema, name: KeyringSecretNameSchema.optional(), value: value.optional() }).strict(), async (request) => {
    const waiting = await ask({ op: "needs" });
    const asked: Extract<KeyringRequest, { op: "answer-need" }> = { op: "answer-need", id: request.id, answer: request.answer };
    if (request.name !== undefined) {
        asked.name = request.name;
    }
    if (request.value !== undefined) {
        const at = Date.now();
        asked.sealed = sealedCapture(await inboxKey(), request.value, at);
        asked.at = at;
    }
    const result = await ask(asked);
    // The sandbox that asked hears it now, and wakes the conversation waiting on it (sandbox-push.ts).
    const sandbox = waiting.ok && "pending" in waiting ? waiting.pending.find((need) => need.id === request.id)?.sandbox : undefined;
    if (result.ok && sandbox !== undefined) {
        await pushKeyringChanged(sandbox);
    }
    return result;
});

const SaveSchema = z.object({ title: z.string().min(1).max(200), username: z.string().max(256).optional(), value, kind: kind.default("password"), origins, note: z.string().max(500).optional() }).strict();

// A manual add is a capture with source `manual`: kept at once (the keyring opens itself at your yes when locked). Any
// further place and a note go on with an edit, which asks you when it widens where the value may go.
const save = verb("Save a password by hand", "The password was not saved.", SaveSchema, async (request) => {
    const at = Date.now();
    const [first] = request.origins;
    if (first === undefined) {
        throw new KeyringCliError("usage", "A password needs at least one place it is used.");
    }
    const item: KeyringCaptureItem = { origin: first, sealed: sealedCapture(await inboxKey(), request.value, at), source: "manual", via: VIA, kind: request.kind, title: request.title, at };
    if (request.username !== undefined && request.username !== "") {
        item.username = request.username;
    }
    const saved = await ask({ op: "capture", item });
    if (!saved.ok || saved.name === undefined) {
        return saved;
    }
    if (request.origins.length > 1 || request.note !== undefined) {
        const patch: EntryPatch = request.origins.length > 1 ? originPatch(request.origins) : {};
        const edited = await ask({ op: "edit", name: saved.name, patch: request.note === undefined ? patch : { ...patch, note: request.note } });
        if (!edited.ok) {
            return edited;
        }
    }
    // A new entry can be the one a waiting request needs: every sandbox reads this keyring now.
    await pushKeyringChanged();
    return { ok: true as const, outcome: saved.outcome, name: saved.name };
});

const EditSchema = z
    .object({
        name: KeyringSecretNameSchema,
        patch: z.object({ title: z.string().min(1).max(200).optional(), username: z.string().max(256).optional(), kind: kind.optional(), origins: origins.optional(), note: z.string().max(500).optional(), anyField: z.boolean().optional() }).strict(),
        value: value.optional(),
    })
    .strict();

/** The app's edit as the keyring's patch: its places as rule lists. Pure. */
const editPatchOf = (patch: z.infer<typeof EditSchema>["patch"]): EntryPatch => {
    const { origins: places, ...rest } = patch;
    const out: EntryPatch = places === undefined ? {} : originPatch(places);
    return { ...out, ...Object.fromEntries(Object.entries(rest).filter(([, field]) => field !== undefined)) };
};

const edit = verb("Change an entry: its title, user, places, note, or value (asks you when it widens anything)", "The entry was not changed.", EditSchema, async (request) => {
    const patch = editPatchOf(request.patch);
    const edited = await ask(request.value === undefined ? { op: "edit", name: request.name, patch } : { op: "edit", name: request.name, patch, sealed: sealForKeyring(await inboxKey(), request.name, request.value) });
    // A place added can be what a waiting request needs: every sandbox reads this keyring now.
    if (edited.ok) {
        await pushKeyringChanged();
    }
    return edited;
});

const ImportSchema = z
    .object({
        from: z.string().min(1).max(200),
        rows: z.array(z.object({ origin: KeyringOriginSchema, title: z.string().max(200).optional(), username: z.string().max(256).optional(), value, note: z.string().max(500).optional() })).min(1).max(KEYRING_CAPTURE_BATCH_MAX),
    })
    .strict();

// Each row sealed here; the keyring asks you once for the whole import. A row's note is not carried: an import is
// passwords, and a note is added after.
const importRows = verb("Import passwords from another manager's export (asks you once)", "Nothing was imported.", ImportSchema, async (request) => {
    const inbox = await inboxKey();
    const at = Date.now();
    const items = request.rows.map((row): KeyringCaptureItem => {
        const item: KeyringCaptureItem = { origin: row.origin, sealed: sealedCapture(inbox, row.value, at), source: "import", via: VIA, kind: "password", at };
        if (row.title !== undefined) {
            item.title = row.title;
        }
        if (row.username !== undefined && row.username !== "") {
            item.username = row.username;
        }
        return item;
    });
    const imported = await ask({ op: "capture-batch", items, from: request.from });
    if (imported.ok) {
        await pushKeyringChanged();
    }
    return imported;
});

const sources = verb("Where Passwords remembers from: each source's switch and whether it is set up here", "The sources were not read.", Empty, async () => {
    const state = await ask({ op: "state" });
    const read = await ask({ op: "settings" });
    const remember = state.ok ? state.state.remember : undefined;
    const phones = read.ok ? (read.phones?.length ?? 0) : 0;
    return { ok: true as const, sources: await sourceStates(remember ?? { browser: false, terminal: false, apps: false, phone: false, sandbox: false }, phones) };
});

const setupSource = verb("Set a source up on this computer: terminal (ssh, sudo, git) or browser", "The source was not set up.", z.object({ source: z.enum(SOURCES) }).strict(), async ({ source }) => {
    switch (source) {
        case "terminal": {
            await installAskpass();
            await installGitHelper();
            return { ok: true as const, source };
        }
        case "browser": {
            const done = await installNativeHost();
            return { ok: true as const, source, detail: done.ready.join(", ") };
        }
        case "phone":
            return { ok: true as const, source, detail: "Pairing starts on the phone, in the Intentic app." };
        case "apps":
        case "sandbox":
            return { ok: true as const, source };
    }
});

export const appCommands = buildRouteMap({
    routes: {
        reveal,
        copy,
        history,
        restore,
        undo,
        seen,
        settings,
        "set-settings": setSettings,
        activity,
        needs,
        "answer-need": answerNeed,
        save,
        edit,
        import: importRows,
        sources,
        "setup-source": setupSource,
    },
    docs: { brief: "The Passwords app's verbs: each reads one JSON object on stdin" },
});
