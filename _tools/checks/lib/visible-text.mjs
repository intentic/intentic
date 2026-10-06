/* THE ONE RULE FOR "A LITERAL A READER SEES", read by the check that refuses new ones and by anything that sweeps
   them into a catalog. Two copies of this judgment would disagree the first time somebody tightened one. */

// vue/compiler-sfc's node types, which it numbers rather than names. An element is recognized by what it carries
// (a tag, props, children) rather than by its number, so `1` is not among them.
const TEXT = 2;
const COMMENT = 3;
const EXPRESSION = 4;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

// A tag whose text is not prose: a key cap, a path, a snippet. Translating any of them would be wrong.
const VERBATIM_TAGS = new Set(["code", "pre", "kbd", "samp", "script", "style", "Code", "CodeBlock"]);

// The design system's mark for a code token drawn inline — a config key, a command, a path. Same judgment as <code>,
// which is why the class is read: `<span class="font-mono">edit</span>` is the word the file itself uses.
const VERBATIM_CLASS = /(^|\s)font-mono(\s|$)/;

const verbatimHere = (node) =>
    VERBATIM_TAGS.has(node.tag ?? "") ||
    (node.props ?? []).some((prop) => prop.type === ATTRIBUTE && prop.name === "class" && VERBATIM_CLASS.test(prop.value?.content ?? ""));

// Attributes whose static value is drawn as words. Everything else static is an enum, an icon name, a size or an id —
// which is why `name="times"`, `save="explicit"` and `action="Rebuild"` (a union member HostRecreate switches on) are
// not here, and `title` and `placeholder` are.
export const VISIBLE_ATTRS = new Set([
    "action-label",
    "alt",
    "aria-description",
    "aria-label",
    "aria-placeholder",
    "aria-roledescription",
    "aria-valuetext",
    "cancel-label",
    "caption",
    "confirm-label",
    "count",
    "description",
    "detail",
    "empty",
    "empty-text",
    "header",
    "heading",
    "help",
    "hint",
    "label",
    "legend",
    "message",
    "note",
    "placeholder",
    "prompt",
    "subtitle",
    "summary",
    "title",
    "tooltip",
]);

// Written the same in every language we ship, so extracting one buys a translator nothing and costs the catalog a key.
// Matched case-insensitively: the wordmark is lowercase `intentic` and the sentence about it says Intentic.
const BRANDS = new Set([
    "Anthropic",
    "Android",
    "Bun",
    "Claude",
    "Cloudflare",
    "Codex",
    "Deno",
    "Discord",
    "Docker",
    "Electron",
    "Gemini",
    "GitHub",
    "GitLab",
    "Gmail",
    "Google",
    "Google Drive",
    "Google Workspace",
    "Hermes",
    "Homebrew",
    "Intentic",
    "JSON",
    "Linux",
    "OpenAI",
    "OpenClaw",
    "Playwright",
    "PostHog",
    "Python",
    "React",
    "Rust",
    "Slack",
    "Stripe",
    "Tailwind",
    "Tauri",
    "Telegram",
    "TypeScript",
    "Vite",
    "Vue",
    "WhatsApp",
    "Windows",
    "WSL",
    "YAML",
    "iOS",
    "macOS",
    "node",
    "npm",
    "pnpm",
].map((brand) => brand.toLowerCase()));

