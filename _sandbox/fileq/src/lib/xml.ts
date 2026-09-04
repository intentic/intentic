/* The two things every zip-of-XML deriver needs and no library is worth pulling in for: entity decoding for
 * text pulled out of XML by regex, and attribute reading off a tag's attribute string. Both are honest about
 * their scope — they read machine-written OOXML/ODF/OPF, never arbitrary markup. */

export const decodeEntities = (text: string): string =>
    text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replaceAll(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
        .replaceAll("&amp;", "&");

/** The value of `name="…"` (or `name='…'`) inside a tag's attribute text, decoded; undefined when absent. */
export const attributeOf = (attributes: string, name: string): string | undefined => {
    const match = new RegExp(`(?:^|\\s)${name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
    if (match === null) {
        return undefined;
    }
    return decodeEntities(match[1] ?? match[2] ?? "");
};
