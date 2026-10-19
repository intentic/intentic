// THE ONE-LINER: every command a person copy-pastes is `curl -fsSL https://intentic.dev/<verb>/<arg> | sh` or
// `irm https://intentic.dev/<verb>/<arg> | iex`. The site's Worker serves the static script for the verb with the
// arguments injected; the editor and the sandbox build the URL. This table is the one place that says which verbs
// exist, what each argument may be, and which script and parameters it becomes, so the Worker that serves a URL and
// the code that hands it out cannot disagree.
//
// Every argument is checked against its own pattern, and every value injected into a script only ever holds
// `[A-Za-z0-9._~/-]`, so single-quoting it is safe in both shells.

import { INSTALL_SCRIPTS_DIR, PLATFORM_SITE_ORIGIN } from "./index.js";

export type OneLinerShell = "sh" | "ps1";

// Argument patterns, one per kind of value a URL segment can carry.
export const SETUP_CODE_PATTERN = /^[A-Za-z0-9]{6,64}$/;
// The leaf of the default sync folder, `~/intentic/<leaf>`: the folder itself never goes through the platform, only
// its last segment rides the URL into the script on the person's own device.
export const SYNC_LEAF_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
// Never a leading `-`: fix.sh hands an argument that starts with one to `ic sandbox fix` as a flag, so `/fix/--yes`
// would run every fix without asking.
export const FIX_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const IMAGE_HASH_PATTERN = /^[a-f0-9]{8,64}$/;
// A sandbox-minted short code (Crockford base32, 8 characters, one optional hyphen in the middle).
export const SHORT_CODE_PATTERN = /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/;
// A bare DNS hostname: no port, no scheme. IP literals are refused separately (an all-digit last label).
export const HOSTNAME_PATTERN = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// The only characters an injected value may hold, whatever the verb: a second line of defence behind each pattern.
export const SAFE_ARG = /^[A-Za-z0-9._~/-]+$/;

/** The folder the setup page syncs by default, and the only kind whose leaf can ride a setup one-liner. */
export const DEFAULT_SYNC_ROOT = "~/intentic";

/** Whether `host` is a hostname a device/sync/server one-liner can carry (lowercase it first). */
export const isOneLinerHost = (host: string): boolean => HOSTNAME_PATTERN.test(host) && !/^\d+$/.test(host.slice(host.lastIndexOf(".") + 1));

/**
 * A sandbox's address as a device, sync or server one-liner carries it: the bare hostname of its https URL. Undefined
 * for one no one-liner can reach (localhost, an IP, a port), which keeps its environment-variable command.
 */
