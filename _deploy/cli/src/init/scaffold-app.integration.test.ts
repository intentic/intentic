import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldApp } from "./scaffold-app.js";

describe("scaffoldApp", () => {
    let root: string;
    let appDir: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "intentic-scaffold-app-"));
        appDir = join(root, "app");
        await scaffoldApp(appDir, undefined);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("writes a Dockerfile that installs from the manifest before it copies the source", async () => {
        const lines = (await readFile(join(appDir, "Dockerfile"), "utf8")).split("\n");
        const manifest = lines.indexOf("COPY package*.json ./");
        const install = lines.findIndex((line) => line.startsWith("RUN ") && line.includes("npm install --omit=dev"));
        const source = lines.indexOf("COPY . .");

        expect(manifest).toBeGreaterThan(-1);
        expect(install).toBeGreaterThan(manifest);
        expect(source).toBeGreaterThan(install);
        // A cache mount, so a rebuild on the same builder fetches no package it already has.
        expect(lines[install]).toContain("--mount=type=cache,target=/root/.npm");
        // The scaffold writes no lockfile, so nothing may require one.
        expect(lines.some((line) => line.includes("npm ci"))).toBe(false);
    });

    it("keeps the git history, host-installed dependencies and env files out of the build context", async () => {
        const ignored = (await readFile(join(appDir, ".dockerignore"), "utf8")).split("\n");

        expect(ignored).toEqual(expect.arrayContaining([".git", "**/node_modules", "**/.env*"]));
        // The manifest the Dockerfile copies first has to reach the build.
        expect(ignored).not.toContain("package.json");
    });
});
