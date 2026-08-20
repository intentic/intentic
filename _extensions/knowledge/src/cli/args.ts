/* The `kb` CLI's argument reader. Hand-rolled and tiny, for the same reason the frontmatter parser is: this
 * file ends up inside a bundle that must be self-contained, and the grammar it has to cover is one verb, some
 * positionals and a handful of `--flag value` pairs.
 *
 * REPEATABLE BY DEFAULT, every flag is collected into a list, and the single-value readers take the last one.
 * `--tag colleague --tag math` is a thing the agent will type without being told it can, and a parser that
 * silently kept one of the two would drop half of what it asked for. */

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
        // A value-taking flag at the end of the line, or followed by another flag, is still a flag that was
        // meant, record it as set-with-nothing rather than swallowing the next flag as its value.
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
