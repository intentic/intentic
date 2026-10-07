import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api/protocol";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { RAW_ROUTE_LIST, SANDBOX_ROUTES } from "@intentic/sandbox-contract";
import { promisedPaths } from "../extension-readiness.js";

// Every extension in this repository, held to what an outside author's would be held to before it ships: its manifest
// parses, this build of the host activates it, every file it promises from source is there, and every route it
// declares it will reach is one the daemon actually serves. A declaration that reaches nothing is reach an owner is
// asked to approve for no reason, and the first thing a renamed route leaves behind.

const extensionsRoot = join(repoRoot(import.meta.url), "_extensions");

// Each read whole and parsed below, where a manifest that does not parse is the finding.
const manifestOf = (dir: string): ReturnType<typeof ExtensionManifestSchema.safeParse> =>
    ExtensionManifestSchema.safeParse(JSON.parse(readFileSync(join(dir, "intentic-extension.json"), "utf8")));

const extensions = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, "intentic-extension.json")))
    .map((entry) => ({ name: entry.name, dir: join(extensionsRoot, entry.name) }));

// Every route the daemon serves, as method and path segments, `{param}` and a trailing `/*` read as one segment of
// anything.
const served = [...SANDBOX_ROUTES, ...RAW_ROUTE_LIST].map((route) => ({ method: route.method, segments: route.path.split("/").slice(1) }));

// Whether a declared "<METHOD> <path-glob>" reaches at least one served route: a `*` in the glob matches any segment of
// the route, and a literal matches the same literal or a parameter in its place.
const reachesSomething = (entry: string): boolean => {
    const [method = "", glob = ""] = entry.trim().split(/\s+/u);
    const wanted = glob.split("/").slice(1);
    return served.some(
        (route) =>
            (route.method === method.toUpperCase() || route.method === "ALL") &&
            (route.segments.length === wanted.length || route.segments.at(-1) === "*") &&
            wanted.every((segment, index) => {
                const routeSegment = route.segments[index] ?? (route.segments.at(-1) === "*" ? "*" : undefined);
                return routeSegment !== undefined && (segment === "*" || routeSegment === segment || /^\{.+\}$/u.test(routeSegment) || routeSegment === "*");
            }),
    );
};

describe.each(extensions)("$name", ({ dir }) => {
    const parsed = manifestOf(dir);

    test("its manifest parses", () => {
        expect(parsed.error?.issues ?? []).toEqual([]);
    });

    test("this build of the host activates it", () => {
        expect(parsed.data === undefined || satisfiesEngines(parsed.data.engines.intentic, extensionApiVersion)).toBe(true);
    });

    // Bundles are build output, absent until the package is built; everything else is source and is there now.
    test("every file it promises from source is there", () => {
        const manifest = parsed.data;
        const built = new Set([manifest?.entry, manifest?.server].filter((path) => path !== undefined));
        const missing = (manifest === undefined ? [] : promisedPaths(manifest))
            .filter(({ path }) => !built.has(path))
            .filter(({ path }) => !existsSync(join(dir, path)))
            .map(({ what, path }) => `${what} (${path})`);
        expect(missing).toEqual([]);
    });

    test("every route it declares it will reach is one the daemon serves", () => {
        const declared = [...(parsed.data?.permissions?.sandbox ?? []), ...(parsed.data?.permissions?.daemon ?? [])];
        expect(declared.filter((entry) => !reachesSomething(entry))).toEqual([]);
    });
});

test("a declaration is matched against what the daemon serves, parameters and all, and a dead one is told apart", () => {
    expect(reachesSomething("GET /extensions/*/settings")).toBe(true);
    expect(reachesSomething("GET /extensions/acme.tool/settings")).toBe(true);
    expect(reachesSomething("GET /extension/events")).toBe(true);
    expect(reachesSomething("POST /extensions/*/settings/everything")).toBe(false);
    expect(reachesSomething("GET /no-such-route")).toBe(false);
});
