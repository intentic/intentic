import { describe, expect, test } from "vitest";
import { composeProjectName, rankStacks, repoLinks } from "./komodo-repos.js";

const ROOT = "/work";
// A fake filesystem: path → contents. Anything absent reads as undefined, exactly like services.files.read.
const fs = (files: Record<string, string>) => ({ root: ROOT, read: async (path: string) => files[path] });

describe("composeProjectName", () => {
    test("reads the top-level name, quoted or bare", () => {
        expect(composeProjectName(`name: intentic\n\nservices:\n  api:\n`)).toBe("intentic");
        expect(composeProjectName(`name: "my app"\n`)).toBe("my app");
        expect(composeProjectName(`name: 'my-app'\n`)).toBe("my-app");
    });

    test("ignores a `name` that is not the top-level key", () => {
        // A service called `name`, or a container_name — indented, so not the project's own name.
        expect(composeProjectName(`services:\n    web:\n        name: nope\n`)).toBeUndefined();
    });

    test("stops at a trailing comment and answers undefined for a file with no name", () => {
        expect(composeProjectName(`name: keep # not this\n`)).toBe("keep");
        expect(composeProjectName(`services:\n  api:\n    image: x\n`)).toBeUndefined();
    });
});

describe("rankStacks", () => {
    const stacks = ["atlas", "auto-translate", "intentic-platform", "intentic-web-platform", "unrelated"];

    // The case that motivated this: the repo calls itself `intentic`, Komodo calls the halves of it
    // `intentic-platform` and `intentic-web-platform`.
    test("prefix matches rank above mere containment, exact above both", () => {
        expect(rankStacks("intentic", stacks)).toEqual(["intentic-platform", "intentic-web-platform"]);
        expect(rankStacks("atlas", stacks)).toEqual(["atlas"]);
    });

    test("separators and case do not count", () => {
        expect(rankStacks("Auto_Translate", stacks)).toEqual(["auto-translate"]);
        expect(rankStacks("intentic-web-platform", stacks)).toEqual(["intentic-web-platform"]);
    });

    // A stack nobody could have guessed belongs in the full picker, not in a suggestion list that would then
    // suggest everything.
    test("offers nothing when nothing resembles the project", () => {
        expect(rankStacks("totally-different", stacks)).toEqual([]);
        expect(rankStacks("", stacks)).toEqual([]);
    });

    test("orders stably by rank then name", () => {
        expect(rankStacks("int", ["intentic-web-platform", "intentic-platform", "print-service"])).toEqual([
            "intentic-platform",
            "intentic-web-platform",
            "print-service",
        ]);
    });
});

describe("repoLinks", () => {
    test("uses the compose file's own name and reports where it looked", async () => {
        const links = await repoLinks(fs({ "/work/intentic/docker-compose.yml": `name: intentic\n` }), ["/work/intentic"], ["intentic-platform"], {});
        expect(links).toEqual([
            {
                repo: "intentic",
                projectName: "intentic",
                composePath: "intentic/docker-compose.yml",
                suggestions: ["intentic-platform"],
            },
        ]);
    });

    test("falls back to the directory name, the way docker compose does", async () => {
        const links = await repoLinks(fs({ "/work/shop/compose.yaml": `services:\n  api:\n` }), ["/work/shop"], ["shop"], {});
        expect(links[0]?.projectName).toBe("shop");
        expect(links[0]?.suggestions).toEqual(["shop"]);
    });

    test("prefers the compose file docker would pick first", async () => {
        const files = { "/work/a/compose.yaml": `name: first\n`, "/work/a/docker-compose.yml": `name: second\n` };
        expect((await repoLinks(fs(files), ["/work/a"], [], {}))[0]?.projectName).toBe("first");
    });

    test("a repo with no compose file is not a candidate", async () => {
        expect(await repoLinks(fs({}), ["/work/plain"], ["anything"], {})).toEqual([]);
    });

    test("carries the owner's link through, and supports several at once", async () => {
        const files = { "/work/a/compose.yaml": `name: a\n`, "/work/b/compose.yaml": `name: b\n` };
        const links = await repoLinks(fs(files), ["/work/a", "/work/b"], ["prod-a", "prod-b"], { a: "prod-a", b: "prod-b" });
        expect(links.map((link) => [link.repo, link.linkedStack])).toEqual([
            ["a", "prod-a"],
            ["b", "prod-b"],
        ]);
    });

    // A link to a stack that has since been deleted must not render as a working link: dropping it returns the
    // row to its suggestion state, which is the one the owner can act on.
    test("drops a link to a stack Komodo no longer has", async () => {
        const links = await repoLinks(fs({ "/work/a/compose.yaml": `name: a\n` }), ["/work/a"], ["still-here"], { a: "deleted-stack" });
        expect(links[0]?.linkedStack).toBeUndefined();
    });
});