// Shapes that only look like text: a token, a path, a filename, a url, an address, a dotted message key.
const NOT_PROSE = [
    /^[a-z0-9]+([-_.:/][a-z0-9]+)+$/,
    // A path or a folder, slash and all: `public/`, `docs/**`, `api/src`.
    /^[\w.*-]+\/[\w.*\-/]*$/,
    /^[\w$]+(\.[\w$]+)+$/,
    /^(https?:|mailto:|[./#$@~])/,
    /^[A-Z][a-z]*(\.[a-z]+)+$/,
    /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/,
];

/**
 * Whether a literal is prose a reader must be able to read in their own language. Rejects what only looks like text:
 * enum values, icon names, css classes, paths, filenames, urls, addresses, and the brands that are the same everywhere.
 *
 * `drawn` says the literal is already on screen — a text node, or a sentence an attribute builds — where a single
 * lowercase word ("stopped", "in this chat") is a word a reader reads. In a bare attribute value the same shape is an
 * enum member (`save="explicit"`, `body="drawer"`), and translating one of those would break the component.
 */
export const isProse = (raw, drawn = false) => {
    const text = raw.trim();
    if (!/\p{L}\p{L}/u.test(text) || BRANDS.has(text.toLowerCase())) {
        return false;
    }
    // Brands side by side, `Linux / macOS`, are as untranslatable as one of them.
    const names = text.split(/\s*[/,&+·|]\s*/);
    if (names.length > 1 && names.every((name) => BRANDS.has(name.toLowerCase()))) {
        return false;
    }
    if (!drawn && /^[a-z][a-zA-Z0-9]*$/.test(text)) {
        return false;
    }
    return !NOT_PROSE.some((shape) => shape.test(text));
};

// The source span of a text node minus its indentation, so a rewrite keeps the whitespace the template is laid out with.
const trimmedSpan = (node) => {
    const raw = node.loc.source;
    const lead = raw.length - raw.trimStart().length;
    const tail = raw.length - raw.trimEnd().length;
    return { start: node.loc.start.offset + lead, end: node.loc.end.offset - tail };
};

// `drawn`: these attribute names are the ones whose value is written for a reader, so `label="unsaved"` is a word on
// screen and not an enum member — the shape a bare attribute elsewhere would have.
const staticAttr = (prop) =>
    prop.type === ATTRIBUTE && prop.value !== undefined && VISIBLE_ATTRS.has(prop.name) && isProse(prop.value.content, true)
        ? [{ kind: "attr", name: prop.name, text: prop.value.content.trim(), start: prop.loc.start.offset, end: prop.loc.end.offset }]
        : [];

// A directive whose argument is drawn as words: `v-tooltip.top="'Zoom out'"` is a label like any other.
const VISIBLE_DIRECTIVES = new Set(["tooltip"]);

// The keys under which an object hands words to whatever draws it: a Notice's `{ tone: \`danger\`, title: \`…\` }`, a
// control's `[{ label: \`Soft\`, value: \`soft\` }]`, a tooltip's `{ title, note }`: the visible attributes, in both
// spellings. `value`, `tone` and `kind` stay out: they are what code switches on.
const camel = (name) => name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
export const VISIBLE_KEYS = new Set([...VISIBLE_ATTRS, ...[...VISIBLE_ATTRS].map(camel)]);

// Bound attributes no word is drawn from, even inside an object: classes, styles, the list key, a ref, and PrimeVue's
// pass-through `pt`, whose `header` is the classes of a header rather than its words.
const NEVER_WORDS = new Set(["class", "style", "key", "ref", "is", "pt"]);

// How a bound expression is read. `drawn` is an expression whose RESULT is on screen (a `{{ }}`, a bound label), so a
// lone lowercase word there is a word a reader reads, not an enum member. `nested` is somewhere inside such an
// expression but not in its result (a call's argument, a condition), where only what plainly reads as prose counts.
// `objects` is any other bound attribute (`:of`, `:options`, `:count` on a component that does not name it a label),
// which is read only through the visible keys of the objects it builds.
const BOUND = (prop) => {
    if (prop.type !== DIRECTIVE || prop.exp?.type !== EXPRESSION) {
        return undefined;
    }
    if (prop.name === "bind") {
        if (prop.arg === undefined || prop.arg === null) {
            return { name: "v-bind", mode: "objects" };
        }
        if (prop.arg.type !== EXPRESSION || !prop.arg.isStatic || NEVER_WORDS.has(prop.arg.content)) {
            return undefined;
        }
        return { name: prop.arg.content, mode: VISIBLE_ATTRS.has(prop.arg.content) ? "drawn" : "objects" };
    }
    return VISIBLE_DIRECTIVES.has(prop.name) ? { name: `v-${prop.name}`, mode: "drawn" } : undefined;
};

// `t`, `$t`, and the same under a receiver (`i18n.t`): the callee shapes a catalog lookup wears.
const isCatalogLookup = (ts, callee) =>
    (ts.isIdentifier(callee) && /^\$?t$/.test(callee.text)) || (ts.isPropertyAccessExpression(callee) && /^\$?t$/.test(callee.name.text));

// Helpers a template hands a sentence to, and which argument: the same notice helpers i18n-literals.mjs reads in code.
const SPOKEN_ARGUMENT = new Map([
    ["noticeOf", 0],
    ["noticeFrom", 1],
]);

// Methods whose arguments are matched against data, never drawn: `kinds.includes(\`running\`)`, `map.get(\`key\`)`.
const MATCHING_METHODS = new Set(["includes", "startsWith", "endsWith", "has", "get", "indexOf", "lastIndexOf", "test", "match", "split", "emit", "$emit"]);

const quiet = (mode) => (mode === "objects" ? "objects" : "nested");

/**
 * Every string and template literal in one bound expression, read with the TypeScript parser rather than a quote
 * scanner: `busy ? \`Stop ${n}\` : "Start"` carries three of them, two of them nested inside a third's braces, and a
 * regex that stops at the first quote reads that as one. Each literal carries whether it is where the expression's
 * result is drawn, which is what lets `{{ running ? \`running\` : \`stopped\` }}` count while
 * `{{ state === \`running\` ? … }}` and `{{ bandLabel(\`blocked\`) }}` do not.
 */
const expressionLiterals = (ts, expression, start) => {
    const wrapped = `(${expression})`;
    const file = ts.createSourceFile("expression.ts", wrapped, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const found = [];
    const span = (node) => ({ start: node.getStart(file) - 1, end: node.getEnd() - 1 });
    const keyOf = (name) => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined);
    const named = (node) => {
        // The values a lookup interpolates are drawn inside its message: `t(\`gate\`, { scope: \`everyone\` })`.
        if (ts.isObjectLiteralExpression(node)) {
            for (const property of node.properties) {
                if (ts.isPropertyAssignment(property)) {
                    visit(property.initializer, "drawn");
                }
            }
            return;
        }
        visit(node, "nested");
    };
    const visit = (node, mode) => {
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node)) {
            visit(node.expression, mode);
            return;
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            if (mode !== "objects") {
                found.push({ parts: [{ text: node.text }], drawn: mode === "drawn", ...span(node) });
            }
            return;
        }
        if (ts.isTemplateExpression(node)) {
            if (mode !== "objects") {
                const parts = [{ text: node.head.text }];
                for (const piece of node.templateSpans) {
                    parts.push({ expression: wrapped.slice(piece.expression.getStart(file), piece.expression.getEnd()) }, { text: piece.literal.text });
                }
                found.push({ parts, drawn: mode === "drawn", ...span(node) });
            }
            // What a `${}` holds is drawn wherever the template is: `\`${n} ${n === 1 ? \`slot\` : \`slots\`}\``.
            for (const piece of node.templateSpans) {
                visit(piece.expression, mode);
            }
            return;
        }
        if (ts.isConditionalExpression(node)) {
            // `{{ n === 1 ? "" : "s" }}`: an English plural glued to whatever came before, a word only English inflects so.
            const branches = [node.whenTrue, node.whenFalse].map((branch) => (ts.isStringLiteral(branch) || ts.isNoSubstitutionTemplateLiteral(branch) ? branch.text : undefined));
            if (mode === "drawn" && branches.includes("") && branches.some((text) => text === "s" || text === "es")) {
                found.push({ parts: [{ text: branches.join("") }], drawn: true, suffix: true, ...span(node) });
                return;
            }
            visit(node.condition, quiet(mode));
            visit(node.whenTrue, mode);
            visit(node.whenFalse, mode);
            return;
        }
        if (ts.isBinaryExpression(node)) {
            const kind = node.operatorToken.kind;
            const S = ts.SyntaxKind;
            // A comparison's operands are matched against data, whatever they read like: `action === \`Roll back\``.
            if ([S.EqualsEqualsEqualsToken, S.ExclamationEqualsEqualsToken, S.EqualsEqualsToken, S.ExclamationEqualsToken, S.InKeyword, S.InstanceOfKeyword].includes(kind)) {
                return;
            }
            if (kind === S.AmpersandAmpersandToken) {
                visit(node.left, quiet(mode));
                visit(node.right, mode);
                return;
            }
            const passes = kind === S.QuestionQuestionToken || kind === S.BarBarToken || kind === S.PlusToken;
            visit(node.left, passes ? mode : quiet(mode));
            visit(node.right, passes ? mode : quiet(mode));
            return;
        }
        if (ts.isCallExpression(node)) {
            // A lookup's first argument is the catalog key — the way the translation arrives, never a word on screen.
            // Whole keys are already turned away as dotted paths, but one built around a `${}` joins to a trailing-dot
            // stem (`docxCompare.`) that no longer looks like one; the arguments after it still carry values a reader sees.
            if (isCatalogLookup(ts, node.expression)) {
                if (node.arguments[1] !== undefined) {
                    named(node.arguments[1]);
                }
                for (const argument of node.arguments.slice(2)) {
                    visit(argument, quiet(mode));
                }
                return;
            }
            const callee = node.expression;
            const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
            const helper = ts.isIdentifier(callee) ? callee.text : method;
            visit(callee, quiet(mode));
            node.arguments.forEach((argument, at) => {
                if (method !== undefined && MATCHING_METHODS.has(method)) {
                    return;
                }
                // `approvers.join(\` or \`)` draws its separator between the words it joins.
                const spoken = (method === "join" && at === 0) || SPOKEN_ARGUMENT.get(helper ?? "") === at;
                visit(argument, spoken ? (mode === "nested" ? "nested" : "drawn") : quiet(mode));
            });
            return;
        }
        if (ts.isArrayLiteralExpression(node)) {
            for (const element of node.elements) {
                visit(element, mode);
            }
            return;
        }
        if (ts.isObjectLiteralExpression(node)) {
            for (const property of node.properties) {
                if (ts.isPropertyAssignment(property)) {
                    const key = keyOf(property.name);
                    visit(property.initializer, key !== undefined && VISIBLE_KEYS.has(key) ? (mode === "nested" ? "nested" : "drawn") : quiet(mode));
                } else if (!ts.isShorthandPropertyAssignment(property)) {
                    ts.forEachChild(property, (child) => visit(child, quiet(mode)));
                }
            }
            return;
        }
        if (ts.isElementAccessExpression(node)) {
            visit(node.expression, quiet(mode));
            return;
        }
        ts.forEachChild(node, (child) => visit(child, quiet(mode)));
    };
    for (const statement of file.statements) {
        visit(ts.isExpressionStatement(statement) ? statement.expression : statement, start);
    }
    return found;
};

