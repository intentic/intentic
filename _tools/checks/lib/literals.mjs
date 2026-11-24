// Which of many regexes can match a text, decided without running them: each regex's REQUIRED LITERALS (strings one of
// which every match must contain), found together in one pass of an Aho–Corasick automaton. The regexes a text cannot
// match are skipped; the rest are run as before, so a regex is never judged by anything but itself.
//
// LITERALS BEFORE REGEXES (2026-11-24). The vocabulary check tested its 21 retired-word patterns against every line of
// the 120 million characters it reads, 4.5 s of each turn's checks, to find words in 3 files. irregexp tries every
// alternative at every position, so even one combined pattern took 1.9 s. Required literals scanned once by a
// precomputed automaton cost about 0.3 s, the approach of ripgrep and Hyperscan: a literal is a necessary condition,
// never a sufficient one, so it is sound for any regex, anchors and lookarounds included.

// The most strings a product of a sequence's terms may hold, and the most a union of alternatives may: past either a
// set is read as unknown, which costs its regex the skip and nothing else.
const LIMIT = 256;
const UNION_LIMIT = 4096;

// A node's reading: `exact`, every string it can match, when that set is finite and small, else null; `need`, strings
// one of which every match contains, else null. An assertion matches only the empty string, so a sequence's sets pass
// through it, and every set not known for certain is null, which only costs a regex its skip, never a finding.
const UNKNOWN = { exact: null, need: null };
const EMPTY = { exact: new Set([""]), need: null };
const exactly = (strings) => ({ exact: strings, need: [...strings].every((string) => string !== "") ? strings : null });

const product = (left, right) => {
    if (left.size * right.size > LIMIT) {
        return null;
    }
    const joined = new Set();
    for (const a of left) {
        for (const b of right) {
            joined.add(a + b);
        }
    }
    return joined;
};

// The narrower of two requirement sets: the longer shortest string, then the fewer strings.
const shortest = (set) => Math.min(...[...set].map((string) => string.length));
const narrower = (a, b) => {
    if (a === null) {
        return b;
    }
    if (b === null) {
        return a;
    }
    const [x, y] = [shortest(a), shortest(b)];
    return x > y || (x === y && a.size <= b.size) ? a : b;
};

// Escapes that stand for one fixed character outside a class; any other escape of a letter or digit means a class, a
// backreference or a construct this reader leaves unknown.
const CONTROL = { n: "\n", r: "\r", t: "\t", v: "\v", f: "\f" };
const SYNTAX = new Set("^$\\.*+?()[]{}|/-");

// `atom` matched between `min` and `max` times: a requirement whenever it must match at least once, and every string
// it can match while few enough repetitions keep the set small.
const repeated = (atom, min, max) => {
    const need = min >= 1 ? narrower(atom.need, atom.exact !== null && !atom.exact.has("") ? atom.exact : null) : null;
    if (atom.exact === null || max > 4) {
        return { exact: null, need };
    }
    let exact = new Set();
    let power = new Set([""]);
    for (let count = 0; count <= max && power !== null; count += 1) {
        if (count >= min) {
            exact = new Set([...exact, ...power]);
        }
        power = count < max ? product(power, atom.exact) : power;
    }
    return power === null || exact.size > LIMIT ? { exact: null, need } : { exact, need: narrower(need, exactly(exact).need) };
};

class Reader {
    constructor(source) {
        this.source = source;
        this.at = 0;
    }

    peek(offset = 0) {
        return this.source[this.at + offset];
    }

    fail() {
        throw new SyntaxError(`unread regex syntax at ${String(this.at)}`);
    }

    disjunction() {
        const alternatives = [this.alternative()];
        while (this.peek() === "|") {
            this.at += 1;
            alternatives.push(this.alternative());
        }
        if (alternatives.length === 1) {
            return alternatives[0];
        }
        const exact = alternatives.every((node) => node.exact !== null) ? new Set(alternatives.flatMap((node) => [...node.exact])) : null;
        const needs = alternatives.map((node) => narrower(node.need, node.exact !== null && !node.exact.has("") ? node.exact : null));
        const need = needs.includes(null) ? null : new Set(needs.flatMap((set) => [...set]));
        return {
            exact: exact !== null && exact.size <= LIMIT ? exact : null,
            need: need !== null && need.size <= UNION_LIMIT ? need : null,
        };
    }

