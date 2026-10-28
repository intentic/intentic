import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { llmsText } from "@intentic/astro-integrations";
import { unstubbed } from "@intentic/testing";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "llms-text-"));
    await mkdir(join(root, "example"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test.each(["C:\\temp\\notes", "C:\\q", 'before\\"after', "first\n---\ninjected: yes", 'quotes " and colons: —'])(
    "Markdown metadata preserves %j as one quoted scalar",
    async (value) => {
        const escaped = value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        await writeFile(
            join(root, "example/index.html"),
            `<html><head><title>${escaped}</title><meta name="description" content="${escaped}"></head><main><p>Body</p></main></html>`,
        );
        const integration = llmsText({ name: "Sample", summary: "Sample" });
        await integration.hooks["astro:config:done"]?.(
            unstubbed("Astro config", { config: unstubbed("Astro config.config", { site: "https://example.test" }) }),
        );
        await integration.hooks["astro:build:done"]?.(
            unstubbed("Astro build", {
                dir: pathToFileURL(`${root}/`),
                pages: [{ pathname: "example/" }],
                logger: unstubbed("Astro build.logger", { info: jest.fn(), warn: jest.fn() }),
            }),
        );

        const markdown = await readFile(join(root, "example.md"), "utf8");
        const lines = markdown.split("\n");
        expect(lines.slice(0, 7)).toEqual([
            "---",
            `title: ${JSON.stringify(value)}`,
            `description: ${JSON.stringify(value)}`,
            'url: "https://example.test/example/"',
            "---",
            "",
            "Body",
        ]);
    },
);
