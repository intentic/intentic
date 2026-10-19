import { KEYRING_NAME_RE, type KeyringCaptureSource, type KeyringOrigin, type KeyringRemember } from "../schemas/keyring.js";

// WHERE A CREDENTIAL BELONGS, in the two shapes the product keeps it in: an ORIGIN (schemas/keyring.ts), which is how a
// capture, an agent's need and the Passwords app speak of it ("github.com", "ssh radar@build-01"), and an entry's RULES
// (programs, packages, hosts, askpass matchers), which is how the keyring decides where a value may go. One file maps
// each onto the other, names and titles a new entry, and finds the entry a capture updates, so the keyring, the
// sandbox and the app agree on all four. Pure: no crypto, no I/O, safe in a browser bundle.

/** The parts of an entry's rules an origin speaks to. */
export interface OriginRules {
    readonly programs: readonly string[];
    readonly packages: readonly string[];
    readonly hosts: readonly string[];
    readonly askpass: readonly string[];
}

const EMPTY: OriginRules = { programs: [], packages: [], hosts: [], askpass: [] };

/** A host as two captures of the same site agree on it: lower case, no trailing dot, no leading `www.`. */
export const normalizeHost = (host: string): string =>
    host
        .trim()
        .toLowerCase()
        .replace(/\.$/u, "")
        .replace(/^www\./u, "");

// A program by its executable's file name, as Windows compares them: without case, without its folder.
const programName = (program: string): string => (program.split(/[\\/]/u).pop() ?? program).toLowerCase();

const hostOfUrl = (url: string): string | undefined => {
    try {
        return normalizeHost(new URL(url).host);
    } catch {
        // allow(silent-catch): a git remote named without a scheme is not an address to take a host from
        return undefined;
    }
};

