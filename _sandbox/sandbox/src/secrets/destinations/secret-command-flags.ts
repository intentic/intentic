import { STAND_IN, type Unreadable, type Word } from "./secret-command-lex.js";

// An argument grammar shared by network clients and utilities: value-taking options, known switches, and options
// whose effects make the command unreadable. Anything not declared here asks rather than guessing its arity.
export interface Flags {
    readonly values: ReadonlySet<string>;
    readonly steers: ReadonlyMap<string, string>;
    readonly plain: ReadonlySet<string>;
}

const takesValue = (flags: Flags, name: string): boolean => flags.values.has(name);

// Why a flag rules the command out, or undefined for one the table knows to be harmless. `shown` is how the command
// spelled it.
const flagReason = (flags: Flags, name: string, shown: string): string | undefined =>
    flags.steers.get(name) ??
    (takesValue(flags, name) || flags.plain.has(name) ? undefined : `it uses an option (${shown}) this check does not read`);

// What one flag word took: how many following words it used as its value, and that value.
interface FlagRead {
    readonly skip: number;
    readonly value?: { readonly name: string; readonly word: Word };
}

const valueRead = (name: string, shown: string, attached: Word | undefined, next: Word | undefined): FlagRead | Unreadable => {
    const word = attached ?? next;
    return word === undefined ? { why: `${shown} is missing its value` } : { skip: attached === undefined ? 1 : 0, value: { name, word } };
};

// `--name value` or `--name=value`.
const readLong = (flags: Flags, word: Word, next: Word | undefined): FlagRead | Unreadable => {
    const [name = "", attached] = word.text.slice(2).split(/=(.*)/s);
    const why = flagReason(flags, name, `--${name}`);
    if (why !== undefined) {
        return { why };
    }
    if (!takesValue(flags, name)) {
        return { skip: 0 };
    }
    return valueRead(name, `--${name}`, attached === undefined ? undefined : { text: attached, dynamic: word.dynamic }, next);
};

// A short cluster, `-sSo out.json`: switches, then at most one value-taking letter, whose value is the rest of the word
// or the next one.
const readShort = (flags: Flags, word: Word, next: Word | undefined): FlagRead | Unreadable => {
    for (let at = 1; at < word.text.length; at += 1) {
        const letter = word.text.charAt(at);
        const why = flagReason(flags, letter, `-${letter}`);
        if (why !== undefined) {
            return { why };
        }
        if (takesValue(flags, letter)) {
            const rest = word.text.slice(at + 1);
            return valueRead(letter, `-${letter}`, rest === "" ? undefined : { text: rest, dynamic: word.dynamic }, next);
        }
    }
    return { skip: 0 };
};

const readFlag = (flags: Flags, word: Word, next: Word | undefined): FlagRead | Unreadable | undefined => {
    if (word.text.startsWith("--")) {
        return readLong(flags, word, next);
    }
    return word.text.startsWith("-") && word.text.length > 1 ? readShort(flags, word, next) : undefined;
};

export interface Parsed {
    readonly positionals: readonly Word[];
    readonly values: readonly { readonly name: string; readonly word: Word }[];
}

// Reads one program's arguments against its table; `--` ends the options.
export const parseFlags = (args: readonly Word[], flags: Flags): Parsed | Unreadable => {
    const positionals: Word[] = [];
    const values: { readonly name: string; readonly word: Word }[] = [];
    let index = 0;
    for (let word = args.at(0); word !== undefined; word = args.at(index)) {
        if (word.text === "--") {
            positionals.push(...args.slice(index + 1));
            break;
        }
        const read = readFlag(flags, word, args.at(index + 1));
        if (read !== undefined && "why" in read) {
            return read;
        }
        if (read === undefined) {
            // An expansion at the start may become an option. A fixed prefix such as https:// keeps its positional
            // role; the destination reader can then explain the unknown host. Known option values are consumed above.
            if (word.dynamic && word.text.startsWith("$")) {
                return { why: "a shell variable or expansion in it is only filled in when it runs" };
            }
            if (word.text.startsWith(STAND_IN)) {
                return { why: "an option or argument is filled in by the secret when it runs" };
            }
            positionals.push(word);
        } else if (read.value !== undefined) {
            values.push(read.value);
        }
        index += 1 + (read?.skip ?? 0);
    }
    return { positionals, values };
};
