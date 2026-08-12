/* ONE CONDITION LANGUAGE, WRITTEN AS A STRING — the thing a surface can put in a manifest and a different
 * tier can evaluate.
 *
 * Every conditional affordance in this product used to invent its own shape. Capability fields gated on
 * `{ key, value }` — a single equality, and the check was written TWICE, once in the web form and once in the
 * daemon's install validation, which is two copies of one rule with nothing holding them together. Commands
 * gated on a `(event) => boolean` closure, which cannot be written down: an extension declares its
 * contributions in JSON, so a predicate that only exists as JavaScript in the shell meant extension commands
 * could have no condition at all, and the keybindings page had nothing to show a user about when a chord
 * applies.
 *
 * A parsed string fixes all three at once. It serializes, so a manifest can carry it and the install dialog
 * can print it. It parses to a tree, so a malformed condition is a manifest error at parse time rather than a
 * gate that is quietly false forever. And it is evaluated by one function, so the web and the daemon cannot
 * disagree about what a card's form is asking for.
 *
 * WHAT IT DELIBERATELY IS NOT is a general expression language. There is no arithmetic, no function call, no
 * property access on a value, and no way to reach anything the caller did not put in the context object. The
 * grammar below is the whole of it, and the reason to keep it there is that these strings arrive from
 * installed extensions: a condition that cannot compute cannot be a way in.
 *
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := unary ( '&&' unary )*
 *   unary   := '!' unary | '(' expr ')' | comparison | key
 *   comparison := key ( '==' | '!=' | '>' | '>=' | '<' | '<=' ) literal
 *               | key ( 'in' | 'not in' ) '[' literal ( ',' literal )* ']'
 *   key     := [A-Za-z_][A-Za-z0-9_.-]*
 *   literal := 'single-quoted' | "double-quoted" | number | true | false
 *
 * A bare `key` is a truthiness test, which is what makes the common case short: `chatFocused` rather than
 * `chatFocused == true`. `in` takes a LITERAL list rather than VS Code's second context key, because every
 * condition this product actually needs is "is the value one of these few" and a list says that at the site
 * where it is read.
 */

export type WhenValue = string | number | boolean;

export type WhenExpression =
    | { readonly kind: "has"; readonly key: string }
    | { readonly kind: "not"; readonly operand: WhenExpression }
    | { readonly kind: "compare"; readonly key: string; readonly op: CompareOp; readonly value: WhenValue }
    | { readonly kind: "member"; readonly key: string; readonly values: readonly WhenValue[]; readonly negated: boolean }
    | { readonly kind: "and"; readonly operands: readonly WhenExpression[] }
    | { readonly kind: "or"; readonly operands: readonly WhenExpression[] };

export type CompareOp = "==" | "!=" | ">" | ">=" | "<" | "<=";

/* Why a named error rather than a bare `Error`: the two callers want different things from a bad condition.
 * The manifest schema turns it into a field-level validation message an extension author reads; the shell's
 * command registry lets it throw, because a builtin with an unparseable condition is a bug in this repo and
 * failing loudly at registration is how it gets found before anyone ships it. */
export class WhenSyntaxError extends Error {
    constructor(
        message: string,
        readonly source: string,
        readonly offset: number,
    ) {
        super(`${message} (in \`${source}\` at ${offset})`);
        this.name = "WhenSyntaxError";
    }
}

type Token =
    | { readonly kind: "key"; readonly text: string; readonly at: number }
    | { readonly kind: "literal"; readonly value: WhenValue; readonly at: number }
    | { readonly kind: "punct"; readonly text: Punct; readonly at: number };

type Punct = "(" | ")" | "[" | "]" | "," | "!" | "&&" | "||" | "==" | "!=" | ">=" | "<=" | ">" | "<" | "in" | "not";

// Longest-first, so `>=` is never read as `>` followed by a stray `=` and `!=` never as `!` followed by one.
const OPERATORS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "(", ")", "[", "]", ",", "!"] as const;

const KEY_START = /[A-Za-z_]/;
const KEY_BODY = /[A-Za-z0-9_.-]/;

