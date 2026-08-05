// @ts-check
// A small HTML → Markdown pass for this site's own build output.
//
// It is deliberately not a general-purpose converter. The input is Astro's emitted markup for a known
// set of components, so the parser only has to handle well-formed HTML, and the renderer only has to
// know the tags those components actually produce. Anything it does not recognise is treated as a
// transparent container and its children are rendered — which is what makes the diagram-heavy pages
// (rows of labelled cards) come out as readable lines instead of disappearing.

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** Chrome and decoration: present for a human looking at the page, noise for a machine reading it. */
const DROPPED_TAGS = new Set(["script", "style", "svg", "noscript", "nav", "button", "template", "form", "input", "select"]);

const BLOCK_TAGS = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
]);

const NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    middot: "·",
    times: "×",
    rarr: "→",
    larr: "←",
    darr: "↓",
    uarr: "↑",
};

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named ?? whole;
    });
}

/** Read to the tag's closing `>`, ignoring any that sits inside a quoted attribute value. */
function findTagEnd(html, from) {
    let quote = "";
    for (let i = from; i < html.length; i++) {
        const ch = html[i];
        if (quote) {
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") return i;
    }
    return html.length;
}

function parseAttrs(source) {
    /** @type {Record<string, string>} */
    const attrs = {};
    for (const match of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
    return attrs;
}

/**
 * @typedef {{ type: "text", value: string } | { type: "el", tag: string, attrs: Record<string, string>, children: Node[] }} Node
 */

/** @returns {Node[]} */
export function parseHtml(html) {
    /** @type {Node[]} */
    const root = [];
    const stack = [{ children: root, tag: "#root" }];
    let i = 0;

    while (i < html.length) {
        const lt = html.indexOf("<", i);
        if (lt === -1) {
            if (i < html.length) stack[stack.length - 1].children.push({ type: "text", value: html.slice(i) });
            break;
        }
        if (lt > i) stack[stack.length - 1].children.push({ type: "text", value: html.slice(i, lt) });

        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        if (html.startsWith("<!", lt)) {
            i = findTagEnd(html, lt) + 1;
            continue;
        }

        const end = findTagEnd(html, lt);
        const inner = html.slice(lt + 1, end);

        if (inner.startsWith("/")) {
            const tag = inner.slice(1).trim().toLowerCase();
            for (let depth = stack.length - 1; depth > 0; depth--) {
                if (stack[depth].tag === tag) {
                    stack.length = depth;
                    break;
                }
            }
            i = end + 1;
            continue;
        }

        const nameMatch = inner.match(/^([a-zA-Z][-a-zA-Z0-9:]*)/);
        if (!nameMatch) {
            i = end + 1;
            continue;
        }
        const tag = nameMatch[1].toLowerCase();
        const selfClosing = inner.trimEnd().endsWith("/");
        /** @type {Node} */
        const node = { type: "el", tag, attrs: parseAttrs(inner.slice(nameMatch[1].length)), children: [] };
        stack[stack.length - 1].children.push(node);
        i = end + 1;

        if (VOID_TAGS.has(tag) || selfClosing) continue;

        if (RAW_TEXT_TAGS.has(tag)) {
            const close = html.toLowerCase().indexOf(`</${tag}`, i);
            const stop = close === -1 ? html.length : close;
            node.children.push({ type: "text", value: html.slice(i, stop) });
            i = stop === html.length ? stop : findTagEnd(html, stop) + 1;
            continue;
        }

        stack.push({ children: node.children, tag });
    }

    return root;
}

/** All descendant text, entities decoded, whitespace untouched — for <pre>. */
function rawText(nodes) {
    let out = "";
    for (const node of nodes) {
        if (node.type === "text") out += decodeEntities(node.value);
        else if (!RAW_TEXT_TAGS.has(node.tag)) out += rawText(node.children);
    }
    return out;
}

function absolutize(url, origin) {
    if (!url) return url;
    return url.startsWith("/") ? `${origin}${url}` : url;
}

/** Wrap a rendered subtree as its own block, or contribute nothing if it rendered empty. */
function asBlock(body) {
    const trimmed = body.trim();
    return trimmed ? `\n\n${trimmed}` : "";
}

function renderList(node, ctx) {
    const ordered = node.tag === "ol";
    const items = node.children.filter((child) => child.type === "el" && child.tag === "li");
    if (items.length === 0) return "";
    const lines = items.map((item, index) => {
        const marker = ordered ? `${index + 1}. ` : "- ";
        const body = renderNodes(item.children, ctx).trim();
        // Continuation lines (including a nested list) sit under the marker.
        return marker + body.split("\n").join(`\n${" ".repeat(marker.length)}`);
    });
    return `\n\n${lines.join("\n")}`;
}

function renderTable(node, ctx) {
    /** @type {string[][]} */
    const rows = [];
    const collect = (nodes) => {
        for (const child of nodes) {
            if (child.type !== "el") continue;
            if (child.tag === "tr") {
                rows.push(
                    child.children
                        .filter((cell) => cell.type === "el" && (cell.tag === "td" || cell.tag === "th"))
                        .map((cell) => renderNodes(cell.children, ctx).replace(/\s+/g, " ").trim()),
                );
            } else collect(child.children);
        }
    };
    collect(node.children);
    if (rows.length === 0) return "";
    const [head, ...body] = rows;
    const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body.map((row) => `| ${row.join(" | ")} |`)];
    return `\n\n${lines.join("\n")}`;
}

function renderNode(node, ctx) {
    if (node.type === "text") {
        // Astro's formatter breaks prose across source lines; collapse it back to one paragraph.
        return decodeEntities(node.value).replace(/\s+/g, " ");
    }
    if (DROPPED_TAGS.has(node.tag) || node.attrs["aria-hidden"] === "true" || node.attrs.hidden !== undefined) return "";

    switch (node.tag) {
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
            const text = renderNodes(node.children, ctx).replace(/\s+/g, " ").trim();
            return text ? `\n\n${"#".repeat(Number(node.tag[1]))} ${text}` : "";
        }
        case "p":
            return asBlock(renderNodes(node.children, ctx));
        case "br":
            return "\n";
        case "hr":
            return "\n\n---";
        case "ul":
        case "ol":
            return renderList(node, ctx);
        case "table":
            return renderTable(node, ctx);
        case "pre": {
            const code = rawText(node.children).replace(/\n+$/, "");
            if (!code.trim()) return "";
            const lang = node.attrs["data-language"] ?? findLanguage(node.children) ?? "";
            return `\n\n\`\`\`${lang}\n${code}\n\`\`\``;
        }
        case "code": {
            const text = rawText(node.children).replace(/\s+/g, " ").trim();
            return text ? `\`${text}\`` : "";
        }
        case "strong":
        case "b": {
            const text = renderNodes(node.children, ctx).trim();
            return text ? `**${text}**` : "";
        }
        case "em":
        case "i": {
            const text = renderNodes(node.children, ctx).trim();
            return text ? `*${text}*` : "";
        }
        case "a": {
            const text = renderNodes(node.children, ctx).replace(/\s+/g, " ").trim();
            const href = node.attrs.href;
            if (!text) return "";
            return href ? `[${text}](${absolutize(href, ctx.origin)})` : text;
        }
        case "img": {
            const alt = node.attrs.alt ?? "";
            return node.attrs.src ? `\n\n![${alt}](${absolutize(node.attrs.src, ctx.origin)})` : "";
        }
        case "blockquote":
            return asBlock(
                renderNodes(node.children, ctx)
                    .trim()
                    .split("\n")
                    .map((line) => `> ${line}`.trimEnd())
                    .join("\n"),
            );
        case "summary": {
            // An accordion's question: the answer follows it as a sibling, so it reads as a lead-in.
            const text = renderNodes(node.children, ctx).replace(/\s+/g, " ").trim();
            return text ? `\n\n**${text}**` : "";
        }
        case "figcaption": {
            const text = renderNodes(node.children, ctx).replace(/\s+/g, " ").trim();
            return text ? `\n\n*${text}*` : "";
        }
        default: {
            if (BLOCK_TAGS.has(node.tag)) return asBlock(renderNodes(node.children, ctx));
            // An unrecognised inline container is almost always a chip or a label in a diagram, and those
            // sit flush against each other in the markup. Without a separator "Sandbox rules" and
            // "AI oversight" come out as one word. The trailing whitespace collapse tidies up the rest.
            const body = renderNodes(node.children, ctx);
            return body && !/^\s/.test(body) ? ` ${body}` : body;
        }
    }
}

function findLanguage(nodes) {
    for (const node of nodes) {
        if (node.type !== "el") continue;
        if (node.attrs["data-language"]) return node.attrs["data-language"];
        const found = findLanguage(node.children);
        if (found) return found;
    }
    return undefined;
}

function renderNodes(nodes, ctx) {
    let out = "";
    for (const node of nodes) out += renderNode(node, ctx);
    return out;
}

/**
 * Convert a fragment of this site's HTML to Markdown.
 * @param {string} html
 * @param {{ origin: string }} ctx site origin, so root-relative links survive being read out of context
 */
export function htmlToMarkdown(html, ctx) {
    return renderNodes(parseHtml(html), ctx)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

/** The readable region of a full page: the docs article if there is one, otherwise the main element. */
export function extractContent(html) {
    return html.match(/<article\b[^>]*>([\s\S]*)<\/article>/i)?.[1] ?? html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1] ?? "";
}