    // A sequence: runs of terms with known strings are multiplied out, and the narrowest of every closed run and every
    // other term's own requirement is the sequence's, since each of them is matched in full by every match.
    alternative() {
        let run = new Set([""]);
        let whole = true;
        let need = null;
        const close = () => {
            if (![...run].includes("")) {
                need = narrower(need, run);
            }
        };
        while (this.at < this.source.length && this.peek() !== "|" && this.peek() !== ")") {
            const term = this.term();
            const joined = term.exact === null ? null : product(run, term.exact);
            if (joined !== null) {
                run = joined;
                continue;
            }
            whole = false;
            close();
            need = narrower(need, term.need);
            run = term.exact !== null && term.exact.size <= LIMIT ? term.exact : new Set([""]);
        }
        close();
        return { exact: whole ? run : null, need };
    }

    term() {
        const atom = this.atom();
        return this.quantified(atom);
    }

    // A quantifier's bounds as [min, max], consumed with any lazy `?`; undefined when none follows, and for a `{` that
    // is no quantifier, which atom() then reads as the literal it is.
    bounds() {
        const next = this.peek();
        let range;
        if (next === "?" || next === "*" || next === "+") {
            this.at += 1;
            range = { "?": [0, 1], "*": [0, Infinity], "+": [1, Infinity] }[next];
        } else if (next === "{") {
            const braces = /^\{(\d+)(,(\d*))?\}/u.exec(this.source.slice(this.at));
            if (braces === null) {
                return undefined;
            }
            this.at += braces[0].length;
            const min = Number(braces[1]);
            range = [min, braces[2] === undefined ? min : braces[3] === "" ? Infinity : Number(braces[3])];
        } else {
            return undefined;
        }
        if (this.peek() === "?") {
            this.at += 1; // lazy matches the same strings
        }
        return range;
    }

    quantified(atom) {
        const range = this.bounds();
        return range === undefined ? atom : repeated(atom, range[0], range[1]);
    }

    atom() {
        const char = this.peek();
        this.at += 1;
        if (char === "^" || char === "$") {
            return EMPTY;
        }
        if (char === ".") {
            return UNKNOWN;
        }
        if (char === "(") {
            return this.group();
        }
        if (char === "[") {
            return this.characterClass();
        }
        if (char === "\\") {
            return this.escape();
        }
        if (char === "*" || char === "+" || char === "?" || char === ")" || char === undefined) {
            this.fail();
        }
        return exactly(new Set([char]));
    }

    group() {
        let assertion = false;
        if (this.peek() === "?") {
            const opener = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/u.exec(this.source.slice(this.at));
            if (opener === null) {
                this.fail();
            }
            this.at += opener[0].length;
            assertion = /^\?(?:=|!|<=|<!)$/u.test(opener[0]);
        }
        const inner = this.disjunction();
        if (this.peek() !== ")") {
            this.fail();
        }
        this.at += 1;
        return assertion ? EMPTY : inner;
    }

    escape() {
        const char = this.peek();
        this.at += 1;
        if (char === "b" || char === "B") {
            return EMPTY;
        }
        if (char in CONTROL) {
            return exactly(new Set([CONTROL[char]]));
        }
        if (char === "x" || char === "u") {
            const digits = /^[\da-fA-F]+/u.exec(this.source.slice(this.at, this.at + (char === "x" ? 2 : 4)))?.[0];
            if (digits?.length === (char === "x" ? 2 : 4)) {
                this.at += digits.length;
                return exactly(new Set([String.fromCharCode(Number.parseInt(digits, 16))]));
            }
            return UNKNOWN;
        }
        if (char !== undefined && SYNTAX.has(char)) {
            return exactly(new Set([char]));
        }
        // `\cJ` is one control character, and `\12` may be one octal one: what follows is not text of its own.
        if (char === "c") {
            this.fail();
        }
        if (char !== undefined && /\d/u.test(char)) {
            this.at += /^\d*/u.exec(this.source.slice(this.at))[0].length;
        }
        if (char === "k" && this.peek() === "<") {
            this.at = this.source.indexOf(">", this.at) + 1 || this.source.length;
        }
        // A class (\d \w \s and kin), a backreference, an octal, or an identity escape: none narrows anything.
        return UNKNOWN;
    }

    // A small class of plain characters is the set of them; a negated, ranged or escaped one is unknown.
    characterClass() {
        // JavaScript ends a class at its first unescaped `]`: `[]` is empty, and `[]]` is an empty class and a `]`.
        const close = this.source.indexOf("]", this.at);
        if (close === -1) {
            this.fail();
        }
        const body = this.source.slice(this.at, close);
        // A `\` right before the `]` escapes it, and the class reaches further than this reader follows.
        if (body.endsWith("\\")) {
            this.fail();
        }
        this.at = close + 1;
        if (body === "" || body.startsWith("^") || body.includes("\\") || /.-./u.test(body) || body.length > 16) {
            return UNKNOWN;
        }
        return exactly(new Set(body));
    }
}

