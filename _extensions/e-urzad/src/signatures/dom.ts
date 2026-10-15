// Small DOM readers shared by the XML signature and trusted-list code, matching elements by local name so a document's
// namespace prefixes (ds:, xades:, tsl:, or none) never matter.

export const isElement = (node: Node | null | undefined): node is Element => node?.nodeType === 1;

export const childElements = (parent: Element | undefined, localName: string): Element[] =>
    parent === undefined ? [] : Array.from(parent.childNodes).filter((node): node is Element => isElement(node) && node.localName === localName);

export const descendants = (root: Element | Document, localName: string): Element[] =>
    Array.from(root.getElementsByTagName("*")).filter((element) => element.localName === localName);

export const textOf = (element: Element | undefined): string => element?.textContent?.trim() ?? "";