const scan = (source: string): Token[] => {
    const tokens: Token[] = [];
    let at = 0;
    while (at < source.length) {
        const char = source[at] ?? "";
        if (char.trim() === "") {
            at += 1;
            continue;
        }
        if (char === "'" || char === `"`) {
            const close = source.indexOf(char, at + 1);
            if (close === -1) {
                throw new WhenSyntaxError("unterminated string", source, at);
            }
            tokens.push({ kind: "literal", value: source.slice(at + 1, close), at });
            at = close + 1;
            continue;
        }
        const operator = OPERATORS.find((candidate) => source.startsWith(candidate, at));
        if (operator !== undefined) {
            tokens.push({ kind: "punct", text: operator, at });
            at += operator.length;
            continue;
        }
        if (/[0-9]/.test(char)) {
            const digits = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(at))?.[0] ?? "";
            tokens.push({ kind: "literal", value: Number(digits), at });
            at += digits.length;
            continue;
        }
        if (KEY_START.test(char)) {
            let end = at + 1;
            while (end < source.length && KEY_BODY.test(source[end] ?? "")) {
                end += 1;
            }
            const word = source.slice(at, end);
            // `true`/`false` are values wherever they appear, and `in`/`not` are operators — a key may not be
            // spelled any of them, which is why they are decided here rather than by the parser peeking.
            if (word === "true" || word === "false") {
                tokens.push({ kind: "literal", value: word === "true", at });
            } else if (word === "in" || word === "not") {
                tokens.push({ kind: "punct", text: word, at });
            } else {
                tokens.push({ kind: "key", text: word, at });
            }
            at = end;
            continue;
        }
        throw new WhenSyntaxError(`unexpected character ${JSON.stringify(char)}`, source, at);
    }
    return tokens;
};

class Parser {
    private index = 0;

    constructor(
        private readonly tokens: readonly Token[],
        private readonly source: string,
    ) {}

    parse(): WhenExpression {
        const expression = this.or();
        const trailing = this.tokens[this.index];
        if (trailing !== undefined) {
            throw new WhenSyntaxError("unexpected trailing input", this.source, trailing.at);
        }
        return expression;
    }

    private or(): WhenExpression {
        const first = this.and();
        if (!this.at("||")) {
            return first;
        }
        const operands = [first];
        while (this.eat("||")) {
            operands.push(this.and());
        }
        return { kind: "or", operands };
    }

    private and(): WhenExpression {
        const first = this.unary();
        if (!this.at("&&")) {
            return first;
        }
        const operands = [first];
        while (this.eat("&&")) {
            operands.push(this.unary());
        }
        return { kind: "and", operands };
    }

    private unary(): WhenExpression {
        if (this.eat("!")) {
            return { kind: "not", operand: this.unary() };
        }
        if (this.eat("(")) {
            const inner = this.or();
            this.expect(")");
            return inner;
        }
        const token = this.tokens[this.index];
        if (token?.kind !== "key") {
            throw new WhenSyntaxError("expected a context key", this.source, token?.at ?? this.source.length);
        }
        this.index += 1;
        return this.tail(token.text);
    }

    // What follows a key decides which of the three shapes it is: a comparison, a membership test, or — when
    // nothing follows that belongs to it — the bare truthiness test.
    private tail(key: string): WhenExpression {
        for (const op of ["==", "!=", ">=", "<=", ">", "<"] as const) {
            if (this.eat(op)) {
                return { kind: "compare", key, op, value: this.literal() };
            }
        }
        if (this.eat("in")) {
            return { kind: "member", key, values: this.list(), negated: false };
        }
        if (this.at("not")) {
            this.index += 1;
            this.expect("in");
            return { kind: "member", key, values: this.list(), negated: true };
        }
        return { kind: "has", key };
    }

    private list(): readonly WhenValue[] {
        this.expect("[");
        const values = [this.literal()];
        while (this.eat(",")) {
            values.push(this.literal());
        }
        this.expect("]");
        return values;
    }

    private literal(): WhenValue {
        const token = this.tokens[this.index];
        if (token?.kind !== "literal") {
            throw new WhenSyntaxError("expected a literal value", this.source, token?.at ?? this.source.length);
        }
        this.index += 1;
        return token.value;
    }

    private at(punct: Punct): boolean {
        const token = this.tokens[this.index];
        return token?.kind === "punct" && token.text === punct;
    }

    private eat(punct: Punct): boolean {
        if (!this.at(punct)) {
            return false;
        }
        this.index += 1;
        return true;
    }