/**
 * A catalog key built from a variable: `t(\`docxCompare.${tick.kind}\`)` asks for one of a set of messages, which is
 * what this check is for rather than a breach of it. Cutting the interpolation out leaves `docxCompare.` — a key whose
 * last segment is missing — and the NOT_PROSE shape that spares a written-out key wants a segment after every dot, so
 * the stub reads as English and the call is reported as if the words had been typed there.
 *
 * Judged on the parts, not on the joined text, because to anything that only sees a string `docxCompare.` and `Stop `
 * are the same thing: a template whose static halves carry nothing but key characters, with at least one dot among
 * them, is a key. `\`Stop ${n}\`` keeps its space and stays prose. i18n-keys.mjs reads the same construct from the
 * other end, keeping the prefix before `${` so the messages under it are not reported as nobody's.
 */
const KEY_CHARS = /^[\w$.]*$/;
const isSplitKey = (parts) => {
    const statics = parts.filter((part) => part.text !== undefined).map((part) => part.text);
    return parts.some((part) => part.expression !== undefined) && statics.every((text) => KEY_CHARS.test(text)) && statics.join("").includes(".");
};

// Literals inside one expression, as findings against the file: shared by a bound attribute and a `{{ }}`, which are
// the same thing — an expression whose result is drawn. A literal inside a reported template is part of that one
// sentence (`\`${n} of ${slots} ${slots === 1 ? \`slot\` : \`slots\`}\``), so it is not reported again on its own.
// A literal standing where the result is drawn is judged as drawn text, so `\`running\`` there is a word; anywhere
// else in the expression only a template with a placeholder or plain prose is.
const inExpression = (ts, expression, base, name, mode) => {
    const kept = expressionLiterals(ts, expression, mode).filter(
        (literal) => literal.suffix || (!isSplitKey(literal.parts) && isProse(literal.parts.map((part) => part.text ?? "").join(" "), literal.drawn || literal.parts.length > 1)),
    );
    return kept
        .filter((literal) => !kept.some((outer) => outer !== literal && outer.start <= literal.start && literal.end <= outer.end))
        .map((literal) => ({
            kind: literal.parts.length === 1 ? "expr" : "tpl",
            name,
            text: literal.parts.map((part) => part.text ?? "").join(""),
            parts: literal.parts,
            start: base + literal.start,
            end: base + literal.end,
        }));
};

