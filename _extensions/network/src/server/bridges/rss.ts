import { Parser } from "htmlparser2";
import { z } from "zod";
import type { BridgeItem } from "../records.js";
import { isoDate, plain, recordOf, webUrl } from "./normalize.js";

interface XmlNode { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] }
const children = (node: XmlNode, name: string): XmlNode[] => node.children.filter((child) => child.name === name);
const value = (node: XmlNode, name: string): string | undefined => children(node, name)[0]?.text.trim() || undefined;

const xmlTree = (xml: string): XmlNode => {
    const root: XmlNode = { name: "root", attrs: {}, text: "", children: [] };
    const stack = [root];
    const parser = new Parser({
        onopentag(name, attrs) {
            if (stack.length > 64) {throw new Error("Feed XML is too deeply nested");}
            const node = { name, attrs, text: "", children: [] };
            stack.at(-1)!.children.push(node);
            stack.push(node);
        },
        ontext(text) { stack.at(-1)!.text += text; },
        onclosetag() { if (stack.length > 1) { const node = stack.pop()!; stack.at(-1)!.text += node.text; } },
    }, { xmlMode: true, decodeEntities: true });
    parser.end(xml);
    return root;
};

const JsonAuthor = z.looseObject({ name: z.string().optional(), url: z.string().optional() });
const JsonFeed = z.looseObject({
    version: z.string().startsWith("https://jsonfeed.org/version/"), language: z.string().optional(),
    authors: z.array(JsonAuthor).optional(), author: JsonAuthor.optional(),
    items: z.array(z.looseObject({ id: z.string(), url: z.string().optional(), title: z.string().optional(), content_text: z.string().optional(), content_html: z.string().optional(), summary: z.string().optional(), date_published: z.string().optional(), image: z.string().optional(), tags: z.array(z.string()).optional(), authors: z.array(JsonAuthor).optional(), author: JsonAuthor.optional() })),
});

type JsonFeedAuthor = z.infer<typeof JsonAuthor>;
const jsonAuthorOf = (author: JsonFeedAuthor | undefined) => (author ? { "@type": "Person" as const, name: author.name ?? "", url: webUrl(author.url) } : undefined);

const jsonFeedItems = (body: string, sourceUrl: string): BridgeItem[] => {
    const feed = JsonFeed.parse(JSON.parse(body));
    return feed.items.slice(0, 100).map((entry) => {
        const url = webUrl(entry.url, sourceUrl);
        const content = entry.content_text ?? entry.content_html ?? entry.summary ?? "";
        const image = webUrl(entry.image, sourceUrl);
        return { nativeId: entry.id, nativeUrl: url, verification: "unsigned", record: recordOf("rss", {
            "@type": "BlogPosting", headline: entry.title ?? plain(content).slice(0, 160), articleBody: content, url,
            datePublished: isoDate(entry.date_published), author: jsonAuthorOf(entry.authors?.[0] ?? entry.author ?? feed.authors?.[0] ?? feed.author),
            isBasedOn: [sourceUrl, entry.id], inLanguage: feed.language, keywords: entry.tags, image: image ? [image] : [],
        }) };
    });
};

// One RSS item or Atom entry; `feed` is the Atom feed it sits in, `channel` the RSS channel.
interface XmlContext { readonly feed: XmlNode | undefined; readonly channel: XmlNode | undefined; readonly sourceUrl: string }

const xmlLink = (entry: XmlNode, { feed, sourceUrl }: XmlContext): string | undefined => {
    const atomLink = children(entry, "link").find((link) => !link.attrs["rel"] || link.attrs["rel"] === "alternate")?.attrs["href"];
    return webUrl(feed ? atomLink : value(entry, "link"), sourceUrl);
};

const xmlAuthor = (entry: XmlNode, { feed }: XmlContext) => {
    const node = children(entry, "author")[0] ?? (feed ? children(feed, "author")[0] : undefined);
    const name = (node && (value(node, "name") ?? node.text.trim())) ?? value(entry, "dc:creator");
    return name ? { "@type": "Person" as const, name, url: node ? webUrl(value(node, "uri")) : undefined } : undefined;
};

const xmlImages = (entry: XmlNode, sourceUrl: string): string[] =>
    children(entry, "enclosure")
        .filter((node) => node.attrs["type"]?.startsWith("image/"))
        .flatMap((node) => { const image = webUrl(node.attrs["url"], sourceUrl); return image ? [image] : []; });

const xmlItem = (entry: XmlNode, context: XmlContext): BridgeItem => {
    const { feed, channel, sourceUrl } = context;
    const url = xmlLink(entry, context);
    const body = value(entry, "content:encoded") ?? value(entry, "content") ?? value(entry, "description") ?? value(entry, "summary") ?? "";
    const published = value(entry, "pubDate") ?? value(entry, "published") ?? value(entry, "updated");
    const nativeId = value(entry, feed ? "id" : "guid") ?? url ?? `${value(entry, "title") ?? ""}:${published ?? plain(body).slice(0, 200)}`;
    return { nativeId, nativeUrl: url, verification: "unsigned", record: recordOf("rss", {
        "@type": "Article", headline: value(entry, "title") ?? plain(body).slice(0, 160), articleBody: body, url,
        datePublished: isoDate(published), author: xmlAuthor(entry, context),
        isBasedOn: [sourceUrl, nativeId], inLanguage: feed?.attrs["xml:lang"] ?? (channel ? value(channel, "language") : undefined),
        keywords: children(entry, "category").map((tag) => tag.attrs["term"] ?? tag.text),
        image: xmlImages(entry, sourceUrl),
    }) };
};

export const parseFeed = (body: string, sourceUrl: string): BridgeItem[] => {
    if (body.trimStart().startsWith("{")) {
        return jsonFeedItems(body, sourceUrl);
    }
    const tree = xmlTree(body);
    const feed = children(tree, "feed")[0];
    const channel = children(children(tree, "rss")[0] ?? tree, "channel")[0];
    const container = feed ?? channel;
    if (container === undefined) {
        throw new Error("Expected RSS 2.0, Atom or JSON Feed");
    }
    return children(container, feed ? "entry" : "item").slice(0, 100).map((entry) => xmlItem(entry, { feed, channel, sourceUrl }));
};
