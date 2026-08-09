/* THE FLAG PARSER. Small on purpose: this tool is typed by a model, and the shapes a model reaches for are
 * `--to a@b.com`, `--to=a@b.com` and `-n 20`. Anything cleverer (short-flag clustering, negation, arrays by
 * repetition) is surface nobody uses and behaviour nobody can predict from the help text.
 *
 * A repeated flag keeps the LAST value, which is what a shell does; a comma splits a list, which is what the
 * help text shows. `--` ends flag parsing so a subject line starting with a dash can still be sent. */

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

const VALUELESS = new Set(["json", "all", "notify", "meet", "csv", "raw", "verbose", "help"]);

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
