/* DOM → GitHub-flavored markdown, written for a reader that is an agent. That reader changes the rules:
 * no character escaping (an agent reads the markdown raw and escaped prose is noise — only table pipes and
 * inline-code backticks get protected, because those change structure), absolute link and image URLs (the
 * agent follows them with another fetch, so a relative path is a broken one), and data: images dropped to
 * their alt text (a base64 blob can outweigh the whole article).
 *
 * Mixed content is handled as FLOW: walking a container, inline runs accumulate into a paragraph buffer
 * that flushes whenever a block element interrupts — so <div>text<p>para</p></div> yields two paragraphs
 * instead of losing the loose text, and unknown/custom elements are transparent containers by default. */
import { attr, type Element, isElement, isText, type Node, rawTextOf } from "./dom.js";

const NON_CONTENT = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "link", "meta", "head"]);

const INLINE: Record<string, { open: string; close: string }> = {
    strong: { open: "**", close: "**" },
    b: { open: "**", close: "**" },
    em: { open: "*", close: "*" },
    i: { open: "*", close: "*" },
    del: { open: "~~", close: "~~" },
    s: { open: "~~", close: "~~" },
    strike: { open: "~~", close: "~~" },
    kbd: { open: "`", close: "`" },
};

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

export interface MarkdownOptions {
    /** The page's final URL; every href/src resolves against it. Absent, URLs pass through untouched. */
    readonly baseUrl?: string | undefined;
}

export const renderMarkdown = (root: Element, options: MarkdownOptions = {}): string => {
    const blocks = renderFlow(root.childNodes, options);
    return `${blocks
        .join("\n\n")
        .replaceAll(/[ \t]+$/gm, "")
        .replaceAll(/\n{3,}/g, "\n\n")
        .trim()}\n`;
};

/* Children of a container: inline runs pool into paragraphs, block elements flush and stand alone. */
const renderFlow = (nodes: Node[], options: MarkdownOptions): string[] => {
    const blocks: string[] = [];
    let run = "";
    const flush = (): void => {
        const paragraph = collapse(run);
        if (paragraph !== "") {
            blocks.push(paragraph);
        }
        run = "";
    };
    for (const node of nodes) {
        if (isText(node)) {
            run += node.value;
            continue;
        }
        if (!isElement(node) || NON_CONTENT.has(node.tagName)) {
            continue;
        }
        const block = renderBlock(node, options);
        if (block === undefined) {
            run += renderInline(node, options);
        } else {
            flush();
            if (block !== "") {
                blocks.push(block);
            }
        }
    }
    flush();
    return blocks;
};

/** A block element's markdown, or undefined when the element is inline and belongs to the current run. */
const renderBlock = (el: Element, options: MarkdownOptions): string | undefined => {
    const heading = HEADINGS[el.tagName];
    if (heading !== undefined) {
        const text = collapse(renderInlineChildren(el, options));
        return text === "" ? "" : `${"#".repeat(heading)} ${text}`;
    }
    switch (el.tagName) {
        case "p":
            return collapse(renderInlineChildren(el, options));
        case "ul":
        case "ol":
            return renderList(el, options, 0);
        case "pre":
            return renderPre(el);
        case "blockquote":
            return renderFlow(el.childNodes, options)
                .join("\n\n")
                .split("\n")
                .map((line) => `> ${line}`.trimEnd())
                .join("\n");
        case "table":
            return renderTable(el, options);
        case "hr":
            return "---";
        case "figure": {
            const caption = el.childNodes.filter(isElement).find((child) => child.tagName === "figcaption");
            const body = renderFlow(
                el.childNodes.filter((child) => !(isElement(child) && child.tagName === "figcaption")),
                options,
            );
            const captionText = caption === undefined ? "" : collapse(renderInlineChildren(caption, options));
            return [body.join("\n\n"), captionText === "" ? "" : `*${captionText}*`].filter(Boolean).join("\n\n");
        }
        case "dl":
            return renderDefinitionList(el, options);
        case "details": {
            const summary = el.childNodes.filter(isElement).find((child) => child.tagName === "summary");
            const rest = renderFlow(
                el.childNodes.filter((child) => !(isElement(child) && child.tagName === "summary")),
                options,
            );
            const label = summary === undefined ? "" : `**${collapse(renderInlineChildren(summary, options))}**`;
            return [label, rest.join("\n\n")].filter(Boolean).join("\n\n");
        }
        case "div":
        case "section":
        case "article":
        case "main":
        case "body":
        case "aside":
        case "header":
        case "footer":
        case "nav":
        case "form":
        case "fieldset":
        case "address":
        case "center":
            return renderFlow(el.childNodes, options).join("\n\n");
        default:
            return undefined;
    }
};

const renderInlineChildren = (el: Element, options: MarkdownOptions): string =>
    el.childNodes.map((child) => (isText(child) ? child.value : isElement(child) ? renderInline(child, options) : "")).join("");

const renderInline = (el: Element, options: MarkdownOptions): string => {
    if (NON_CONTENT.has(el.tagName)) {
        return "";
    }
    if (el.tagName === "br") {
        // A sentinel, not "\n": source-HTML newlines are whitespace and collapse to spaces, and only this
        // marker survives collapse() as a real line break.
        return BR;
    }
    if (el.tagName === "img") {
        return renderImage(el, options);
    }
    if (el.tagName === "a") {
        return renderLink(el, options);
    }
    if (el.tagName === "code") {
        const code = rawTextOf(el).trim();
        return code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
    }
    const wrap = INLINE[el.tagName];
    const inner = renderInlineChildren(el, options);
    if (wrap === undefined) {
        // Unknown or neutral inline (span, small, q, time, custom elements): transparent — its text joins
        // the surrounding run. Block elements never reach here; flow rendering dispatches them first.
        return inner;
    }
    const trimmed = collapse(inner);
    return trimmed === "" ? "" : `${wrap.open}${trimmed}${wrap.close}`;
};

