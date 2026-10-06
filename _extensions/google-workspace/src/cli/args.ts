/* THE FLAG PARSER. */

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

export interface Args {
    readonly positional: string[];
    readonly flags: Map<string, string | true>;
}

// Switches that never take a value, so the token after one stays a positional. `--csv` is not one: it names a file
// (`gw sheets write … --csv rows.csv`), and listing it here read that as `--csv` plus a stray positional, so the data
// never arrived. `--case` is one (`gw docs replace … --case <documentId>` kept its id).
const VALUELESS = new Set(["json", "all", "notify", "meet", "raw", "help", "h", "case"]);

// Every flag some `gw` command reads, and the router's own. Anything else is refused before a command runs: a flag
// nothing reads would be dropped in silence, and a misspelt `--attachh` would send the mail without its attachment.
// args.test.ts reads every flag name the sources ask for and fails on one missing here.
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
    // The router: which account, as whom, how to print.
    "account",
    "as",
    "json",
    "help",
    "h",
    "n",
    "limit",
    // auth
    "access",
    "client-id",
    "client-secret",
    "code",
    "port",
    // mail
    "add",
    "all",
    "attach",
    "bcc",
    "body",
    "body-file",
    "cc",
    "download",
    "from",
    "remove",
    "subject",
    "thread",
    "to",
    // calendar
    "attendees",
    "cal",
    "calendar",
    "description",
    "emails",
    "end",
    "location",
    "meet",
    "search",
    "start",
    "title",
    "who",
    "with",
    // drive
    "email",
    "folder",
    "name",
    "notify",
    "out",
    "role",
    // docs
    "case",
    "find",
    "text",
    // sheets
    "csv",
    "json-values",
    "range",
    "raw",
    "values",
]);

// Edit distance, for naming the flag a typo probably meant.
const distance = (a: string, b: string): number => {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length] ?? 0;
};

const spelled = (name: string): string => (name.length === 1 ? `-${name}` : `--${name}`);

// Refuses the first flag `known` does not hold, naming the closest one it does when there is a plausible one.
export const rejectUnknownFlags = (args: Args, known: ReadonlySet<string> = KNOWN_FLAGS): void => {
    for (const name of args.flags.keys()) {
        if (known.has(name)) {
            continue;
        }
        const [closest] = [...known].filter((candidate) => distance(name, candidate) <= 2).toSorted((a, b) => distance(name, a) - distance(name, b));
        throw new UsageError(`unknown flag ${spelled(name)}${closest === undefined ? "" : `; did you mean ${spelled(closest)}?`} (gw <group> lists each command's flags)`);
    }
};

export const parseArgs = (argv: readonly string[]): Args => {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    let literal = false;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] as string;
        if (literal || !token.startsWith("-") || token === "-") {
            positional.push(token);
            continue;
        }
        if (token === "--") {
            literal = true;
            continue;
        }
        const [name, inline] = (() => {
            const stripped = token.replace(/^--?/, "");
            const equals = stripped.indexOf("=");
            return equals === -1 ? ([stripped, undefined] as const) : ([stripped.slice(0, equals), stripped.slice(equals + 1)] as const);
        })();
        if (inline !== undefined) {
            flags.set(name, inline);
            continue;
        }
        const next = argv[index + 1];
        if (VALUELESS.has(name) || next === undefined || (next.startsWith("-") && next !== "-" && Number.isNaN(Number(next)))) {
            flags.set(name, true);
            continue;
        }
        flags.set(name, next);
        index += 1;
    }
    return { positional, flags };
};

export const flag = (args: Args, ...names: readonly string[]): string | undefined => {
    for (const name of names) {
        const value = args.flags.get(name);
        if (typeof value === "string") {
            return value;
        }
    }
    return undefined;
};

export const bool = (args: Args, ...names: readonly string[]): boolean => names.some((name) => args.flags.has(name));

export const required = (args: Args, ...names: readonly string[]): string => {
    const value = flag(args, ...names);
    if (value === undefined || value === "") {
        throw new UsageError(`--${names[0]} is required`);
    }
    return value;
};

export const list = (args: Args, ...names: readonly string[]): string[] =>
    (flag(args, ...names) ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");

export const positional = (args: Args, index: number, what: string): string => {
    const value = args.positional[index];
    if (value === undefined || value === "") {
        throw new UsageError(`${what} is required`);
    }
    return value;
};

// `-n` / `--limit`, with the ceiling that keeps a stray `-n 100000` from walking a whole mailbox.
export const limit = (args: Args, fallback: number, ceiling = 500): number => {
    const raw = flag(args, "n", "limit");
    if (raw === undefined) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new UsageError(`-n must be a positive number, got "${raw}"`);
    }
    return Math.min(parsed, ceiling);
};