// A bound attribute carries its words inside an expression: a ternary, a nullish chain, a call, an object of options.
const boundAttr = (prop, ts) => {
    const bound = BOUND(prop);
    return bound === undefined ? [] : inExpression(ts, prop.exp.content, prop.exp.loc.start.offset, bound.name, bound.mode);
};

// A sentence built from text and `{{ }}` is ONE message with placeholders. Extracted node by node it becomes fragments
// in English word order, which no translator can put back together.
const sentenceRun = (kids) => {
    const speaks = kids.some((child) => child.type === TEXT && isProse(child.content, true));
    if (!speaks || kids.length < 2 || !kids.every((child) => child.type === TEXT || child.type === INTERPOLATION)) {
        return undefined;
    }
    return {
        kind: "run",
        parts: kids.map((child) => (child.type === TEXT ? { text: child.content } : { expression: child.content.content })),
        start: kids[0].loc.start.offset,
        end: kids.at(-1).loc.end.offset,
    };
};

// Children that carry meaning: whitespace between tags and comments are neither text nor markup for this purpose.
const speaking = (node) => (node.children ?? []).filter((child) => child.type !== COMMENT && !(child.type === TEXT && child.content.trim() === ""));

const textFinding = (node, verbatim) => (verbatim || !isProse(node.content, true) ? [] : [{ kind: "text", text: node.content.trim(), ...trimmedSpan(node) }]);

