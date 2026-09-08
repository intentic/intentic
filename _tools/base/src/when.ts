// One condition language, a string a manifest can carry and any tier can evaluate identically. Deliberately not a
// general expression language: no arithmetic, no function calls, no property access, only what the grammar below
// allows, since these strings arrive from installed extensions.
// expr := or
// or := and ( '||' and )*
// and := unary ( '&&' unary )*
// unary := '!' unary | '(' expr ')' | comparison | key
// comparison := key ( '==' | '!=' | '>' | '>=' | '<' | '<=' ) literal
//             | key ( 'in' | 'not in' ) '[' literal ( ',' literal )* ']'
// key := [A-Za-z_][A-Za-z0-9_.-]*
// literal := 'single-quoted' | "double-quoted" | number | true | false

export type WhenValue = string | number | boolean;

export type WhenExpression =
    | { readonly kind: "has"; readonly key: string }
    | { readonly kind: "not"; readonly operand: WhenExpression }
    | { readonly kind: "compare"; readonly key: string; readonly op: CompareOp; readonly value: WhenValue }
    | { readonly kind: "member"; readonly key: string; readonly values: readonly WhenValue[]; readonly negated: boolean }
    | { readonly kind: "and"; readonly operands: readonly WhenExpression[] }
    | { readonly kind: "or"; readonly operands: readonly WhenExpression[] };

export type CompareOp = "==" | "!=" | ">" | ">=" | "<" | "<=";

// A named error, not a bare `Error`: the manifest schema turns it into a field-level validation message; the command
// registry lets it throw, since an unparseable builtin condition is a bug to catch at registration.
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
            // `true`/`false` and `in`/`not` are reserved words; a key cannot be spelled any of them.
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

    // What follows a key decides its shape: a comparison, a membership test, or, with nothing after it, bare
    // truthiness.
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

// Parses once; every caller registers its condition (a command, a capability field) rather than re-parsing per
// evaluation, so there is no cache to grow here.
export const parseWhen = (source: string): WhenExpression => new Parser(scan(source), source).parse();

// An absent key is false, never a throw, so an extension can name a key a newer host has not published yet. Empty
// string and 0 are false too, as in JavaScript, so `selectionSize: 0` needs no `> 0`.
const truthy = (value: unknown): boolean => value !== undefined && value !== null && value !== false && value !== "" && value !== 0;

// Compares across the type boundary: same type compares directly, mixed types compare string forms, the only reading of
// `enabled == 'true'` that is not a silent no.
const equal = (actual: unknown, expected: WhenValue): boolean =>
    typeof actual === typeof expected ? actual === expected : String(actual) === String(expected);

// Ordering only means something between two numbers; anything else is false rather than a coercion, avoiding both a
// `NaN` throw and JavaScript's `'10' > '9' === false`.
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

// Whether a string is a condition this module can evaluate; used by the manifest schemas to refuse a broken condition
// at install, field named, rather than install a gate that never opens.
export const isWhenExpression = (source: string): boolean => {
    try {
        parseWhen(source);
        return true;
    } catch {
        return false;
    }
};

// Every context key a condition reads; used to explain a chord that is not firing ("waiting on: chatFocused") and to
// check a surface's published keys against its declared conditions.
export const whenKeys = (expression: WhenExpression): readonly string[] => {
    if (expression.kind === "has" || expression.kind === "compare" || expression.kind === "member") {
        return [expression.key];
    }
    if (expression.kind === "not") {
        return whenKeys(expression.operand);
    }
    return [...new Set(expression.operands.flatMap((operand) => whenKeys(operand)))];
};