const renderLink = (el: Element, options: MarkdownOptions): string => {
    const text = collapse(renderInlineChildren(el, options));
    const href = resolveUrl(attr(el, "href"), options.baseUrl);
    if (href === undefined || href.startsWith("javascript:")) {
        return text;
    }
    if (href.startsWith("mailto:") || href.startsWith("tel:")) {
        return text === "" ? href.slice(href.indexOf(":") + 1) : text;
    }
    if (text === "") {
        return "";
    }
    return `[${text}](${href})`;
};

const renderImage = (el: Element, options: MarkdownOptions): string => {
    const alt = attr(el, "alt")?.trim() ?? "";
    const src = resolveUrl(attr(el, "src"), options.baseUrl);
    if (src === undefined || src.startsWith("data:")) {
        return alt;
    }
    return `![${alt}](${src})`;
};

const renderList = (el: Element, options: MarkdownOptions, depth: number): string => {
    const ordered = el.tagName === "ol";
    const start = Number(attr(el, "start") ?? "1");
    const items = el.childNodes.filter(isElement).filter((child) => child.tagName === "li");
    const lines: string[] = [];
    items.forEach((item, index) => {
        const marker = ordered ? `${start + index}. ` : "- ";
        const indent = "    ".repeat(depth);
        // An item is flow of its own: loose text becomes the item line, nested lists and blocks follow it.
        const nested: string[] = [];
        const inlineParts: string[] = [];
        for (const child of item.childNodes) {
            if (isElement(child) && (child.tagName === "ul" || child.tagName === "ol")) {
                nested.push(renderList(child, options, depth + 1));
            } else if (isElement(child) && renderBlock(child, options) !== undefined) {
                const block = renderBlock(child, options) ?? "";
                if (block !== "") {
                    nested.push(
                        block
                            .split("\n")
                            .map((line) => `${indent}    ${line}`.trimEnd())
                            .join("\n"),
                    );
                }
            } else if (isText(child)) {
                inlineParts.push(child.value);
            } else if (isElement(child)) {
                inlineParts.push(renderInline(child, options));
            }
        }
        lines.push(`${indent}${marker}${collapse(inlineParts.join(""))}`);
        lines.push(...nested);
    });
    return lines.join("\n");
};

const renderPre = (el: Element): string => {
    const codeChild = el.childNodes.filter(isElement).find((child) => child.tagName === "code");
    const classes = `${attr(el, "class") ?? ""} ${codeChild === undefined ? "" : (attr(codeChild, "class") ?? "")}`;
    const lang = /(?:language|lang)-([\w+-]+)/.exec(classes)?.[1] ?? "";
    const code = rawTextOf(el).replace(/^\n/, "").trimEnd();
    // The fence must be longer than any backtick run inside the code it fences.
    const longestRun = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${fence}${lang}\n${code}\n${fence}`;
};

const renderTable = (el: Element, options: MarkdownOptions): string => {
    const rows: string[][] = [];
    for (const tr of collectRows(el)) {
        const cells = tr.childNodes.filter(isElement).filter((cell) => cell.tagName === "td" || cell.tagName === "th");
        rows.push(cells.map((cell) => collapse(renderInlineChildren(cell, options)).replaceAll("|", "\\|").replaceAll("\n", " ")));
    }
    if (rows.length === 0) {
        return "";
    }
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]): string[] => [...row, ...Array.from({ length: width - row.length }, () => "")];
    const [header, ...body] = rows.map(pad) as [string[], ...string[][]];
    return [tableRow(header), tableRow(header.map(() => "---")), ...body.map(tableRow)].join("\n");
};

const tableRow = (cells: string[]): string => `| ${cells.join(" | ")} |`;

const collectRows = (el: Element): Element[] => {
    const rows: Element[] = [];
    for (const child of el.childNodes.filter(isElement)) {
        if (child.tagName === "tr") {
            rows.push(child);
        } else if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
            rows.push(...child.childNodes.filter(isElement).filter((row) => row.tagName === "tr"));
        }
    }
    return rows;
};

const renderDefinitionList = (el: Element, options: MarkdownOptions): string => {
    const lines: string[] = [];
    for (const child of el.childNodes.filter(isElement)) {
        if (child.tagName === "dt") {
            lines.push(`**${collapse(renderInlineChildren(child, options))}**`);
        } else if (child.tagName === "dd") {
            lines.push(`: ${collapse(renderInlineChildren(child, options))}`);
        }
    }
    return lines.join("\n");
};

const resolveUrl = (raw: string | undefined, base: string | undefined): string | undefined => {
    if (raw === undefined || raw === "") {
        return undefined;
    }
    const trimmed = raw.trim();
    if (/^(?:javascript|mailto|tel|data):/i.test(trimmed)) {
        return trimmed;
    }
    try {
        return base === undefined ? trimmed : new URL(trimmed, base).href;
    } catch {
        return undefined;
    }
};

// A control character no HTML text node ever carries: whitespace collapse cannot touch it, and only
// it becomes a line break afterwards.
const BR = "\u0001";

/* Whitespace-collapse an inline run without eating the line breaks <br> put there: split on the sentinel
 * FIRST, so each side collapses as ordinary text and the joins are the only newlines that survive. Split
 * rather than a regex over the control character, which is a lint error for good reasons everywhere else. */
const collapse = (text: string): string =>
    text
        .split(BR)
        .map((part) => part.replaceAll(/\s+/g, " ").trim())
        .join("\n")
        .trim();