// `{{ busy ? `Stopping…` : `Stop` }}`: an expression drawn where it stands, the same judgment as a bound attribute's.
const drawnExpression = (node, verbatim, ts) => (verbatim ? [] : inExpression(ts, node.content.content, node.content.loc.start.offset, "{{}}", "drawn"));

const walk = (node, verbatim, found, ts) => {
    const inside = verbatim || verbatimHere(node);
    if (node.type === TEXT) {
        found.push(...textFinding(node, verbatim));
        return;
    }
    if (node.type === INTERPOLATION) {
        found.push(...drawnExpression(node, verbatim, ts));
        return;
    }
    found.push(...(node.props ?? []).flatMap((prop) => [...staticAttr(prop), ...boundAttr(prop, ts)]));
    const run = inside ? undefined : sentenceRun(speaking(node));
    if (run !== undefined) {
        found.push(run);
        return;
    }
    for (const child of [...(node.children ?? []), ...(node.branches ?? [])]) {
        walk(child, inside, found, ts);
    }
};

/**
 * Every user-visible literal in one SFC, as spans into the file's own source. `text` is a whole text node, `run` is a
 * sentence a `{{ }}` interrupts, `attr` is a static attribute, `expr` a string literal inside a bound one, `tpl` a
 * template literal inside a bound one — which carries placeholders, so it arrives as `parts` like a run does.
 */
export const visibleLiterals = (source, filename, { sfc, ts }) => {
    const { descriptor, errors } = sfc.parse(source, { filename });
    if (errors.length > 0 || descriptor.template === null) {
        return [];
    }
    const found = [];
    for (const child of descriptor.template.ast?.children ?? []) {
        walk(child, false, found, ts);
    }
    const lineAt = (offset) => source.slice(0, offset).split("\n").length;
    return found.sort((left, right) => left.start - right.start).map((finding) => ({ ...finding, line: lineAt(finding.start) }));
};
