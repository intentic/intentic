import { Parser } from "htmlparser2";
import { RecordSchema, WebUrlSchema, type NetworkRecord } from "../records.js";

export const plain = (html: string, limit = 100000): string => {
    let result = "";
    let hidden = 0;
    const parser = new Parser({
        onopentag(name) { if (["script", "style", "template"].includes(name)) {hidden++;} else if (!hidden && ["p", "div", "br", "li"].includes(name)) {result += "\n";} },
        onclosetag(name) { if (["script", "style", "template"].includes(name) && hidden) {hidden--;} },
        ontext(text) { if (!hidden && result.length < limit) {result += text;} },
    }, { decodeEntities: true });
    parser.end(html);
    return result.replaceAll(/\n{3,}/gu, "\n\n").trim().slice(0, limit);
};
export const webUrl = (input: string | undefined, base?: string): string | undefined => {
    if (!input) {return undefined;}
    // allow(silent-catch): an address that does not parse is no link; the record keeps none
    try { const result = WebUrlSchema.safeParse(new URL(input, base).href); return result.success ? result.data : undefined; } catch { return undefined; }
};
export const isoDate = (value: string | number | undefined): string | undefined => {
    if (value === undefined) {return undefined;}
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
export const recordOf = (bridge: string, input: Omit<NetworkRecord, "@context" | "sdPublisher" | "keywords" | "image"> & Partial<Pick<NetworkRecord, "keywords" | "image">>): NetworkRecord => RecordSchema.parse({
    ...input,
    "@context": "https://schema.org",
    sdPublisher: { "@type": "SoftwareApplication", name: `intentic.network/${bridge}` },
    headline: plain(input.headline, 1000),
    text: input.text === undefined ? undefined : plain(input.text),
    articleBody: input.articleBody === undefined ? undefined : plain(input.articleBody),
    author: input.author ? { ...input.author, name: plain(input.author.name, 500) } : undefined,
    keywords: input.keywords?.slice(0, 50).map((word) => plain(word, 100)),
    image: input.image?.slice(0, 10).filter((url) => webUrl(url)),
});
