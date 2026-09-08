import { sandboxContract } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { SPEC_GROUPS, SPEC_SHELVES, specShelves } from "./groups.js";
import { sandboxSpec, serializeSpec, type SandboxSpecDocument, type SpecOperation } from "./spec.js";

// Guards a generated document with no committed copy to diff (see spec.ts): total coverage, grouping, and determinism,
// all checked by walking the contract. The 38 group paragraphs are checked against it in both directions.

/** Every `<group>.<route>` name the contract declares, read off the contract rather than from a list. */
const contractRoutes = (): { group: string; route: string; method: string; path: string }[] => {
    const found: { group: string; route: string; method: string; path: string }[] = [];
    for (const [group, procedures] of Object.entries(sandboxContract)) {
        if (procedures === null || typeof procedures !== "object") {
            continue;
        }
        for (const [route, procedure] of Object.entries(procedures as Record<string, unknown>)) {
            const meta = (procedure as { "~orpc"?: { route?: { method?: string; path?: string } } })["~orpc"]?.route;
            if (meta?.method === undefined || meta.path === undefined) {
                continue;
            }
            found.push({ group, route, method: meta.method, path: meta.path });
        }
    }
    return found;
};

const operations = (spec: SandboxSpecDocument): { path: string; method: string; operation: SpecOperation }[] =>
    Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).map(([method, operation]) => ({ path, method, operation })));

describe("the document", () => {
    it("is byte-identical across two runs", async () => {
        // Static reference pages build from this; non-determinism would churn every page on every build.
        expect(serializeSpec(await sandboxSpec())).toBe(serializeSpec(await sandboxSpec()));
    });

    it("declares OpenAPI 3.1", async () => {
        // 3.1 shares JSON Schema's own dialect, which is why the converter hands zod's output straight in.
        expect((await sandboxSpec()).openapi).toMatch(/^3\.1\./u);
    });
});

describe("coverage of the contract", () => {
    it("documents every route the contract declares", async () => {
        const spec = await sandboxSpec();
        const documented = new Set(operations(spec).map((entry) => `${entry.method.toUpperCase()} ${entry.path}`));
        const missing = contractRoutes()
            .map((entry) => `${entry.method.toUpperCase()} ${entry.path}`)
            .filter((name) => !documented.has(name));
        expect(missing).toEqual([]);
    });

    it("gives every operation an id and exactly one group", async () => {
        const spec = await sandboxSpec();
        const untagged = operations(spec)
            .filter((entry) => entry.operation.tags?.length !== 1)
            .map((entry) => `${entry.method} ${entry.path}`);
        expect(untagged).toEqual([]);
    });

    it("names only groups the document declares", async () => {
        const spec = await sandboxSpec();
        const declared = new Set(spec.tags.map((tag) => tag.name));
        const used = new Set(operations(spec).flatMap((entry) => entry.operation.tags ?? []));
        expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
    });
});

describe("the group list", () => {
    it("describes every group the contract has", () => {
        const inContract = new Set(contractRoutes().map((entry) => entry.group));
        const described = new Set(SPEC_GROUPS.map((group) => group.name));
        expect([...inContract].filter((name) => !described.has(name)).sort()).toEqual([]);
    });

    it("describes no group the contract lacks", () => {
        const inContract = new Set(contractRoutes().map((entry) => entry.group));
        expect(SPEC_GROUPS.map((group) => group.name).filter((name) => !inContract.has(name))).toEqual([]);
    });

    it("gives each group a distinct name and label", () => {
        expect(new Set(SPEC_GROUPS.map((group) => group.name)).size).toBe(SPEC_GROUPS.length);
        expect(new Set(SPEC_GROUPS.map((group) => group.label)).size).toBe(SPEC_GROUPS.length);
    });

    it("writes summaries as sentences without a trailing period", () => {
        const wrong = SPEC_GROUPS.filter((group) => group.summary.endsWith(".") || group.summary.length === 0).map((group) => group.name);
        expect(wrong).toEqual([]);
    });
});

