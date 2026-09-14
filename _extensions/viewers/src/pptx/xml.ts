/* OOXML parts as a DOM, read by LOCAL name: the prefixes a deck uses (`a:`, `p:`, `r:`) are a producer's choice, and
   a document that binds the same namespace to `x:` means exactly the same thing. */

// The one namespace whose ATTRIBUTES are read by name here (r:id, r:embed), and the only place a prefix is guessed at.
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// A file this size parses in a frame or two; DOMParser is the browser's own, so nothing is shipped for it.
export const parseXml = (text: string): Element => {
    const parsed = new DOMParser().parseFromString(text, "application/xml");
    const root: Element | null = parsed.documentElement;
    // A parse failure is reported as a document, not thrown: browsers return a <parsererror> root, jsdom nests one.
    if (root === null || root.localName === "parsererror" || root.getElementsByTagName("parsererror").length > 0) {
        throw new Error("this part is not valid XML");
    }
    return root;
};

/** Direct children by local name. Order is the document's, which is the order a slide draws in. */
export const kids = (node: Element | undefined, name: string): Element[] => (node === undefined ? [] : [...node.children].filter((child) => child.localName === name));

/** The first direct child with this local name. */
export const kid = (node: Element | undefined, name: string): Element | undefined => kids(node, name)[0];

/** The first descendant with this local name, in document order. Shape properties nest deeply and are named once. */
export const find = (node: Element | undefined, name: string): Element | undefined =>
    node === undefined ? undefined : [...node.getElementsByTagName("*")].find((element) => element.localName === name);

/** Every descendant with this local name, in document order. */
export const findAll = (node: Element | undefined, name: string): Element[] =>
    node === undefined ? [] : [...node.getElementsByTagName("*")].filter((element) => element.localName === name);

export const attr = (node: Element | undefined, name: string): string | undefined => node?.getAttribute(name) ?? undefined;

/** A number-valued attribute; absent and unparseable are the same answer, since both mean "inherit". */
export const num = (node: Element | undefined, name: string): number | undefined => {
    const raw = attr(node, name);
    if (raw === undefined) {
        return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
};

/** OOXML's boolean attributes: "1"/"true" on, "0"/"false" off, absent means inherit rather than off. */
export const flag = (node: Element | undefined, name: string): boolean | undefined => {
    const raw = attr(node, name);
    return raw === undefined ? undefined : raw === "1" || raw === "true";
};

/** A relationship id (`r:embed`, `r:id`), by namespace first so an unusual prefix still resolves. */
export const relAttr = (node: Element | undefined, name: string): string | undefined =>
    node?.getAttributeNS(RELATIONSHIPS_NS, name) ?? node?.getAttribute(`r:${name}`) ?? undefined;
