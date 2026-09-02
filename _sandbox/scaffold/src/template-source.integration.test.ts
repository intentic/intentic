import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addAppsToMonorepo, scaffoldMonorepo, templateArchiveUrl } from "./inject-template.js";

const exec = promisify(execFile);

/* How the template source is FETCHED, against an origin that behaves the way github.com behaves from
 * datacenter egress: the git endpoint answers an unauthenticated `git-upload-pack` with a Basic-auth
 * challenge, the source archive is served to anyone. That asymmetry is not hypothetical — it is what turned
 * the image build's starter-site layer into `could not read Username for 'https://github.com'` and took the
 * `images` job down. A scaffold that reaches for `git clone` first fails every one of these tests.
 */
const templateFiles: Readonly<Record<string, string>> = {
    "templates.json": JSON.stringify({
        scope: "@app_/",
        shell: ["package.json", "pnpm-workspace.yaml", "turbo.json"],
        shared: ["_libs/ui"],
        templates: {
            landing: {
                label: "Landing",
                description: "A landing page",
                instance: ["_apps/landing"],
                previews: [{ package: "landing", dev: "pnpm --filter {pkg} dev", port: 3000 }],
            },
        },
    }),
    "package.json": '{ "name": "template-root" }',
    "pnpm-workspace.yaml": "packages:\n  - _libs/*\n  - _apps/*\n",
    "turbo.json": "{}",
    "_libs/ui/package.json": '{ "name": "@app_/ui" }',
    "_apps/landing/package.json": '{ "name": "@app_/landing" }',
};

// A template checkout on disk + the source archive github.com would serve for it.
const writeTemplate = async (dir: string): Promise<string> => {
    for (const [path, contents] of Object.entries(templateFiles)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), `${contents}\n`);
    }
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "template"]);
    // GitHub wraps its archives in one <repo>-<ref> directory, which the fetch strips.
    const archive = join(dir, "..", "source.tar.gz");
    await exec("tar", ["czf", archive, "--exclude=.git", "--transform=s|^\\.|canonical-main|", "-C", dir, "."]);
    return archive;
};

describe("template source fetch", () => {
    let root: string;
    let origin: Server;
    let source: string;
    let hits: string[];

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "intentic-template-source-"));
        const archive = await writeTemplate(join(root, "template"));
        hits = [];
        origin = createServer((request, response) => {
            const url = request.url ?? "";
            hits.push(url);
            if (url.includes("/info/refs")) {
                // Exactly what github.com answers an unauthenticated ref advertisement from a datacenter.
                response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
                response.end("Requires authentication\n");
                return;
            }
            if (url.endsWith("/archive/main.tar.gz")) {
                response.writeHead(200, { "content-type": "application/x-gzip" });
                exec("cat", [archive], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }).then(
                    ({ stdout }) => response.end(stdout),
                    () => response.destroy(),
                );
                return;
            }
            response.writeHead(404);
            response.end();
        });
        await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
        const address = origin.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        source = `http://127.0.0.1:${port}/owner/canonical`;
    });
    afterAll(async () => {
        await new Promise<void>((resolve) => origin.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    });

    test("an http source resolves to its archive; anything else stays on git", () => {
        expect(templateArchiveUrl("https://github.com/radarsu/00-canonical-repo", "main")).toBe(
            "https://github.com/radarsu/00-canonical-repo/archive/main.tar.gz",
        );
        // A trailing slash or .git suffix is still the same repo.
        expect(templateArchiveUrl("https://github.com/o/r.git", "v1.2.3")).toBe("https://github.com/o/r/archive/v1.2.3.tar.gz");
        expect(templateArchiveUrl("https://github.com/o/r/", "main")).toBe("https://github.com/o/r/archive/main.tar.gz");
        // No archive endpoint to reach for: a local checkout and an ssh remote clone as before.
        expect(templateArchiveUrl("/home/user/00-canonical-repo", "main")).toBeUndefined();
        expect(templateArchiveUrl("git@github.com:o/r.git", "main")).toBeUndefined();
    });

    test("scaffolding a monorepo takes the archive, never the git endpoint that would prompt for a username", async () => {
        const repoDir = join(root, "starter");
        await scaffoldMonorepo({ repoDir, source, ref: "main" });

        for (const shell of ["package.json", "pnpm-workspace.yaml", "turbo.json"]) {
            expect(existsSync(join(repoDir, shell))).toBe(true);
        }
        expect(existsSync(join(repoDir, "_libs/ui"))).toBe(true);
        expect(existsSync(join(repoDir, ".git"))).toBe(true);
        expect(hits).toContain("/owner/canonical/archive/main.tar.gz");
        expect(hits.some((url) => url.includes("git-upload-pack"))).toBe(false);
    });

    test("adding an app to that monorepo fetches the same way", async () => {
        const repoDir = join(root, "starter");
        const lines: string[] = [];
        for await (const line of addAppsToMonorepo({
            repoDir,
            source,
            ref: "main",
            apps: [{ template: "landing", name: "landing" }],
            install: false,
        })) {
            lines.push(line);
        }
        expect(lines.some((line) => line.includes("Adding landing"))).toBe(true);
        expect(existsSync(join(repoDir, "_apps/landing"))).toBe(true);
        expect(hits.some((url) => url.includes("git-upload-pack"))).toBe(false);
    });

    test("a local checkout still scaffolds, over git", async () => {
        const repoDir = join(root, "from-local");
        await scaffoldMonorepo({ repoDir, source: join(root, "template"), ref: "main" });
        expect(existsSync(join(repoDir, "package.json"))).toBe(true);
        expect(existsSync(join(repoDir, "_libs/ui"))).toBe(true);
    });
});
