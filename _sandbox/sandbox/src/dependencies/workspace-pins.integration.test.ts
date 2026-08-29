import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorkspacePins } from "./workspace-pins.js";

const workspace = async (files: Record<string, string>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "pins-"));
    for (const [path, body] of Object.entries(files)) {
        const full = join(root, path);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, body, "utf8");
    }
    return root;
};

const withWorkspace = async (files: Record<string, string>, check: (root: string) => void | Promise<void>): Promise<void> => {
    const root = await workspace(files);
    try {
        await check(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
};

/* The catalog is where nearly every version in a workspace like this one actually lives, and it is the one
 * place nothing that walks PACKAGES would ever see: a catalog entry is not a dependency of anything. */
test("the pnpm catalog is read, since that is where a monorepo keeps its versions", async () => {
    await withWorkspace({ "pnpm-workspace.yaml": `packages:\n  - "app"\ncatalog:\n  typescript: 5.9.3\n  vue: 3.5.40\n` }, (root) => {
        const known = createWorkspacePins(root);
        expect([...known("npm", "typescript")]).toEqual(["5.9.3"]);
        expect([...known("npm", "vue")]).toEqual(["3.5.40"]);
    });
});

test("named catalogs count too", async () => {
    await withWorkspace({ "pnpm-workspace.yaml": `packages: []\ncatalogs:\n  react18:\n    react: 18.3.1\n` }, (root) => {
        expect([...createWorkspacePins(root)("npm", "react")]).toEqual(["18.3.1"]);
    });
});

test("a package's own dependency blocks count, and a range is reduced to the version under it", async () => {
    await withWorkspace(
        {
            "pnpm-workspace.yaml": `packages:\n  - "app"\n`,
            "app/package.json": JSON.stringify({ name: "app", dependencies: { hono: "^4.12.34" }, devDependencies: { vitest: "4.1.10" } }),
        },
        (root) => {
            const known = createWorkspacePins(root);
            expect([...known("npm", "hono")]).toEqual(["4.12.34"]);
            expect([...known("npm", "vitest")]).toEqual(["4.1.10"]);
        },
    );
});

test("two packages on different versions of one dependency are both remembered", async () => {
    await withWorkspace(
        {
            "pnpm-workspace.yaml": `packages:\n  - "a"\n  - "b"\n`,
            "a/package.json": JSON.stringify({ name: "a", dependencies: { zod: "4.4.3" } }),
            "b/package.json": JSON.stringify({ name: "b", dependencies: { zod: "3.25.76" } }),
        },
        (root) => {
            expect([...createWorkspacePins(root)("npm", "zod")].sort()).toEqual(["3.25.76", "4.4.3"]);
        },
    );
});

test.each(["workspace:*", "catalog:", "file:../thing", "*", "latest"])("a specifier naming no concrete version is not a pin: %s", async (specifier) => {
    await withWorkspace(
        { "pnpm-workspace.yaml": `packages:\n  - "app"\n`, "app/package.json": JSON.stringify({ name: "app", dependencies: { thing: specifier } }) },
        (root) => {
            expect([...createWorkspacePins(root)("npm", "thing")]).toEqual([]);
        },
    );
});

/* npm only. The catalog and the manifests this reads are npm's, and answering for PyPI out of them would
 * suppress a real notice on the strength of a name that happens to collide. */
test("another ecosystem is never answered for out of npm's manifests", async () => {
    await withWorkspace({ "pnpm-workspace.yaml": `packages: []\ncatalog:\n  requests: 2.20.0\n` }, (root) => {
        expect([...createWorkspacePins(root)("pypi", "requests")]).toEqual([]);
    });
});

// An unreadable tree means no opinion, which errs toward reporting: a missed suppression is one notice too
// many, while a walk that threw would be a hook failing in front of a tool call.
test("a workspace with nothing to read yields no opinion rather than an error", async () => {
    await withWorkspace({}, (root) => {
        expect([...createWorkspacePins(root)("npm", "vue")]).toEqual([]);
    });
});
