/* THE FLAG PARSER: positionals, `--flag value`, `--flag=value`, and switches that never take a value. A flag no
   command reads is refused, so a misspelt `--repeald` fails instead of quietly searching acts in force. */

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

const SWITCHES = new Set(["json", "refresh", "original", "unified", "in-force", "repealed", "full", "all", "help"]);
const VALUED = new Set(["keyword", "type", "year", "publisher", "limit", "from", "to", "act", "regulation", "legal-base", "case", "court"]);

export const parseArgs = (argv: readonly string[]): Args => {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] ?? "";
        if (!token.startsWith("--")) {
            positional.push(token);
            continue;
        }
        const [name = "", inline] = token.slice(2).split(/=(.*)/su);
        if (SWITCHES.has(name)) {
            flags.set(name, true);
            continue;
        }
        if (!VALUED.has(name)) {
            throw new UsageError(`unknown flag --${name} (prawo --help lists them)`);
        }
        const value = inline ?? argv[index + 1];
        if (value === undefined || (inline === undefined && value.startsWith("--"))) {
            throw new UsageError(`--${name} needs a value`);
        }
        flags.set(name, value);
        index += inline === undefined ? 1 : 0;
    }
    return { positional, flags };
};

export const flag = (args: Args, name: string): string | undefined => {
    const value = args.flags.get(name);
    return value === true ? undefined : value;
};

export const has = (args: Args, name: string): boolean => args.flags.has(name);

export const limitOf = (args: Args, fallback: number): number => {
    const raw = flag(args, "limit");
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new UsageError(`--limit must be a whole number from 1 to 100, got "${raw ?? String(fallback)}"`);
    }
    return value;
};

export const dateOf = (args: Args, name: string): string | undefined => {
    const value = flag(args, name);
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new UsageError(`--${name} takes a date as YYYY-MM-DD, got "${value}"`);
    }
    return value;
};
