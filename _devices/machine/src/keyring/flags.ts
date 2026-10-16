import {
    BackendConfigSchema,
    BackendRefSchema,
    type BackendConfig,
    type BackendRef,
    EntryPatchSchema,
    EntryRulesSchema,
    type EntryPatch,
    type EntryRules,
} from "@intentic/keyring";
import {
    KeyringSecretNameSchema,
    type KeyringRefusalCode,
    KeyringShareModeSchema,
    type KeyringShareMode,
} from "@intentic/sandbox-contract/schemas/keyring";
import type { z } from "zod";

// WHAT `intentic-machine keyring add|edit|share|backend` TAKE, read into the keyring's own requests (protocol.ts) before
// anything reaches its pipe, so a mistyped package name or a flag that belongs to another password manager is said here,
// by the flag's name, rather than as a refusal from the keyring. Pure: the commands (commands.ts) read the value itself
// and talk to the keyring; this file only turns flags into rules.

// What a `keyring` command answers with when it fails, under --json: the keyring's own refusal codes, plus `usage` for
// flags this command cannot take and `failed` for a step here that did not work (a download, a file).
export type KeyringCliCode = KeyringRefusalCode | "usage" | "failed";

export class KeyringCliError extends Error {
    readonly code: KeyringCliCode;
    constructor(code: KeyringCliCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "KeyringCliError";
        this.code = code;
    }
}

const usage = (message: string): KeyringCliError => new KeyringCliError("usage", message);

// The flags that set an entry's rules, on `add` and `edit` alike. Lists are repeatable flags.
export interface RuleFlags {
    readonly kind?: "password" | "text";
    readonly program?: readonly string[];
    readonly package?: readonly string[];
    readonly host?: readonly string[];
    readonly username?: string;
    readonly askpass?: readonly string[];
    readonly rememberMinutes?: number;
}

export type BackendName = "1password" | "bitwarden" | "keepassxc";

export interface AddFlags extends RuleFlags {
    readonly stdin: boolean;
    readonly anyField: boolean;
    readonly backend?: BackendName;
    readonly ref?: string;
    readonly field?: string;
    readonly attribute?: string;
    readonly replace: boolean;
    readonly json: boolean;
}

export interface EditFlags extends RuleFlags {
    readonly stdin: boolean;
    readonly anyField?: "on" | "off";
    readonly json: boolean;
}

// Which flag each rule is set by, so a rule the keyring would refuse is said as the flag a person typed.
const FLAG_OF = new Map<string, string>([
    ["kind", "--kind"],
    ["programs", "--program"],
    ["packages", "--package"],
    ["hosts", "--host"],
    ["anyField", "--any-field"],
    ["username", "--username"],
    ["askpass", "--askpass"],
    ["askpassRememberMinutes", "--remember-minutes"],
    ["backend", "--backend"],
    ["ref", "--ref"],
    ["field", "--field"],
    ["attribute", "--attribute"],
    ["cli", "--cli"],
    ["account", "--account"],
    ["tokenEntry", "--token-entry"],
    ["passwordEntry", "--password-entry"],
    ["database", "--database"],
    ["keyFile", "--key-file"],
]);

// A rejected parse as one sentence naming the flags at fault. Rules are not secrets, so what was typed may be quoted.
const issuesSentence = (error: z.ZodError): string =>
    error.issues
        .map((issue) => {
            const flag = issue.path.map((part) => FLAG_OF.get(String(part))).find((name) => name !== undefined);
            return `${flag ?? (issue.path.join(".") || "the entry")}: ${issue.message}`;
        })
        .join("; ");

const parsed = <T>(result: z.ZodSafeParseResult<T>): T => {
    if (!result.success) {
        throw usage(issuesSentence(result.error));
    }
    return result.data;
};

/** An entry's name, as the keyring and every `{{secret:NAME}}` reference spell it. */
export const entryName = (name: string): string => {
    const result = KeyringSecretNameSchema.safeParse(name);
    if (!result.success) {
        throw usage(`"${name}" is not a name an entry can have: a letter or underscore, then letters, digits, \`_\`, \`.\` or \`-\`, at most 128 characters.`);
    }
    return result.data;
};

/**
 * A repeatable flag as the list it sets: absent leaves the list as it is (undefined), and a lone empty value (`--program
 * ""`) empties it, since a list flag given at all replaces the whole list.
 */
