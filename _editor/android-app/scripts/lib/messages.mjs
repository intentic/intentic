// One vue-i18n message as Android string resources take it. A message is plain text with `{name}` placeholders, `{'x'}`
// literals (how the catalogs escape `@`, `{` and `|`), and `|` between the forms of a plural. Linked messages (`@:key`)
// have no Android equivalent and stop the run, as does anything else this does not read.

// One `{…}` at `at`: a literal's text, or a placeholder's name, and where the brace closes.
const brace = (message, at) => {
    const close = message.indexOf(`}`, at);
    if (close === -1) {
        throw new Error(`an unclosed { in ${JSON.stringify(message)}`);
    }
    const inner = message.slice(at + 1, close).trim();
    const literal = inner.match(/^'([^']*)'$/);
    if (literal !== null) {
        return { piece: { text: literal[1] }, end: close };
    }
    if (/^[\w.]+$/.test(inner)) {
        return { piece: { name: inner }, end: close };
    }
    throw new Error(`no Android reading for {${inner}} in ${JSON.stringify(message)}`);
};

// Text runs together into one piece, so a literal reads as part of the words around it.
const append = (form, piece) => {
    const last = form.at(-1);
    if (piece.text !== undefined && last?.text !== undefined) {
        form[form.length - 1] = { text: last.text + piece.text };
    } else {
        form.push(piece);
    }
};

// A plural's forms are written `a | b`: the spaces around the bar belong to it, not to either form.
const trimmed = (form) =>
    form.map((piece, i) => {
        if (piece.text === undefined) {
            return piece;
        }
        const start = i === 0 ? piece.text.trimStart() : piece.text;
        return { text: i === form.length - 1 ? start.trimEnd() : start };
    });

/** The message's forms (one unless it is a plural), each a list of `{ text }` and `{ name }` pieces. */
export const parse = (message) => {
    const forms = [[]];
    for (let i = 0; i < message.length; i++) {
        const char = message[i];
        if (char === `{`) {
            const { piece, end } = brace(message, i);
            append(forms.at(-1), piece);
            i = end;
        } else if (char === `|`) {
            forms.push([]);
        } else if (char === `@` && /[:.]/.test(message[i + 1] ?? ``)) {
            throw new Error(`a linked message has no Android equivalent: ${JSON.stringify(message)}`);
        } else {
            append(forms.at(-1), { text: char });
        }
    }
    return forms.length > 1 ? forms.map(trimmed) : forms;
};

/** Each placeholder's position, numbered from 1 in the order the names first appear across `forms`. */
export const positions = (forms) => {
    const order = new Map();
    for (const piece of forms.flat()) {
        if (piece.name !== undefined && !order.has(piece.name)) {
            order.set(piece.name, order.size + 1);
        }
    }
    return order;
};

// The characters an Android string resource reads specially: XML's own, the backslash escapes aapt2 decodes, and `%`,
// which String.format reads in a resource that takes arguments.
const escapeText = (text, formatted) =>
    text
        .replaceAll(`\\`, `\\\\`)
        .replaceAll(`&`, `&amp;`)
        .replaceAll(`<`, `&lt;`)
        .replaceAll(`>`, `&gt;`)
        .replaceAll(`'`, `\\'`)
        .replaceAll(`"`, `\\"`)
        .replaceAll(`\n`, `\\n`)
        .replaceAll(`\t`, `\\t`)
        .replaceAll(`%`, formatted ? `%%` : `%`);

/**
 * One form as resource text: names become `%<position>$s`, and the rest is escaped. A leading `@` or `?` would read as
 * a reference, so it is escaped too, and text whose spaces aapt2 would collapse is quoted.
 */
export const render = (form, order, formatted) => {
    const body = form
        .map((piece) => {
            if (piece.text !== undefined) {
                return escapeText(piece.text, formatted);
            }
            const position = order.get(piece.name);
            if (position === undefined) {
                throw new Error(`{${piece.name}} is not a placeholder of the English message`);
            }
            return `%${position}$s`;
        })
        .join(``);
    const referenced = /^[@?]/.test(body) ? `\\${body}` : body;
    return /^\s|\s$| {2}/.test(referenced) ? `"${referenced}"` : referenced;
};

/** `auth.login.welcomeToIntentic` → `auth_login_welcome_to_intentic`, a resource name. */
export const resourceName = (key) => {
    const name = key.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replaceAll(/[.-]/g, `_`);
    if (!/^[a-z][a-z\d_]*$/.test(name)) {
        throw new Error(`${key} makes no resource name (${name})`);
    }
    return name;
};