    private expect(punct: Punct): void {
        if (!this.eat(punct)) {
            throw new WhenSyntaxError(`expected \`${punct}\``, this.source, this.tokens[this.index]?.at ?? this.source.length);
        }
    }
}

/* Parse once, hold the result. Every caller here registers its conditions (a command at registration, a
 * capability field when its manifest is read) rather than re-parsing per evaluation, so there is no cache in
 * this module to grow: the parsed trees live exactly as long as the things that declared them. */
export const parseWhen = (source: string): WhenExpression => new Parser(scan(source), source).parse();

/* Truthiness for a context key, spelled out because the interesting cases are the falsy ones. An ABSENT key is
 * false — a condition naming a key nobody publishes is a condition that does not hold, never a crash, which is
 * what lets an extension name a key a newer host would have. Empty string and 0 are false for the same reason
 * they are in JavaScript: a surface publishing `selectionSize: 0` means "nothing selected", and having to
 * write `selectionSize > 0` for that would be a trap rather than a distinction. */
const truthy = (value: unknown): boolean => value !== undefined && value !== null && value !== false && value !== "" && value !== 0;

/* Comparison across the type boundary, because context values are whatever a surface publishes and literals
 * are whatever an author typed. `mode == 'strict'` must hold for the string, and `enabled == true` for the
 * boolean — but so must `count == 3` when a surface publishes the number and the author wrote the number.
 * Same type compares directly; mixed types compare their string forms, which is the only reading of
 * `enabled == 'true'` that isn't a silent no. */
const equal = (actual: unknown, expected: WhenValue): boolean =>
    typeof actual === typeof expected ? actual === expected : String(actual) === String(expected);

// Ordering only means something between two numbers. A `>` against anything else (an absent key, a string) is
// false rather than a coercion — `version > 3` on a missing key must not read as `NaN > 3` throwing, nor as
// JavaScript's `'10' > '9' === false`, which is the bug this refuses to have.
const ordered = (actual: unknown, expected: WhenValue, op: CompareOp): boolean => {
    if (typeof actual !== "number" || typeof expected !== "number") {
        return false;
    }
    if (op === ">") {
        return actual > expected;
    }
    if (op === ">=") {
        return actual >= expected;
    }
    if (op === "<") {
        return actual < expected;
    }
    return actual <= expected;
};

export type WhenContext = Readonly<Record<string, unknown>>;

export const evaluateWhen = (expression: WhenExpression, context: WhenContext): boolean => {
    if (expression.kind === "has") {
        return truthy(context[expression.key]);
    }
    if (expression.kind === "not") {
        return !evaluateWhen(expression.operand, context);
    }
    if (expression.kind === "and") {
        return expression.operands.every((operand) => evaluateWhen(operand, context));
    }
    if (expression.kind === "or") {
        return expression.operands.some((operand) => evaluateWhen(operand, context));
    }
    if (expression.kind === "member") {
        const hit = expression.values.some((value) => equal(context[expression.key], value));
        return expression.negated ? !hit : hit;
    }
    if (expression.op === "==") {
        return equal(context[expression.key], expression.value);
    }
    if (expression.op === "!=") {
        return !equal(context[expression.key], expression.value);
    }
    return ordered(context[expression.key], expression.value, expression.op);
};

/* Whether a string is a condition this module can evaluate — the shape a schema wants, where the parse error
 * itself is not the message to show. Used by the manifest schemas so an extension declaring a broken
 * condition is refused at install with the field named, rather than installed with a gate that never opens. */
export const isWhenExpression = (source: string): boolean => {
    try {
        parseWhen(source);
        return true;
    } catch {
        return false;
    }
};

/* Every context key a condition reads. The keybindings page uses it to explain a chord that is not firing
 * ("waiting on: chatFocused"), and it is what a test can use to hold a surface's published keys and its
 * declared conditions to each other without either side keeping a list. */
export const whenKeys = (expression: WhenExpression): readonly string[] => {
    if (expression.kind === "has" || expression.kind === "compare" || expression.kind === "member") {
        return [expression.key];
    }
    if (expression.kind === "not") {
        return whenKeys(expression.operand);
    }
    return [...new Set(expression.operands.flatMap((operand) => whenKeys(operand)))];
};
