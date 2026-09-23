import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { type ExtensionManifest, ExtensionManifestSchema, extensionIdOf, sandboxRouteAllowed } from "@intentic/extension-manifest";
import { type ContractRoute, requestPathFor, SANDBOX_ROUTES } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { admitByGrant, type GrantSources, grantsOf } from "../../auth/grants.js";
import { createDaemonApi } from "./backend-daemon.js";

// Conformance: under every in-repo backend's `permissions.daemon`, each procedure the contract declares is let through
// `api.daemon.rpc` or refused exactly as the same method and path through `api.daemon.request` are, which the daemon's
// own grant judges; a typed call it would refuse is refused before anything is sent.

afterEach(() => unstubAllGlobals());

const extensionsRoot = join(repoRoot(import.meta.url), "_extensions");

// Every extension here that ships a backend: the population `api.daemon` is handed to.
const backends: readonly ExtensionManifest[] = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, "intentic-extension.json")))
    .map((entry) => ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(extensionsRoot, entry.name, "intentic-extension.json"), "utf8"))))
    .filter((manifest) => manifest.server !== undefined);

// Every route granted, read off the route table: where each typed call must reach the daemon at its path call's own
// method and path, and be admitted there.
const everyRoute = SANDBOX_ROUTES.map((route) => `${route.method} ${route.path.replaceAll(/\{[^}]+\}/g, "*")}`);

const TOKEN = "minted-for-the-test";

// What the daemon was asked, and whether its grant admitted it: the only trace a call leaves on the far side.
interface Seen {
    readonly line: string;
    readonly admitted: boolean;
}

// The daemon's side of the wire, reduced to its grant table: every request judged by the header and path it arrives
// with, as app.ts judges it, and answered with an empty body once admitted.
const daemonGranting = (permissions: readonly string[]): Seen[] => {
    const seen: Seen[] = [];
    const grants = grantsOf(
        unstubbed<GrantSources>("grant sources", { verifyExtension: (presented) => (presented === TOKEN ? { permissions } : undefined) }),
    );
    stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const admission = await admitByGrant(grants, (name) => request.headers.get(name) ?? undefined, request.method, path);
        seen.push({ line: `${request.method} ${path}`, admitted: admission?.admitted === true });
        return admission?.admitted === true ? new Response(null, { status: 204 }) : Response.json({ error: "refused" }, { status: 403 });
    });
    return seen;
};

const apiFor = (permissions: readonly string[]) =>
    createDaemonApi("http://daemon.test", { id: "acme.conformance", daemonToken: TOKEN, daemonPermissions: permissions });

// A value for every `{param}`, so both doors are judged on a concrete path, as a real call is.
const inputOf = (route: ContractRoute): Record<string, string> =>
    Object.fromEntries([...route.path.matchAll(/\{([^}]+)\}/g)].map(([, param = ""]) => [param, `${param}-value`]));

const REFUSED_HERE = "refused before sending";
const REFUSED_THERE = "refused by the daemon";

// Where one call ended: the method and path the daemon admitted, or which side refused it.
const outcomeOf = async (seen: Seen[], call: () => Promise<unknown>): Promise<string> => {
    seen.length = 0;
    const failure = await call().then(
        () => undefined,
        (error: unknown) => error,
    );
    const [asked, ...more] = seen;
    if (asked === undefined) {
        if (!(failure instanceof Error) || !failure.message.includes("undeclared daemon route")) {
            throw failure ?? new Error("the call neither reached the daemon nor was refused");
        }
        return REFUSED_HERE;
    }
    if (more.length > 0) {
        throw new Error(`one call reached the daemon ${seen.length} times`);
    }
    return asked.admitted ? asked.line : REFUSED_THERE;
};

type Procedures = Readonly<Record<string, Readonly<Record<string, (input: unknown) => Promise<unknown>>>>>;

test("the walk finds the backends this repository ships", () => {
    // Every case below would still run on the synthetic grant alone, so a blind walk has to fail by itself.
    expect(backends.map((manifest) => extensionIdOf(manifest))).toContain("intentic.onlyoffice");
});

describe.each([
    ...backends.map((manifest) => [extensionIdOf(manifest), manifest.permissions?.daemon ?? []] as const),
    ["a backend granted every route", everyRoute] as const,
])("%s: a typed daemon call is gated exactly as the same call by path", (_name, permissions) => {
    test("every contract procedure: the manifest's decision, the typed door's taken before the network", async () => {
        const seen = daemonGranting(permissions);
        const daemon = apiFor(permissions);
        const outcomes: { route: string; typed: string; byPath: string }[] = [];
        for (const route of SANDBOX_ROUTES) {
            const input = inputOf(route);
            const [group = "", procedure = ""] = route.name.split(".");
            const typed = await outcomeOf(seen, () => (daemon.rpc as unknown as Procedures)[group]![procedure]!(input));
            const byPath = await outcomeOf(seen, () => daemon.request(requestPathFor(route, input), { method: route.method }));
            outcomes.push({ route: route.name, typed, byPath });
        }
        // The manifest's decision on the route's own method and path, taken by whichever side is that door's gate.
        const granted = (route: ContractRoute, refused: string): string => {
            const path = requestPathFor(route, inputOf(route));
            return sandboxRouteAllowed(permissions, route.method, path) ? `${route.method} ${path}` : refused;
        };
        expect(outcomes).toEqual(
            SANDBOX_ROUTES.map((route) => ({ route: route.name, typed: granted(route, REFUSED_HERE), byPath: granted(route, REFUSED_THERE) })),
        );
    });
});

test("a typed call to a procedure this build's contract does not declare is refused by name, before the network", async () => {
    const seen = daemonGranting(everyRoute);
    const call = (apiFor(everyRoute).rpc as unknown as Procedures)["nosuch"]!["procedure"]!({});
    await expect(call).rejects.toThrow(
        `extension "acme.conformance" called daemon procedure nosuch.procedure, which this build's contract does not declare`,
    );
    expect(seen).toEqual([]);
});

test("a typed answer arrives parsed by the procedure's output schema, and one that does not match it is refused", async () => {
    const answers = [{ previewUrl: "https://port-7-box.example.dev", slot: 7 }, { previewUrl: 7 }];
    stubGlobal("fetch", async () => Response.json(answers.shift()));
    const daemon = apiFor(["POST /ports/forward"]);
    // The undeclared `slot` is dropped by the schema, which is how a parse shows in what the caller receives.
    expect(await daemon.rpc.ports.forward({ port: 7 })).toEqual({ previewUrl: "https://port-7-box.example.dev" });
    await expect(daemon.rpc.ports.forward({ port: 7 })).rejects.toThrow("previewUrl");
});
