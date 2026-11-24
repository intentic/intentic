import { decodeEntities } from "../xml.js";

// A small non-validating XML reader for the checks. The derivers get by with a regex over a part's text; a check needs
// the tree (a shape's OWN geometry rather than a grouped child's, a paragraph's own runs, a field's begin and end).
// Names come out under the specification's prefixes whatever the file declared: a part rewritten by a script that
// renamed `p:` to `ns0:` is still the same presentation, and a check that matched on the written prefix would pass it.
// No DTD, no entity expansion beyond the five predefined and numeric references: a part is data, never instructions.

export interface XmlElement {
    /** Qualified name under the canonical prefix of its namespace (`p:sp`, `w:t`); the written one for an unknown namespace. */
    readonly name: string;
    /** Attributes by qualified name, canonical prefixes as above; unprefixed attributes keep their bare name. */
    readonly attrs: Readonly<Record<string, string>>;
    readonly children: (XmlElement | string)[];
}

// Transitional and Strict OOXML name the same vocabulary under two URIs; both read as one prefix.
const CANONICAL = new Map<string, string>([
    ["http://schemas.openxmlformats.org/presentationml/2006/main", "p"],
    ["http://purl.oclc.org/ooxml/presentationml/main", "p"],
    ["http://schemas.openxmlformats.org/drawingml/2006/main", "a"],
    ["http://purl.oclc.org/ooxml/drawingml/main", "a"],
    ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "r"],
    ["http://purl.oclc.org/ooxml/officeDocument/relationships", "r"],
    ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w"],
    ["http://purl.oclc.org/ooxml/wordprocessingml/main", "w"],
    ["http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "wp"],
    ["http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing", "wp"],
    ["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "x"],
    ["http://purl.oclc.org/ooxml/spreadsheetml/main", "x"],
    ["http://schemas.openxmlformats.org/package/2006/relationships", "rel"],
    ["http://schemas.openxmlformats.org/markup-compatibility/2006", "mc"],
]);

const TOKEN =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

type Scope = ReadonlyMap<string, string>;

const canonicalName = (written: string, scope: Scope, isAttribute: boolean): string => {
    const colon = written.indexOf(":");
    const prefix = colon === -1 ? "" : written.slice(0, colon);
    const local = colon === -1 ? written : written.slice(colon + 1);
    // An unprefixed attribute belongs to no namespace; an unprefixed element to the default one.
    if (colon === -1 && isAttribute) {
        return written;
    }
    const uri = scope.get(prefix);
    const canonical = uri === undefined ? undefined : CANONICAL.get(uri);
    if (canonical !== undefined) {
        return `${canonical}:${local}`;
    }
    return written;
};

interface Frame {
    readonly element: XmlElement;
    /** The name as the file wrote it, which is what its closing tag repeats. */
    readonly written: string;
    readonly scope: Scope;
}

const isDeclaration = (name: string): boolean => name === "xmlns" || name.startsWith("xmlns:");

// An opening tag as an element under `parent`: its namespace declarations extend the parent's scope, and its names are
// canonicalised under the scope that results.
const openElement = (parent: Frame, written: string, attributeText: string): Frame => {
    const pairs: [string, string][] = [...attributeText.matchAll(ATTRIBUTE)].map((attribute) => [attribute[1] ?? "", decodeEntities(attribute[2] ?? attribute[3] ?? "")]);
    const declarations = pairs.filter(([name]) => isDeclaration(name));
    const scope =
        declarations.length === 0
            ? parent.scope
            : new Map([...parent.scope, ...declarations.map(([name, uri]): [string, string] => [name === "xmlns" ? "" : name.slice(6), uri])]);
    const attrs = Object.fromEntries(pairs.filter(([name]) => !isDeclaration(name)).map(([name, value]) => [canonicalName(name, scope, true), value]));
    const element: XmlElement = { name: canonicalName(written, scope, false), attrs, children: [] };
    parent.element.children.push(element);
    return { element, written, scope };
};

// Whitespace between elements is layout; inside a text-bearing element (`a:t`, `w:t`) it is content.
const appendText = (frame: Frame | undefined, raw: string, decode: boolean): void => {
    if (frame === undefined || raw === "") {
        return;
    }
    const textBearing = frame.element.name.endsWith(":t") || frame.element.name === "t";
    if (raw.trim() === "" && !textBearing) {
        return;
    }
    frame.element.children.push(decode ? decodeEntities(raw) : raw);
};

/** The root element of `text`; an empty synthetic root when the text holds no element at all. */
export const parseXml = (text: string): XmlElement => {
    const root: XmlElement = { name: "#document", attrs: {}, children: [] };
    const stack: Frame[] = [{ element: root, written: "#document", scope: new Map() }];
    let last = 0;
    for (const match of text.matchAll(TOKEN)) {
        appendText(stack.at(-1), text.slice(last, match.index), true);
        last = match.index + match[0].length;
        const [, cdata, closing, opening, attributeText, selfClosing] = match;
        if (cdata !== undefined) {
            appendText(stack.at(-1), cdata, false);
        } else if (closing !== undefined) {
            // Pops to the matching open tag; a stray close tag (a malformed part) is ignored rather than fatal.
            const at = stack.findLastIndex((frame) => frame.written === closing);
            stack.length = at > 0 ? at : stack.length;
        } else if (opening !== undefined) {
            const frame = openElement(stack.at(-1) ?? { element: root, written: "#document", scope: new Map() }, opening, attributeText ?? "");
            if (selfClosing !== "/") {
                stack.push(frame);
            }
        }
        // Anything else is a comment, a processing instruction or a doctype, none of which is content.
    }
    return root.children.find((child): child is XmlElement => typeof child !== "string") ?? root;
};

export const isElement = (node: XmlElement | string): node is XmlElement => typeof node !== "string";

/** Direct children named `name`. */
export const childrenNamed = (element: XmlElement, name: string): XmlElement[] =>
    element.children.filter((child): child is XmlElement => isElement(child) && child.name === name);

/** The first direct child named `name`. */
export const childNamed = (element: XmlElement, name: string): XmlElement | undefined =>
    element.children.find((child): child is XmlElement => isElement(child) && child.name === name);

/** The element at the end of a path of direct children (`childAt(sp, "p:nvSpPr", "p:nvPr", "p:ph")`). */
export const childAt = (element: XmlElement | undefined, ...path: readonly string[]): XmlElement | undefined => {
    let current = element;
    for (const name of path) {
        if (current === undefined) {
            return undefined;
        }
        current = childNamed(current, name);
    }
    return current;
};

/** Every descendant named `name`, in document order (the element itself excluded). */
export const descendantsNamed = (element: XmlElement, name: string): XmlElement[] => {
    const found: XmlElement[] = [];
    const visit = (node: XmlElement): void => {
        for (const child of node.children) {
            if (isElement(child)) {
                if (child.name === name) {
                    found.push(child);
                }
                visit(child);
            }
        }
    };
    visit(element);
    return found;
};

/** Every element in the subtree, the root included, in document order. */
export const everyElement = (element: XmlElement): XmlElement[] => {
    const found: XmlElement[] = [element];
    const visit = (node: XmlElement): void => {
        for (const child of node.children) {
            if (isElement(child)) {
                found.push(child);
                visit(child);
            }
        }
    };
    visit(element);
    return found;
};

/** The text of every descendant element named `textName` (`a:t`, `w:t`), joined. */
export const textIn = (element: XmlElement, textName: string): string =>
    descendantsNamed(element, textName)
        .map((node) => node.children.filter((child): child is string => typeof child === "string").join(""))
        .join("");

/** An integer attribute; undefined when absent or not a whole number. */
export const intAttr = (element: XmlElement | undefined, name: string): number | undefined => {
    const raw = element?.attrs[name];
    if (raw === undefined || !/^-?\d+$/.test(raw.trim())) {
        return undefined;
    }
    return Number(raw);
};