/**
 * Strings one of which every match of `regex` contains, or undefined when none can be said: flags that change what a
 * literal matches (`i`, `u`, `v`), syntax this reader does not follow, or a pattern some match of which needs no fixed
 * text at all.
 */
export const requiredLiterals = (regex) => {
    if (/[iuv]/u.test(regex.flags)) {
        return undefined;
    }
    const reader = new Reader(regex.source);
    try {
        const node = reader.disjunction();
        if (reader.at !== regex.source.length) {
            return undefined;
        }
        const need = narrower(node.need, node.exact !== null && !node.exact.has("") ? node.exact : null);
        return need === null ? undefined : [...need];
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
};

// Every character a literal uses gets a column of its own; column 0 is every other character.
const columnsOf = (literals) => {
    const columnOf = new Uint16Array(65_536);
    let columns = 1;
    for (const literal of literals) {
        for (let index = 0; index < literal.length; index += 1) {
            const code = literal.charCodeAt(index);
            if (columnOf[code] === 0) {
                columnOf[code] = columns;
                columns += 1;
            }
        }
    }
    return { columnOf, columns };
};

// The trie of every literal, as rows of child states (0 = none) and the groups each state ends.
const trieOf = (groups, { columnOf, columns }) => {
    const rows = [new Int32Array(columns)];
    const ends = [[]];
    for (const [group, literals] of groups.entries()) {
        for (const literal of literals) {
            let state = 0;
            for (let index = 0; index < literal.length; index += 1) {
                const column = columnOf[literal.charCodeAt(index)];
                if (rows[state][column] === 0) {
                    rows[state][column] = rows.length;
                    rows.push(new Int32Array(columns));
                    ends.push([]);
                }
                state = rows[state][column];
            }
            ends[state].push(group);
        }
    }
    return { rows, ends };
};

// Breadth first, Aho–Corasick's failure links folded into the rows: a state's missing moves become its failure state's,
// and its groups take in its failure state's, so a scan never follows a link.
const linkFailures = ({ rows, ends }, columns) => {
    const fail = new Int32Array(rows.length);
    const queue = [...rows[0]].filter((child) => child !== 0);
    for (let head = 0; head < queue.length; head += 1) {
        const state = queue[head];
        ends[state] = [...new Set([...ends[state], ...ends[fail[state]]])];
        for (let column = 0; column < columns; column += 1) {
            const child = rows[state][column];
            if (child === 0) {
                rows[state][column] = rows[fail[state]][column];
            } else {
                fail[child] = rows[fail[state]][column];
                queue.push(child);
            }
        }
    }
};

/**
 * One automaton for every group of literals: `scan(text)` answers which groups have a literal somewhere in `text`, in
 * one pass over its characters. Groups are numbered by their place in `groups`. Built dense, a full row of next states
 * for every state, so the scan does one table read per character.
 */
export const literalScanner = (groups) => {
    const alphabet = columnsOf(groups.flat());
    const { columnOf, columns } = alphabet;
    const trie = trieOf(groups, alphabet);
    linkFailures(trie, columns);
    const table = new Int32Array(trie.rows.length * columns);
    for (const [state, row] of trie.rows.entries()) {
        table.set(row, state * columns);
    }
    const { ends } = trie;
    const accepting = Uint8Array.from(ends, (found) => (found.length > 0 ? 1 : 0));
    return (text) => {
        const found = new Set();
        let state = 0;
        for (let index = 0; index < text.length && found.size < groups.length; index += 1) {
            state = table[state * columns + columnOf[text.charCodeAt(index)]];
            if (accepting[state] === 1) {
                for (const group of ends[state]) {
                    found.add(group);
                }
            }
        }
        return found;
    };
};

/**
 * Which of `regexes` could match somewhere in a text: `candidates(text)` answers their indices in order. A regex whose
 * required literals cannot be said is always a candidate, so the answer never leaves out one that matches.
 */
export const regexPrefilter = (regexes) => {
    const literals = regexes.map(requiredLiterals);
    const known = literals.flatMap((set, index) => (set === undefined ? [] : [index]));
    const scan = literalScanner(known.map((index) => literals[index]));
    const always = regexes.flatMap((_, index) => (literals[index] === undefined ? [index] : []));
    return (text) => {
        const found = scan(text);
        return [...always, ...[...found].map((group) => known[group])].toSorted((a, b) => a - b);
    };
};
