/* RTF as a stream of tokens. The file is read as latin-1 so every code unit is exactly one byte: a \'hh escape and a
   raw high byte then decode the same way, through whatever code page the document declares. */

export type RtfToken =
    | { readonly kind: "group-start" }
    | { readonly kind: "group-end" }
    // `\word5` — `value` is undefined when the word carries no number.
    | { readonly kind: "word"; readonly word: string; readonly value?: number }
    // A raw byte, from `\'hh` or from text outside ASCII.
    | { readonly kind: "byte"; readonly byte: number }
    | { readonly kind: "text"; readonly text: string }
    // `\bin` payload, already skipped over: its length is all a renderer needs.
    | { readonly kind: "binary"; readonly length: number };

const isLetter = (code: number): boolean => (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/** `bytes` as one code unit per byte, which is what the tokenizer walks. */
export const asLatin1 = (bytes: Uint8Array): string => new TextDecoder(`iso-8859-1`).decode(bytes);

interface Escape {
    readonly token: RtfToken;
    readonly next: number;
}

const HEX = 16;

const LITERALS = new Set([`\\`, `{`, `}`]);

const readControlWord = (source: string, start: number): Escape => {
    let cursor = start;
    while (isLetter(source.charCodeAt(cursor))) {
        cursor += 1;
    }
    const word = source.slice(start, cursor);
    const numberStart = cursor;
    if (source[cursor] === `-`) {
        cursor += 1;
    }
    while (isDigit(source.charCodeAt(cursor))) {
        cursor += 1;
    }
    const value = Number.parseInt(source.slice(numberStart, cursor), 10);
    // A single space after a control word is its delimiter and not part of the text.
    const next = source[cursor] === ` ` ? cursor + 1 : cursor;
    return { token: { kind: `word`, word, value: Number.isFinite(value) ? value : undefined }, next };
};

// Everything after a backslash: a control word, a control symbol, or an escaped literal.
const readEscape = (source: string, start: number): Escape => {
    const first = source[start];
    if (first === undefined) {
        return { token: { kind: `text`, text: `` }, next: start };
    }
    if (first === `'`) {
        const byte = Number.parseInt(source.slice(start + 1, start + 3), HEX);
        return { token: { kind: `byte`, byte: Number.isFinite(byte) ? byte : 0 }, next: start + 3 };
    }
    if (isLetter(source.charCodeAt(start))) {
        return readControlWord(source, start);
    }
    // \\ \{ \} are literals; \* \~ \- and friends are control symbols, which read as one-letter words.
    return { token: LITERALS.has(first) ? { kind: `text`, text: first } : { kind: `word`, word: first }, next: start + 1 };
};

// A backslash and what follows it. `\bin`'s payload is skipped here, since only the tokenizer knows how far it runs
// and a renderer reading it as text would show a screenful of noise.
const consumeEscape = (source: string, position: number, emit: (token: RtfToken) => void, write: (chunk: string) => void): number => {
    const escape = readEscape(source, position + 1);
    if (escape.token.kind === `text`) {
        write(escape.token.text);
        return escape.next;
    }
    if (escape.token.kind === `word` && escape.token.word === `bin`) {
        const length = Math.max(0, escape.token.value ?? 0);
        emit({ kind: `binary`, length });
        return escape.next + length;
    }
    emit(escape.token);
    return escape.next;
};

// Everything that is not ordinary text; a line break inside an RTF file is formatting OF THE FILE, not of the
// document, and carries nothing.
const SPECIAL = new Set([`{`, `}`, `\\`, `\r`, `\n`]);

/** Tokens in document order. */
export const tokenize = (source: string): RtfToken[] => {
    const tokens: RtfToken[] = [];
    let position = 0;
    let text = ``;
    const flush = (): void => {
        if (text !== ``) {
            tokens.push({ kind: `text`, text });
            text = ``;
        }
    };
    const emit = (token: RtfToken): void => {
        flush();
        tokens.push(token);
    };
    const write = (chunk: string): void => {
        text += chunk;
    };

    while (position < source.length) {
        const char = source[position] ?? ``;
        if (!SPECIAL.has(char)) {
            text += char;
            position += 1;
            continue;
        }
        if (char === `\\`) {
            position = consumeEscape(source, position, emit, write);
            continue;
        }
        if (char === `{` || char === `}`) {
            emit({ kind: char === `{` ? `group-start` : `group-end` });
        }
        position += 1;
    }
    flush();
    return tokens;
};
