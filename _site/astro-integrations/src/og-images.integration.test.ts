import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ogImageUrl } from "@intentic/astro-integrations";
import { type OgNode, type OgPage, ogImages, readOgTags } from "@intentic/astro-integrations/og-images";
import { unstubbed } from "@intentic/testing";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "og-images-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const page = (tags: Record<string, string>, body = ""): string =>
    `<html><head>${Object.entries(tags)
        .map(([name, content]) => `<meta property="og:${name}" content="${content}">`)
        .join("")}</head><body>${body}</body></html>`;

/** A card with no text, so the test needs no font files: one coloured box the size of the card. */
const blankCard = (): OgNode => ({ type: "div", props: { style: { display: "flex", width: 40, height: 20, background: "#f5ede7" } } });

test("og: tags are read from <head> only, decoded as a browser would, first one winning", () => {
    const html =
        `<html><head><meta property="og:title" content="Docs &amp; API &#39;v2&#39; &#x2014; &quot;now&quot;">` +
        `<meta property="og:title" content="second">` +
        `<meta property="og:url" content="https://example.test/docs/">` +
        `<meta property="og:image" content="https://example.test/docs/index.png"></head>` +
        `<body><meta property="og:description" content="from the body"></body></html>`;

    expect(readOgTags(html)).toEqual({
        title: "Docs & API 'v2' — \"now\"",
        description: undefined,
        url: "https://example.test/docs/",
        image: "https://example.test/docs/index.png",
    });
});

test("a description that only repeats the title is dropped", () => {
    expect(readOgTags(page({ title: "Same words", description: "Same words" })).description).toBeUndefined();
    expect(readOgTags(page({ title: "Title", description: "Different words" })).description).toBe("Different words");
});

test.each([
    ["https://example.test/", "https://example.test/index.png"],
    ["https://example.test/docs/quickstart/", "https://example.test/docs/quickstart/index.png"],
    ["https://example.test/blog/post", "https://example.test/blog/post.png"],
    ["https://example.test/404/", "https://example.test/404.png"],
    ["https://example.test/500/", "https://example.test/500.png"],
])("the card for %s is %s", (pageUrl, card) => {
    expect(ogImageUrl(new URL(pageUrl))).toBe(card);
});

test("cards are drawn beside the pages that name their own card, and only those", async () => {
    const site = "https://example.test";
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "elsewhere"));
    await writeFile(
        join(root, "docs/index.html"),
        page({ title: "Docs &amp; more", description: "Read these", url: `${site}/docs/`, image: `${site}/docs/index.png` }),
    );
    // A page whose og:image is a shared picture has asked for no card of its own.
    await writeFile(join(root, "elsewhere/index.html"), page({ title: "Elsewhere", url: `${site}/elsewhere/`, image: `${site}/logo.png` }));
    // The 404 page is written flat, as dist/404.html, and its card beside it as dist/404.png.
    await writeFile(join(root, "404.html"), page({ title: "Not found", url: `${site}/404/`, image: `${site}/404.png` }));

    const seen: OgPage[] = [];
    const integration = ogImages({
        width: 40,
        height: 20,
        fonts: [],
        render: async (card, { rasterize }) => {
            seen.push(card);
            // A layer drawn with the tools comes back as a PNG the card can embed.
            const layer = await rasterize(blankCard(), { width: 8, height: 8 });
            expect([...layer.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
            return blankCard();
        },
    });
    const info = jest.fn();
    await integration.hooks["astro:build:done"]?.(
        unstubbed("Astro build", {
            dir: pathToFileURL(`${root}/`),
            pages: [{ pathname: "docs/" }, { pathname: "elsewhere/" }, { pathname: "404/" }],
            logger: unstubbed("Astro logger", { info, warn: jest.fn() }),
        }),
    );

    expect(seen.map((card) => card.pathname).toSorted()).toEqual(["404/", "docs/"]);
    expect(seen.find((card) => card.pathname === "docs/")).toEqual({
        pathname: "docs/",
        title: "Docs & more",
        description: "Read these",
        url: `${site}/docs/`,
    });
    expect([...(await readFile(join(root, "docs/index.png"))).subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    expect([...(await readFile(join(root, "404.png"))).subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    expect(await stat(join(root, "elsewhere/index.png")).catch(() => undefined)).toBeUndefined();
    expect(info).toHaveBeenCalledWith("2 OpenGraph cards drawn.");
});

test("a page that names its own card but has no og:title fails the build", async () => {
    await mkdir(join(root, "untitled"));
    await writeFile(join(root, "untitled/index.html"), page({ url: "https://example.test/untitled/", image: "https://example.test/untitled/index.png" }));
    const integration = ogImages({ width: 40, height: 20, fonts: [], render: blankCard });

    await expect(
        integration.hooks["astro:build:done"]?.(
            unstubbed("Astro build", {
                dir: pathToFileURL(`${root}/`),
                pages: [{ pathname: "untitled/" }],
                logger: unstubbed("Astro logger", { info: jest.fn(), warn: jest.fn() }),
            }),
        ),
    ).rejects.toThrow("has no og:title");
});