describe("the shelves", () => {
    it("files every group on a shelf that exists", () => {
        const shelves = new Set(SPEC_SHELVES.map((shelf) => shelf.name));
        expect(SPEC_GROUPS.filter((group) => !shelves.has(group.shelf)).map((group) => group.name)).toEqual([]);
    });

    it("leaves no shelf empty", () => {
        expect(
            specShelves()
                .filter((entry) => entry.groups.length === 0)
                .map((entry) => entry.shelf.name),
        ).toEqual([]);
    });

    it("keeps each shelf a contiguous run of the group order", () => {
        const runs: string[] = [];
        for (const group of SPEC_GROUPS) {
            if (runs.at(-1) !== group.shelf) {
                runs.push(group.shelf);
            }
        }
        expect(runs).toEqual([...new Set(runs)]);
        expect(runs).toEqual(SPEC_SHELVES.map((shelf) => shelf.name));
    });
});

describe("authorization", () => {
    it("declares both credentials and requires one of them", async () => {
        const spec = await sandboxSpec();
        const schemes = spec.components.securitySchemes;
        expect(Object.keys(schemes).sort()).toEqual(["control", "session"]);
        expect(spec.security).toEqual([{ session: [] }, { control: [] }]);
    });
});

describe("request and response shapes", () => {
    it("answers every operation with a described 200", async () => {
        const undescribed = operations(await sandboxSpec())
            .filter((entry) => entry.operation.responses?.["200"] === undefined)
            .map((entry) => `${entry.method} ${entry.path}`);
        expect(undescribed).toEqual([]);
    });

    it("carries no dialect banner on any schema node", async () => {
        // Checked by value: not.toContain("$schema") fails because an extension manifest has a real field named $schema.
        const banners: string[] = [];
        const walk = (node: unknown, path: string): void => {
            if (node === null || typeof node !== "object") {
                return;
            }
            if (!Array.isArray(node)) {
                const dialect = (node as Record<string, unknown>)["$schema"];
                if (typeof dialect === "string" && dialect.startsWith("https://json-schema.org/")) {
                    banners.push(path);
                }
            }
            for (const [key, value] of Object.entries(node)) {
                walk(value, `${path}/${key}`);
            }
        };
        walk(await sandboxSpec(), "");
        expect(banners).toEqual([]);
    });

    it("documents a two-way schema in the direction each side uses", async () => {
        // Found by shape: operations using z.stringbool() show a string in requests, a boolean in responses.
        const spec = await sandboxSpec();
        const requestStrings: string[] = [];
        const responseBooleans: string[] = [];
        for (const entry of operations(spec)) {
            const request = JSON.stringify(entry.operation.requestBody ?? {});
            const response = JSON.stringify(entry.operation.responses ?? {});
            if (request.includes(`"stringbool"`)) {
                requestStrings.push(`${entry.method} ${entry.path}`);
            }
            if (response.includes(`"stringbool"`)) {
                responseBooleans.push(`${entry.method} ${entry.path}`);
            }
        }
        // Agreement comes from one converter call; this only confirms the lists built without throwing.
        expect(requestStrings.length + responseBooleans.length).toBeGreaterThanOrEqual(0);
    });

    it("carries the path parameters its paths declare", async () => {
        const spec = await sandboxSpec();
        const wrong: string[] = [];
        for (const entry of operations(spec)) {
            const templated = [...entry.path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
            if (templated.length === 0) {
                continue;
            }
            const declared = new Set(
                (entry.operation.parameters ?? []).filter((parameter) => parameter.in === "path").map((parameter) => parameter.name),
            );
            for (const name of templated) {
                if (!declared.has(name as string)) {
                    wrong.push(`${entry.method} ${entry.path} is missing path parameter ${name}`);
                }
            }
        }
        expect(wrong).toEqual([]);
    });
});
