import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import { describe, it, expect } from "bun:test";
import { collectAccess, formatAccessSummary, writeAccessFile } from "./access.js";

const node = (id: string, type: string, inputs: ResourceNode["inputs"]): ResourceNode => ({ id, type, inputs, dependsOn: [] });
const gen = (key: string) => ({ $secret: { source: "generated" as const, key } });
const env = (key: string) => ({ $secret: { source: "env" as const, key } });

const graph: DesiredStateGraph = {
    version: 1,
    resources: {
        "host-git": node("host-git", "forgejo", { adminUser: "intentic", adminPassword: gen("FORGEJO_ADMIN_PASSWORD") }),
        // env-source here to exercise the user-supplied branch alongside the generated one.
        "host-deploy": node("host-deploy", "komodo", { adminUser: "intentic", adminPassword: env("KOMODO_ADMIN_PASSWORD") }),
        "my-app.production": node("my-app.production", "deployment", {}),
        host: node("host", "host", {}),
    },
};

const outputs = {
    "host-git": { url: "https://git.example.com", internalUrl: "http://10.0.0.1:3000" },
    "host-deploy": { url: "https://deploy.example.com" },
    "my-app.production": { url: "https://app.example.com" },
    host: { internalIp: "10.0.0.1" },
};

describe("collectAccess", () => {
    it("carries password references only; apps are URL-only", () => {
        const entries = collectAccess(graph, outputs);

        expect(entries).toContainEqual({
            id: "host-git",
            label: "Forgejo (git)",
            url: "https://git.example.com",
            username: "intentic",
            password: { source: "generated", key: "FORGEJO_ADMIN_PASSWORD" },
        });
        expect(entries).toContainEqual({
            id: "host-deploy",
            label: "Komodo (deploys)",
            url: "https://deploy.example.com",
            username: "intentic",
            password: { source: "env", key: "KOMODO_ADMIN_PASSWORD" },
        });
        expect(entries).toContainEqual({ id: "my-app.production", label: "my-app.production", url: "https://app.example.com" });
        expect(entries.some((entry) => entry.id === "host")).toBe(false);
    });

    it("skips a service whose url output is absent", () => {
        const entries = collectAccess(graph, { "host-git": {}, "host-deploy": {}, "my-app.production": {}, host: {} });
        expect(entries).toEqual([]);
    });
});

describe("formatAccessSummary", () => {
    // The generated value used to print here and the run's own redactor masked it, so the line read `«redacted»`.
    it("names the store for a generated password and the reference for an env one", () => {
        const entries = collectAccess(graph, outputs);
        const summary = formatAccessSummary(entries);

        expect(summary).toContain("user: intentic");
        expect(summary).toContain("password: FORGEJO_ADMIN_PASSWORD in .secrets.json");
        expect(summary).toContain("password: $KOMODO_ADMIN_PASSWORD");
        expect(summary).toContain("https://app.example.com");
    });
});

describe("writeAccessFile", () => {
    it("never writes a generated value into the committed file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-access-"));
        const path = join(dir, "access.md");
        await writeAccessFile(path, collectAccess(graph, outputs));

        const markdown = await readFile(path, "utf8");
        expect(markdown).toContain("generated (see `.secrets.json`)");
        expect(markdown).toContain("`$KOMODO_ADMIN_PASSWORD`");
    });
});
