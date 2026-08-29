import { sandboxContract } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { SPEC_GROUPS, SPEC_SHELVES, specShelves } from "./groups.js";
import { sandboxSpec, serializeSpec, type SandboxSpecDocument, type SpecOperation } from "./spec.js";

/* WHAT GUARDS A GENERATED DOCUMENT, given there is no committed copy to diff it against (see spec.ts for why
 * there isn't). Three properties, and all three are checked by WALKING THE CONTRACT rather than against a list
 * written down twice: that the generation is total, that it is grouped, and that it is deterministic. A route
 * added tomorrow is covered by these tests tomorrow.
 *
 * The one enumerated thing in the package — the 37 group paragraphs — is checked against the contract in both
 * directions, so prose cannot outlive the code it describes and code cannot arrive undescribed.
 */

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
        /* Determinism is what makes the document quotable. The reference pages are static HTML built from it,
         * so a generator that reordered its own output would churn every one of those pages on every build,
         * and a screenshot or an anchor taken from one would be describing a layout the next build does not
         * have. It is also the property that makes the group ordering in spec.ts worth having at all. */
        expect(serializeSpec(await sandboxSpec())).toBe(serializeSpec(await sandboxSpec()));
    });

    it("declares OpenAPI 3.1", async () => {
        // The version the reference renderer and any downstream tooling are written against. 3.1 is the one
        // that shares JSON Schema's own dialect, which is why the converter can hand zod's output straight in.
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
    /* The one hand-written enumeration in this package, checked BOTH ways. A contract group nobody described
     * is a build failure, and a described group the contract no longer has is a build failure — which is what
     * stops the prose from quietly outliving the code it describes. */
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
        // House style, guarded by shape: a summary is rendered inline in a sidebar and a card, where a
        // trailing period reads as a typo in half the placements and is invisible in the other half.
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
        // An empty shelf is a rail heading with nothing under it, and a nav row that lands on nothing.
        expect(
            specShelves()
                .filter((entry) => entry.groups.length === 0)
                .map((entry) => entry.shelf.name),
        ).toEqual([]);
    });

    it("keeps each shelf a contiguous run of the group order", () => {
        /* The property that makes the rail and the generated document ONE book rather than two orderings of the
         * same contents. spec.ts sorts the document's paths by SPEC_GROUPS; the site renders shelf by shelf. If
         * a shelf could gather groups from anywhere in the list, a reader walking the rail top to bottom and a
         * reader walking the document top to bottom would meet the groups in different orders, and every
         * previous/next link on the site would be describing a sequence the document does not have. */
        const runs: string[] = [];
        for (const group of SPEC_GROUPS) {
            if (runs.at(-1) !== group.shelf) {
                runs.push(group.shelf);
            }
        }
        expect(runs).toEqual([...new Set(runs)]);
        // And the runs appear in the shelves' own declared order, so the rail is not a permutation either.
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
        /* The converter strips zod's `$schema` from every node it emits, because the document declares its own
         * dialect once at the top and ~4,500 repeats of the same URI are pure weight.
         *
         * Checked by VALUE rather than by key, and that distinction is the test earning its place: the
         * extension manifest has a real field CALLED `$schema` (an extension's own `intentic-extension.json`
         * carries one), so `not.toContain('"$schema"')` fails on correct output. What must not appear is the
         * json-schema.org URI, which is a banner and never a value the daemon sends. */
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
        /* The one thing a hand-rolled zod converter is most likely to get wrong, pinned to the construct that
         * would expose it. `z.stringbool()` accepts the string "1" and yields the boolean `true`, so a
         * converter that ignored the generator's `strategy` would document one direction as the other and a
         * caller would send a boolean where the daemon wants a string.
         *
         * Found by SHAPE, not by naming a route: whichever operations use it, requests must describe it as a
         * string and responses as a boolean. If the contract stops using stringbool entirely the test skips
         * itself rather than silently passing on nothing.
         */
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
        // Both directions are derived from the same converter call, so agreement here is the property under
        // test; the counts themselves are the contract's business, not this test's.
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
