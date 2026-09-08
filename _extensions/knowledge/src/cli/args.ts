// Hand-rolled argument reader for the `kb` CLI: one verb, positionals, and `--flag value` pairs, kept tiny since it
// ends up in a self-contained bundle. Every flag is collected into a list (repeatable); single-value readers take the
// last.

export interface Args {
    readonly verb: string;
    readonly positionals: readonly string[];
    readonly flags: ReadonlyMap<string, readonly string[]>;
}

// Flags that are switches, not values, so `--json read` is not read as `json=read`.
const SWITCHES = new Set(["json", "help", "all"]);

export const parseArgs = (argv: readonly string[]): Args => {
    const positionals: string[] = [];
    const flags = new Map<string, string[]>();
    const push = (name: string, value: string): void => {
        flags.set(name, [...(flags.get(name) ?? []), value]);
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? "";
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const [name, inline] = ((): [string, string | undefined] => {
            const cut = arg.indexOf("=");
            return cut === -1 ? [arg.slice(2), undefined] : [arg.slice(2, cut), arg.slice(cut + 1)];
        })();
        if (SWITCHES.has(name)) {
            push(name, inline ?? "true");
            continue;
        }
        if (inline !== undefined) {
            push(name, inline);
            continue;
        }
        const next = argv[i + 1];
        // A trailing or flag-followed value-flag is recorded set-with-nothing, not by eating the next flag.
        if (next === undefined || next.startsWith("--")) {
            push(name, "");
            continue;
        }
        push(name, next);
        i++;
    }
    return { verb: positionals[0] ?? "", positionals: positionals.slice(1), flags };
};

export const flag = (args: Args, name: string): string | undefined => {
    const values = args.flags.get(name);
    const last = values?.at(-1);
    return last === undefined || last === "" ? undefined : last;
};

export const flagAll = (args: Args, name: string): readonly string[] => (args.flags.get(name) ?? []).filter((value) => value !== "");

export const has = (args: Args, name: string): boolean => args.flags.has(name);

export const number = (args: Args, name: string, fallback: number): number => {
    const parsed = Number(flag(args, name));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};