export const listOf = (given: readonly string[] | undefined): string[] | undefined => {
    if (given === undefined) {
        return undefined;
    }
    return given.length === 1 && given[0] === "" ? [] : [...given];
};

// The rules a new entry starts with: a password typed only into a password field, asked about everywhere, until its
// flags say otherwise.
const addRules = (flags: AddFlags): EntryRules =>
    parsed(
        EntryRulesSchema.safeParse({
            kind: flags.kind ?? "password",
            programs: listOf(flags.program) ?? [],
            packages: listOf(flags.package) ?? [],
            hosts: listOf(flags.host) ?? [],
            anyField: flags.anyField,
            username: flags.username,
            askpass: listOf(flags.askpass) ?? [],
            askpassRememberMinutes: flags.rememberMinutes ?? 0,
        }),
    );

// Where a backed entry's value is read at each use. --field belongs to Bitwarden and --attribute to KeePassXC, and one
// given to another manager is refused rather than dropped.
const backendRef = (flags: AddFlags): BackendRef | undefined => {
    if (flags.backend === undefined) {
        if (flags.ref !== undefined || flags.field !== undefined || flags.attribute !== undefined) {
            throw usage("--ref, --field and --attribute name where a password manager keeps the value: give --backend with them.");
        }
        return undefined;
    }
    if (flags.ref === undefined || flags.ref === "") {
        throw usage(`--backend ${flags.backend} reads the value from ${flags.backend}: --ref says which item.`);
    }
    if (flags.field !== undefined && flags.backend !== "bitwarden") {
        throw usage(`--field picks a Bitwarden item's field; it means nothing to ${  flags.backend  }.`);
    }
    if (flags.attribute !== undefined && flags.backend !== "keepassxc") {
        throw usage(`--attribute picks a KeePassXC entry's attribute; it means nothing to ${  flags.backend  }.`);
    }
    if (flags.stdin) {
        throw usage(`An entry read from ${flags.backend} holds no value of its own: leave out --stdin.`);
    }
    // An absent --field or --attribute is the manager's own default (the password), which the schema fills in.
    return parsed(BackendRefSchema.safeParse({ backend: flags.backend, ref: flags.ref, field: flags.field, attribute: flags.attribute }));
};

/** What `keyring add` sends, but the value: `needsValue` says whether one is read and sealed before it goes. */
export interface AddPlan {
    readonly name: string;
    readonly rules: EntryRules;
    readonly backend?: BackendRef;
    readonly replace: boolean;
    readonly needsValue: boolean;
}

export const addPlan = (name: string, flags: AddFlags): AddPlan => {
    const plan = { name: entryName(name), rules: addRules(flags), replace: flags.replace, needsValue: flags.backend === undefined };
    const backend = backendRef(flags);
    return backend === undefined ? plan : { ...plan, backend };
};

/** The rules `keyring edit` changes: only those whose flag was given, each list whole. */
export const editPatch = (flags: EditFlags): EntryPatch =>
    // A rule whose flag was not given stays undefined here, which the request's JSON leaves out: the keyring keeps it.
    parsed(
        EntryPatchSchema.safeParse({
            kind: flags.kind,
            programs: listOf(flags.program),
            packages: listOf(flags.package),
            hosts: listOf(flags.host),
            anyField: flags.anyField === undefined ? undefined : flags.anyField === "on",
            username: flags.username,
            askpass: listOf(flags.askpass),
            askpassRememberMinutes: flags.rememberMinutes,
        }),
    );

/**
 * Whether `keyring edit` takes a new value: from stdin with --stdin, and from the terminal when no rule was given at
 * all, since an edit that changes nothing else is one that changes the value.
 */
export const editTakesValue = (flags: EditFlags, patch: EntryPatch): "stdin" | "terminal" | "none" => {
    if (flags.stdin) {
        return "stdin";
    }
    return Object.values(patch).every((rule) => rule === undefined) ? "terminal" : "none";
};

export const shareMode = (mode: string): KeyringShareMode => {
    const result = KeyringShareModeSchema.safeParse(mode);
    if (!result.success) {
        throw usage(`--mode is each-use, while-here or copy, not "${mode}".`);
    }
    return result.data;
};

