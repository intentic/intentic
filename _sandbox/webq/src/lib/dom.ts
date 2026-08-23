/* The one DOM this package speaks: parse5's default tree, plus the handful of helpers every stage
 * (pruning, markdown, link extraction) needs. parse5 rather than jsdom on purpose — webq is baked onto the
 * sandbox image inside the daemon's tree, so every dependency is pull size for every sandbox; parse5 is a
 * spec-compliant HTML parser and nothing else, and the traversal helpers below are the only "DOM API" the
 * pipeline actually uses. Scripts never execute: this tree is data. */
import { type DefaultTreeAdapterMap, parse } from "parse5";

export type Document = DefaultTreeAdapterMap["document"];
export type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];
export type TextNode = DefaultTreeAdapterMap["textNode"];

export const isElement = (node: Node): node is Element => "tagName" in node;
export const isText = (node: Node): node is TextNode => node.nodeName === "#text";

export const parseHtml = (html: string): Document => parse(html);

export const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

// Tags whose text is never page content, skipped by every text walk (a <script>'s body is code even when
// the tree keeps the node around for inspection).
const NON_CONTENT = new Set(["script", "style", "noscript", "template", "svg", "canvas"]);

export const childElements = (el: Element): Element[] => el.childNodes.filter(isElement);

/** Depth-first visible text of a subtree, single-space normalized. */
export const textOf = (node: Node): string => collectText(node).join(" ").replaceAll(/\s+/g, " ").trim();

/** Raw text of a subtree with whitespace KEPT — what a <pre> means by its contents. */
export const rawTextOf = (node: Node): string => collectText(node).join("");

const collectText = (node: Node): string[] => {
    if (isText(node)) {
        return [node.value];
    }
    if (!isElement(node) || NON_CONTENT.has(node.tagName)) {
        return [];
    }
    return node.childNodes.flatMap((child) => collectText(child));
};

/** Every element with the given tag under (and including) the root, document order. */
export const elementsByTag = (root: Node, tag: string): Element[] => {
    const found: Element[] = [];
    walk(root, (el) => {
        if (el.tagName === tag) {
            found.push(el);
        }
    });
    return found;
};

export const walk = (node: Node, visit: (el: Element) => void): void => {
    if (isElement(node)) {
        visit(node);
    }
    if (isElement(node) || node.nodeName === "#document" || node.nodeName === "#document-fragment") {
        for (const child of (node as { childNodes: Node[] }).childNodes) {
            walk(child, visit);
        }
    }
};

// Package-private: the two callers below (bodyOf, metaOf) are the shape every consumer actually wants.
const findFirst = (root: Node, match: (el: Element) => boolean): Element | undefined => {
    if (isElement(root) && match(root)) {
        return root;
    }
    if (!("childNodes" in root)) {
        return undefined;
    }
    for (const child of (root as { childNodes: Node[] }).childNodes) {
        const hit = findFirst(child, match);
        if (hit !== undefined) {
            return hit;
        }
    }
    return undefined;
};

export const bodyOf = (doc: Document): Element | undefined => findFirst(doc, (el) => el.tagName === "body");

/** Detach an element from its parent — parse5 trees are plain objects, so removal is list surgery. */
export const remove = (el: Element): void => {
    const parent = el.parentNode;
    if (parent === null || parent === undefined) {
        return;
    }
    const index = parent.childNodes.indexOf(el);
    if (index >= 0) {
        parent.childNodes.splice(index, 1);
    }
};

/** Page metadata every capsule and index line leads with. */
export interface PageMeta {
    readonly title: string;
    readonly description: string | undefined;
    readonly lang: string | undefined;
}

export const metaOf = (doc: Document): PageMeta => {
    const title = textOf(findFirst(doc, (el) => el.tagName === "title") ?? ({ nodeName: "#text", value: "" } as Node));
    const description = findFirst(doc, (el) => el.tagName === "meta" && attr(el, "name") === "description");
    const html = findFirst(doc, (el) => el.tagName === "html");
    return {
        title,
        description: description === undefined ? undefined : attr(description, "content"),
        lang: html === undefined ? undefined : attr(html, "lang"),
    };
};