export const oneLinerHostOf = (sandboxUrl: string | undefined | null): string | undefined => {
    if (sandboxUrl === undefined || sandboxUrl === null || sandboxUrl === ``) {
        return undefined;
    }
    if (!URL.canParse(sandboxUrl)) {
        return undefined;
    }
    const url = new URL(sandboxUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === `https:` && url.port === `` && isOneLinerHost(host) ? host : undefined;
};

interface ArgSpec {
    readonly name: string;
    readonly test: (value: string) => boolean;
    // Applied before the test, both by the Worker and by the builders (a hostname is case-insensitive).
    readonly normalize?: (value: string) => string;
}

// A PowerShell parameter: `-Name 'value'`, or a bare switch.
export interface Ps1Param {
    readonly name: string;
    readonly value?: string;
}

/** What a verb and its arguments become: the script files, sh's positional args and env, PowerShell's parameters. */
export interface ResolvedOneLiner {
    readonly files: { readonly sh: string; readonly ps1: string };
    readonly shArgs: readonly string[];
    readonly shEnv: readonly (readonly [name: string, value: string])[];
    readonly ps1Params: readonly Ps1Param[];
    // Whether the arguments a person adds by hand (`| sh -s -- --dry-run`, or after the scriptblock in PowerShell) ride
    // after the URL's. Otherwise the URL's replace them, so `$1…` are exactly what the URL says.
    readonly typed: boolean;
}

interface VerbSpec {
    readonly files: { readonly sh: string; readonly ps1: string };
    readonly required: readonly ArgSpec[];
    readonly optional: readonly ArgSpec[];
    readonly typed?: true;
    readonly sh: (args: readonly string[]) => { readonly args: readonly string[]; readonly env?: readonly (readonly [string, string])[] };
    readonly ps1: (args: readonly string[]) => readonly Ps1Param[];
}

const arg = (name: string, pattern: RegExp, normalize?: (value: string) => string): ArgSpec => ({
    name,
    test: (value) => pattern.test(value),
    ...(normalize === undefined ? {} : { normalize }),
});
const slug = arg(`sandbox name`, SLUG_PATTERN);
const host: ArgSpec = { name: `sandbox address`, test: isOneLinerHost, normalize: (value) => value.toLowerCase() };
const shortCode = arg(`code`, SHORT_CODE_PATTERN);

const RECREATE = { sh: `recreate.sh`, ps1: `recreate.ps1` } as const;

// A device, sync or server connect: the sandbox's address and the code it minted, which the script redeems there.
const coded = (sh: string, ps1: string): VerbSpec => ({
    files: { sh, ps1 },
    required: [host, shortCode],
    optional: [],
    sh: ([address = ``, code = ``]) => ({ args: [address, code] }),
    ps1: ([address = ``, code = ``]) => [
        { name: `Sandbox`, value: address },
        { name: `Code`, value: code },
    ],
});

const VERBS = {
    setup: {
        files: { sh: `connect.sh`, ps1: `connect.ps1` },
        required: [arg(`setup code`, SETUP_CODE_PATTERN)],
        optional: [arg(`sync folder`, SYNC_LEAF_PATTERN)],
        sh: ([code = ``, leaf]) => ({ args: [code], env: leaf === undefined ? [] : [[`SYNC_DIR`, `${DEFAULT_SYNC_ROOT}/${leaf}`]] }),
        ps1: ([code = ``, leaf]) => [
            { name: `SetupCode`, value: code },
            ...(leaf === undefined ? [] : [{ name: `SyncDir`, value: `${DEFAULT_SYNC_ROOT}/${leaf}` }]),
        ],
    },
    fix: {
        files: { sh: `fix.sh`, ps1: `fix.ps1` },
        required: [arg(`fix code`, FIX_CODE_PATTERN)],
        optional: [],
        sh: ([code = ``]) => ({ args: [code] }),
        ps1: ([code = ``]) => [{ name: `Code`, value: code }],
    },
    update: {
        files: RECREATE,
        required: [slug],
        optional: [],
        sh: ([name = ``]) => ({ args: [name] }),
        ps1: ([name = ``]) => [{ name: `Slug`, value: name }],
    },
    rollback: {
        files: RECREATE,
        required: [slug],
        optional: [],
        sh: ([name = ``]) => ({ args: [name, `--rollback`] }),
        ps1: ([name = ``]) => [{ name: `Slug`, value: name }, { name: `Rollback` }],
    },
    restart: {
        files: RECREATE,
        required: [slug],
        optional: [],
        sh: ([name = ``]) => ({ args: [name, `--restart`] }),
        ps1: ([name = ``]) => [{ name: `Slug`, value: name }, { name: `Restart` }],
    },
    rebuild: {
        files: RECREATE,
        required: [slug, arg(`image hash`, IMAGE_HASH_PATTERN)],
        optional: [],
        sh: ([name = ``, hash = ``]) => ({ args: [name, hash] }),
        ps1: ([name = ``, hash = ``]) => [
            { name: `Slug`, value: name },
            { name: `Hash`, value: hash },
        ],
    },
    // Recoverable for 7 days; with no name the script lists the sandboxes on the device and asks which.
    remove: {
        files: { sh: `cleanup.sh`, ps1: `cleanup.ps1` },
        required: [],
        optional: [slug],
        sh: ([name]) => ({ args: name === undefined ? [] : [name, `--yes`] }),
        ps1: ([name]) => (name === undefined ? [] : [{ name: `Slug`, value: name }, { name: `Yes` }]),
    },
    // Intentic itself off this device, by `ic uninstall`, which shows what it found and asks before it deletes
    // anything. Nothing rides the URL; a flag the person adds (`--dry-run`, `--keep-sandboxes`) reaches ic.
    uninstall: {
        files: { sh: `uninstall.sh`, ps1: `uninstall.ps1` },
        required: [],
        optional: [],
        typed: true,
        sh: () => ({ args: [] }),
        ps1: () => [],
    },
    device: coded(`device.sh`, `device.ps1`),
    sync: coded(`sync.sh`, `sync.ps1`),
    server: coded(`connect-host.sh`, `connect-host.ps1`),
} as const satisfies Record<string, VerbSpec>;

export type OneLinerVerb = keyof typeof VERBS;

export const ONE_LINER_VERBS: readonly OneLinerVerb[] = Object.keys(VERBS) as OneLinerVerb[];

export const isOneLinerVerb = (value: string): value is OneLinerVerb => Object.hasOwn(VERBS, value);

const article = (noun: string): string => (/^[aeiou]/.test(noun) ? `an` : `a`);

/**
 * Checks a verb's arguments and says what they become, or why not in one sentence. The Worker serves nothing on an
 * error; the builders fall back to a command the table cannot express.
 */
export const resolveOneLiner = (verb: OneLinerVerb, raw: readonly string[]): ResolvedOneLiner | { readonly error: string } => {
    const spec: VerbSpec = VERBS[verb];
    const most = spec.required.length + spec.optional.length;
    if (raw.length < spec.required.length || raw.length > most) {
        const wanted = [...spec.required.map((a) => `${article(a.name)} ${a.name}`), ...spec.optional.map((a) => `an optional ${a.name}`)];
        return { error: wanted.length === 0 ? `${verb} takes nothing after it.` : `${verb} takes ${wanted.join(` and `)}.` };
    }
    const specs = [...spec.required, ...spec.optional];
    const args: string[] = [];
    for (const [index, value] of raw.entries()) {
        const which = specs[index]!;
        const normalized = which.normalize === undefined ? value : which.normalize(value);
        if (!which.test(normalized) || !SAFE_ARG.test(normalized)) {
            return { error: `That is not a valid ${which.name} for ${verb}.` };
        }
        args.push(normalized);
    }
    const sh = spec.sh(args);
    return { files: spec.files, shArgs: sh.args, shEnv: sh.env ?? [], ps1Params: spec.ps1(args), typed: spec.typed === true };
};

const resolved = (verb: OneLinerVerb, args: readonly string[]): ResolvedOneLiner => {
    const answer = resolveOneLiner(verb, args);
    if (`error` in answer) {
        throw new Error(answer.error);
    }
    return answer;
};

/** Whether the table can express this verb with these arguments. */
export const oneLinerFits = (verb: OneLinerVerb, args: readonly string[]): boolean => !(`error` in resolveOneLiner(verb, args));

/** `https://intentic.dev/<verb>/<arg>…`. Throws when an argument does not fit; check with `oneLinerFits` first. */
export const oneLinerUrl = (verb: OneLinerVerb, args: readonly string[] = []): string => {
    const normalized = args.map((value, index) => {
        const which = [...VERBS[verb].required, ...VERBS[verb].optional][index];
        return which?.normalize === undefined ? value : which.normalize(value);
    });
    resolved(verb, normalized);
    return [PLATFORM_SITE_ORIGIN, verb, ...normalized].join(`/`);
};

/** The published one-liner: `curl -fsSL <url> | sh` or `irm <url> | iex`. */
export const oneLinerCommand = (verb: OneLinerVerb, args: readonly string[], shell: OneLinerShell): string => {
    const url = oneLinerUrl(verb, args);
    return shell === `ps1` ? `irm ${url} | iex` : `curl -fsSL ${url} | sh`;
};

const quote = (value: string): string => `'${value}'`;

/** PowerShell parameter tokens: `-Slug 'x' -Rollback`. */
export const ps1ParamsText = (params: readonly Ps1Param[]): string =>
    params.map((param) => (param.value === undefined ? `-${param.name}` : `-${param.name} ${quote(param.value)}`)).join(` `);

/** sh positional args, each single-quoted. */
export const shArgsText = (args: readonly string[]): string => args.map(quote).join(` `);

/**
 * The same action run from a checkout of the repository instead of fetched: `sh _site/site/public/scripts/<file> <args>`
 * or `& ./_site/site/public/scripts/<file>.ps1 <args>`. For developers testing the working tree's scripts.
 */
export const oneLinerByPath = (verb: OneLinerVerb, args: readonly string[], shell: OneLinerShell): string => {
    const answer = resolved(verb, args);
    if (shell === `ps1`) {
        const params = ps1ParamsText(answer.ps1Params);
        return `& ./${INSTALL_SCRIPTS_DIR}/${answer.files.ps1}${params === `` ? `` : ` ${params}`}`;
    }
    const env = answer.shEnv.map(([name, value]) => ` ${name}=${quote(value)}`).join(``);
    const positional = shArgsText(answer.shArgs);
    return `${env === `` ? `` : `env${env} `}sh ${INSTALL_SCRIPTS_DIR}/${answer.files.sh}${positional === `` ? `` : ` ${positional}`}`;
};