/** `https://github.com/org/repo` → `https://github.com`: git asks per host, and an entry answers for all its repos. */
export const gitOrigin = (url: string): string => {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${normalizeHost(parsed.host)}`;
    } catch {
        // allow(silent-catch): kept as written; it still matches itself
        return url;
    }
};

/** One string per place, so two captures of the same place compare equal. */
export const originKey = (origin: KeyringOrigin): string => {
    switch (origin.kind) {
        case "site":
            return `site:${normalizeHost(origin.host)}`;
        case "program":
            return `program:${programName(origin.program)}`;
        case "package":
            return `package:${origin.package}`;
        case "ssh":
            return `ssh:${origin.target.toLowerCase()}`;
        case "ssh-key":
            return `ssh-key:${origin.path}`;
        case "sudo":
            return `sudo:${origin.user ?? ""}`;
        case "git":
            return `git:${gitOrigin(origin.url)}`;
        case "prompt":
            return `prompt:${origin.sandbox ?? ""}:${origin.command ?? ""}:${origin.text.trim()}`;
    }
};

/** The rules an entry needs to be used where `origin` is: what a captured credential's entry gets without anyone typing it. */
export const rulesForOrigin = (origin: KeyringOrigin): OriginRules => {
    switch (origin.kind) {
        case "site":
            return { ...EMPTY, hosts: [normalizeHost(origin.host)] };
        case "program":
            return { ...EMPTY, programs: [origin.program] };
        case "package":
            return { ...EMPTY, packages: [origin.package] };
        case "ssh":
            return { ...EMPTY, askpass: [`ssh:${origin.target}`] };
        case "ssh-key":
            return { ...EMPTY, askpass: [`ssh-key:${origin.path}`] };
        case "sudo":
            return { ...EMPTY, askpass: [origin.user === undefined ? "sudo" : `sudo:${origin.user}`] };
        case "git": {
            const host = hostOfUrl(origin.url);
            return { ...EMPTY, askpass: [`git:${gitOrigin(origin.url)}`], hosts: host === undefined ? [] : [host] };
        }
        case "prompt":
            // A sandbox terminal's prompt is no rule on this computer: the entry is found by its title, and shared on a need.
            return origin.sandbox === undefined ? { ...EMPTY, askpass: [`prompt:${origin.text.trim()}`] } : EMPTY;
    }
};

/** Two sets of rules as one, each list without repeats: how a second place is added to an entry. */
export const mergeRules = (a: OriginRules, b: OriginRules): OriginRules => {
    const union = (x: readonly string[], y: readonly string[]): string[] => [...new Set([...x, ...y])];
    return { programs: union(a.programs, b.programs), packages: union(a.packages, b.packages), hosts: union(a.hosts, b.hosts), askpass: union(a.askpass, b.askpass) };
};

// An askpass matcher back into the origin it was made from; undefined for one this file did not make.
const originOfMatcher = (matcher: string): KeyringOrigin | undefined => {
    const colon = matcher.indexOf(":");
    const head = colon === -1 ? matcher : matcher.slice(0, colon);
    const rest = colon === -1 ? "" : matcher.slice(colon + 1);
    switch (head) {
        case "ssh":
            return rest === "" ? undefined : { kind: "ssh", target: rest };
        case "ssh-key":
            return rest === "" ? undefined : { kind: "ssh-key", path: rest };
        case "sudo":
            return rest === "" ? { kind: "sudo" } : { kind: "sudo", user: rest };
        case "git":
            return rest === "" ? undefined : { kind: "git", url: rest };
        case "prompt":
            return rest === "" ? undefined : { kind: "prompt", text: rest };
        default:
            return undefined;
    }
};

/** Every place an entry's rules say it is used, for the app's "Works on" chips. A `*.domain` host reads as the domain. */
export const originsOfRules = (rules: OriginRules): KeyringOrigin[] => {
    const fromAskpass = rules.askpass.map(originOfMatcher).filter((origin): origin is KeyringOrigin => origin !== undefined);
    // A git entry's host is said by its `git:` matcher; listing the site again would say it twice.
    const gitHosts = new Set(fromAskpass.flatMap((origin) => (origin.kind === "git" ? [hostOfUrl(origin.url)] : [])));
    return [
        ...rules.hosts.map((host) => host.replace(/^\*\./u, "")).filter((host) => !gitHosts.has(normalizeHost(host))).map((host): KeyringOrigin => ({ kind: "site", host })),
        ...rules.programs.map((program): KeyringOrigin => ({ kind: "program", program })),
        ...rules.packages.map((pkg): KeyringOrigin => ({ kind: "package", package: pkg })),
        ...fromAskpass,
    ];
};

const hostServes = (host: string, pattern: string): boolean => {
    const want = normalizeHost(host);
    const wildcard = pattern.startsWith("*.");
    const base = normalizeHost(wildcard ? pattern.slice(2) : pattern);
    // A saved `github.com` also fills `gist.github.com`, as every password manager's site matching does.
    return want === base || want.endsWith(`.${base}`);
};

/** Whether an entry with these rules is the one for `origin`: the test a need, a fill and a capture all use. */
export const rulesServe = (rules: OriginRules, origin: KeyringOrigin): boolean => {
    switch (origin.kind) {
        case "site":
            return rules.hosts.some((pattern) => hostServes(origin.host, pattern));
        case "program": {
            const want = programName(origin.program);
            return rules.programs.some((program) => programName(program) === want);
        }
        case "package":
            return rules.packages.includes(origin.package);
        case "git": {
            const want = `git:${gitOrigin(origin.url)}`;
            const host = hostOfUrl(origin.url);
            return rules.askpass.some((matcher) => matcher.startsWith("git:") && `git:${gitOrigin(matcher.slice(4))}` === want) || (host !== undefined && rules.hosts.some((pattern) => hostServes(host, pattern)));
        }
        case "ssh":
        case "ssh-key":
        case "sudo":
        case "prompt": {
            const wanted = rulesForOrigin(origin).askpass;
            return wanted.length > 0 && rules.askpass.some((matcher) => wanted.includes(matcher));
        }
    }
};

const sameUser = (a: string | undefined, b: string | undefined): boolean => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** What a capture is compared against: each entry's name, the rules that place it, and the account it signs in as. */
export interface CaptureCandidate {
    readonly name: string;
    readonly rules: OriginRules;
    readonly username?: string | undefined;
    readonly title?: string | undefined;
}

/**
 * The entry a capture updates: one used at the same place for the same account. Undefined: the capture is a new entry,
 * even where the place has entries for other accounts (a second GitHub login is a second entry, not an overwrite).
 */
export const findCaptureTarget = <T extends CaptureCandidate>(entries: readonly T[], origin: KeyringOrigin, username: string | undefined): T | undefined =>
    entries.find((entry) => rulesServe(entry.rules, origin) && sameUser(entry.username, username)) ??
    // A sandbox terminal's prompt places nothing on this computer, so its entry is found by the title it was given.
    (origin.kind === "prompt" && origin.sandbox !== undefined ? entries.find((entry) => entry.title === titleForOrigin(origin) && sameUser(entry.username, username)) : undefined);

/** Entries that serve `origin`, the given account first: what a need, a browser's or a phone's fill offers. */
export const entriesFor = <T extends CaptureCandidate>(entries: readonly T[], origin: KeyringOrigin, username?: string): T[] => {
    const serving = entries.filter((entry) => rulesServe(entry.rules, origin));
    return username === undefined ? serving : [...serving.filter((entry) => sameUser(entry.username, username)), ...serving.filter((entry) => !sameUser(entry.username, username))];
};

const baseName = (path: string): string => path.split(/[\\/]/u).pop() ?? path;

/** What a person calls the place: `github.com`, `FortiClient VPN`, `ssh radar@build-01`, `sudo`, `git github.com`. */
export const titleForOrigin = (origin: KeyringOrigin, given?: string): string => {
    const named = given?.trim();
    if (named !== undefined && named !== "") {
        return named.slice(0, 200);
    }
    switch (origin.kind) {
        case "site":
            return normalizeHost(origin.host);
        case "program":
            return origin.label ?? baseName(origin.program).replace(/\.exe$/iu, "");
        case "package":
            return origin.label ?? origin.package.split(".").pop() ?? origin.package;
        case "ssh":
            return `ssh ${origin.target}`;
        case "ssh-key":
            return `ssh key ${baseName(origin.path)}`;
        case "sudo":
            return origin.user === undefined ? "sudo" : `sudo as ${origin.user}`;
        case "git":
            return `git ${hostOfUrl(origin.url) ?? origin.url}`;
        case "prompt":
            return origin.command ?? origin.text.replace(/[:\s]+$/u, "");
    }
};

const NAME_MAX = 128;

// Upper case, every run of anything else one underscore, never starting with a digit: the shape a reference takes.
const referenceName = (text: string): string => {
    const upper = text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/gu, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/gu, "_")
        .replace(/^_+|_+$/gu, "");
    const named = upper === "" ? "PASSWORD" : /^[0-9]/u.test(upper) ? `_${upper}` : upper;
    return named.slice(0, NAME_MAX).replace(/_+$/u, "");
};

/**
 * A new entry's name, the `{{secret:NAME}}` an agent writes: from its title (`GITHUB_COM`), then with the account
 * (`GITHUB_COM_RADARSU`) when that is taken, then numbered. Always matches KEYRING_NAME_RE.
 */
export const entryNameFor = (title: string, username: string | undefined, taken: (name: string) => boolean): string => {
    const base = referenceName(title);
    const tries = [base];
    if (username !== undefined && username.trim() !== "") {
        tries.push(referenceName(`${base}_${username.split("@")[0] ?? username}`));
    }
    for (const name of tries) {
        if (!taken(name) && KEYRING_NAME_RE.test(name)) {
            return name;
        }
    }
    const stem = (tries.at(-1) ?? base).slice(0, NAME_MAX - 6);
    for (let n = 2; ; n++) {
        const name = `${stem}_${String(n)}`;
        if (!taken(name)) {
            return name;
        }
    }
};

/**
 * The remember switch a capture source needs on, or undefined for a deliberate act (an import, an agent's `secrets ask`,
 * adding by hand) that needs none.
 */
export const rememberSwitchFor = (source: KeyringCaptureSource): keyof KeyringRemember | undefined => {
    switch (source) {
        case "browser":
            return "browser";
        case "askpass":
        case "git":
            return "terminal";
        case "app":
            return "apps";
        case "phone":
            return "phone";
        case "terminal":
            return "sandbox";
        case "import":
        case "agent":
        case "manual":
            return undefined;
    }
};

/** Remembering off everywhere: a vault's settings before the person's one yes. */
export const REMEMBER_NOTHING: KeyringRemember = { browser: false, terminal: false, apps: false, phone: false, sandbox: false };
