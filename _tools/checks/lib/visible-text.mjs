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
    "description",
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

const boundTarget = (prop) => {
    if (prop.type !== DIRECTIVE || prop.exp?.type !== EXPRESSION) {
        return undefined;
    }
    if (prop.name === "bind") {
        return prop.arg?.type === EXPRESSION && VISIBLE_ATTRS.has(prop.arg.content) ? prop.arg.content : undefined;
    }
    return VISIBLE_DIRECTIVES.has(prop.name) ? `v-${prop.name}` : undefined;
};

// `t`, `$t`, and the same under a receiver (`i18n.t`): the callee shapes a catalog lookup wears.
const isCatalogLookup = (ts, callee) =>
    (ts.isIdentifier(callee) && /^\$?t$/.test(callee.text)) || (ts.isPropertyAccessExpression(callee) && /^\$?t$/.test(callee.name.text));

/**
 * Every string and template literal in one bound expression, read with the TypeScript parser rather than a quote
 * scanner: `busy ? \`Stop ${n}\` : "Start"` carries three of them, two of them nested inside a third's braces, and a
 * regex that stops at the first quote reads that as one.
 */
const expressionLiterals = (ts, expression) => {
    const wrapped = `(${expression})`;
    const file = ts.createSourceFile("expression.ts", wrapped, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const found = [];
    const span = (node) => ({ start: node.getStart(file) - 1, end: node.getEnd() - 1 });
    // A lookup's first argument is the catalog key — the way the translation arrives, never a word on screen. Whole
    // keys are already turned away as dotted paths, but one built around a `${}` joins to a trailing-dot stem
    // (`docxCompare.`) that no longer looks like one; the arguments after it still carry values a reader sees.
    const visit = (node) => {
        if (ts.isCallExpression(node) && isCatalogLookup(ts, node.expression)) {
            for (const argument of node.arguments.slice(1)) {
                visit(argument);
            }
            return;
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            found.push({ parts: [{ text: node.text }], ...span(node) });
            return;
        }
        if (ts.isTemplateExpression(node)) {
            const parts = [{ text: node.head.text }];
            for (const piece of node.templateSpans) {
                parts.push({ expression: wrapped.slice(piece.expression.getStart(file), piece.expression.getEnd()) }, { text: piece.literal.text });
            }
            found.push({ parts, ...span(node) });
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
    return found;
};

// Literals inside one expression, as findings against the file: shared by a bound attribute and a `{{ }}`, which are
// the same thing — an expression whose result is drawn.
const inExpression = (ts, expression, base, name) =>
    expressionLiterals(ts, expression)
        .filter((literal) => isProse(literal.parts.map((part) => part.text ?? "").join(" "), literal.parts.length > 1))
        .map((literal) => ({
            kind: literal.parts.length === 1 ? "expr" : "tpl",
            name,
            text: literal.parts.map((part) => part.text ?? "").join(""),
            parts: literal.parts,
            start: base + literal.start,
            end: base + literal.end,
        }));

// A bound visible attribute carries its words inside an expression: a ternary, a nullish chain, a call.
const boundAttr = (prop, ts) => {
    const name = boundTarget(prop);
    return name === undefined ? [] : inExpression(ts, prop.exp.content, prop.exp.loc.start.offset, name);
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
const drawnExpression = (node, verbatim, ts) => (verbatim ? [] : inExpression(ts, node.content.content, node.content.loc.start.offset, "{{}}"));

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
