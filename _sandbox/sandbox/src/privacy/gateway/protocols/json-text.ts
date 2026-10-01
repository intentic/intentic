import { tokenPattern } from "../../tokens.js";
import type { RestoreText } from "../shield-types.js";
import { isText, parseJson, type MaskText, maskText } from "./walk.js";

// Tool arguments travel as JSON TEXT (OpenAI's `arguments`, Anthropic's streamed `partial_json`), so masking and
// restoring them must leave valid JSON behind. Parsing and re-serializing would do that, but it would also rewrite the
// model's bytes (whitespace, `1.0`, integers past 2^53), so these work on the string literals in place instead.

// One JSON string literal, escapes included, written as an unrolled loop so a megabyte-long literal is one linear pass.
// Scanning valid JSON from its start, every match is a whole literal: outside a literal JSON has no quote character.
const LITERAL = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"/gu;

// Cheap pre-check, so text that holds no token (most of it) is returned without being scanned.
const mayHoldToken = (text: string): boolean => text.includes("⟦") || text.includes("[[") || /\\u27e6/iu.test(text);

const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);

// A literal is a key when the next thing after it is a colon.
const isKeyAt = (text: string, end: number): boolean => {
    let at = end;
    while (/\s/u.test(text.charAt(at))) {
        at += 1;
    }
    return text.charAt(at) === ":";
};

// The value a literal spells, its tokens restored, re-encoded only when something changed.
const restoreLiteral = (literal: string, restore: RestoreText): string => {
    if (!mayHoldToken(literal)) {
        return literal;
    }
    const decoded = parseJson(literal);
    if (!isText(decoded)) {
        return literal;
    }
    const restored = restore(decoded);
    return restored === decoded ? literal : JSON.stringify(restored);
};

// Tokens in model-written JSON text back to their values, in string VALUES only (keys are structure, and the request
// side never masked them). Text that does not parse (arguments cut off by max_tokens) has each token replaced in place,
// JSON-escaped, since a model only ever writes a token inside a string.
export const restoreJsonText = (raw: string, restore: RestoreText): string => {
    if (!mayHoldToken(raw)) {
        return raw;
    }
    if (parseJson(raw) === undefined) {
        return raw.replace(tokenPattern(), (token) => escaped(restore(token)));
    }
    return raw.replace(LITERAL, (literal: string, offset: number) =>
        isKeyAt(raw, offset + literal.length) ? literal : restoreLiteral(literal, restore),
    );
};

// Each literal masked on its own, for when masking the whole text broke its syntax.
const maskLiterals = async (raw: string, mask: MaskText): Promise<string> => {
    const literals = [...raw.matchAll(LITERAL)];
    const masked = await Promise.all(
        literals.map(async ([literal]) => {
            const decoded = parseJson(literal);
            if (!isText(decoded)) {
                return literal;
            }
            const next = await maskText(decoded, mask);
            return next === decoded ? literal : JSON.stringify(next);
        }),
    );
    let out = "";
    let at = 0;
    literals.forEach((match, index) => {
        out += raw.slice(at, match.index) + (masked[index] ?? match[0]);
        at = match.index + match[0].length;
    });
    return out + raw.slice(at);
};

// JSON text bound for the provider, masked as one string so the masker reads every field in context. A masker that
// cuts through an escape sequence (`\n`, `\u0142`) would leave JSON the provider may refuse; then each literal is masked
// on its own instead, keys included, as the whole-text pass would have.
export const maskJsonText = async (raw: string, mask: MaskText): Promise<string> => {
    const masked = await maskText(raw, mask);
    if (masked === raw || parseJson(masked) !== undefined || parseJson(raw) === undefined) {
        return masked;
    }
    return maskLiterals(raw, mask);
};