// A sandbox linked to this computer, as `device.json` holds it: its address and the card this computer is known by there.
export interface LinkedSandbox {
    readonly sandboxUrl: string;
    readonly id: string;
}

// Two spellings of one sandbox's address read the same: a trailing slash, a host's case.
const sameUrl = (a: string, b: string): boolean => {
    const left = URL.parse(a);
    const right = URL.parse(b);
    return left !== null && right !== null && left.origin === right.origin && left.pathname.replace(/\/+$/u, "") === right.pathname.replace(/\/+$/u, "");
};

/** The link `--sandbox` names, by its address or by its id (the device card this computer is known by there). */
export const linkNamed = (links: readonly LinkedSandbox[], named: string): LinkedSandbox | undefined =>
    links.find((link) => link.id === named) ?? links.find((link) => sameUrl(link.sandboxUrl, named));

/**
 * The sandbox `share` shares with: one linked to this computer, since the keyring records which device card it is shared
 * through and fetches that sandbox's keys from its own address.
 */
export const shareTarget = (links: readonly LinkedSandbox[], named: string | undefined): LinkedSandbox => {
    if (named === undefined || named.trim() === "") {
        throw usage("--sandbox names the sandbox to share with: its address, or its link's id from `intentic-machine status`.");
    }
    const link = linkNamed(links, named.trim());
    if (link === undefined) {
        throw usage(
            links.length === 0
                ? `No sandbox is linked to this computer, so there is nothing to share ${named} with: connect one from a card in its chat first.`
                : `No sandbox linked to this computer is ${named}: it is one of ${links.map((each) => `${each.id} (${each.sandboxUrl})`).join(", ")}.`,
        );
    }
    return link;
};

/**
 * The sandbox `unshare` stops sharing with: a linked one by address or id, or any address, since an entry may still be
 * shared with a sandbox this computer has since been unlinked from.
 */
export const unshareTarget = (links: readonly LinkedSandbox[], named: string | undefined): string => {
    if (named === undefined || named.trim() === "") {
        throw usage("--sandbox names the sandbox to stop sharing with: its address, or its link's id.");
    }
    const link = linkNamed(links, named.trim());
    if (link !== undefined) {
        return link.sandboxUrl;
    }
    if (URL.parse(named.trim()) === null) {
        throw usage(`No sandbox linked to this computer has the id ${named}, and it is not an address either.`);
    }
    return named.trim();
};

export interface BackendFlags {
    readonly cli?: string;
    readonly account?: string;
    readonly tokenEntry?: string;
    readonly passwordEntry?: string;
    readonly database?: string;
    readonly keyFile?: string;
    readonly json: boolean;
}

// Which flags each password manager takes, beside --cli which all three do.
const BACKEND_FLAGS = {
    "1password": ["account", "tokenEntry"],
    bitwarden: ["passwordEntry"],
    keepassxc: ["database", "keyFile", "passwordEntry"],
} as const satisfies Readonly<Record<BackendName, readonly (keyof BackendFlags)[]>>;

const KEBAB = {
    cli: "--cli",
    account: "--account",
    tokenEntry: "--token-entry",
    passwordEntry: "--password-entry",
    database: "--database",
    keyFile: "--key-file",
    json: "--json",
} as const satisfies Readonly<Record<keyof BackendFlags, string>>;

/** How the keyring reaches a password manager, from `keyring backend`'s flags. */
export const backendConfig = (backend: BackendName, flags: BackendFlags): BackendConfig => {
    const takes: ReadonlySet<keyof BackendFlags> = new Set(BACKEND_FLAGS[backend]);
    const foreign = (["account", "tokenEntry", "passwordEntry", "database", "keyFile"] as const).filter((flag) => flags[flag] !== undefined && !takes.has(flag));
    if (foreign.length > 0) {
        throw usage(`${foreign.map((flag) => KEBAB[flag]).join(", ")} ${foreign.length === 1 ? "is" : "are"} not ${backend}'s to take.`);
    }
    // An absent --cli is the manager's own command name, which the schema fills in; the rest stay out when not given.
    return parsed(
        BackendConfigSchema.safeParse({
            backend,
            cli: flags.cli,
            account: flags.account,
            tokenEntry: flags.tokenEntry,
            passwordEntry: flags.passwordEntry,
            database: flags.database,
            keyFile: flags.keyFile,
        }),
    );
};
