import { compileRoute, jsxRoutes, matchRoutes, parseRouteAddress, type RouteAddress, routeTable } from "./routes.js";

// The shapes the editor's own router uses (router/index.ts): lazy imports wrapped in a helper, an identifier
// component, nested children with relative paths, optional and custom-regex params, redirects, a dev-only spread, a
// catch-all, and the strings, comments and regex literals a scanner must not trip on.
const ROUTER = `import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import Shell from "../shell/WorkspaceShell.vue";

// path: \`/commented-out\`, component: () => import("nope.vue")
const unavailable = (to) => ({ path: \`/platform-unavailable\`, query: { returnTo: to.fullPath } });
const SLASHES = /[{}'"\\/]+/g;

const routes: RouteRecordRaw[] = [
    {
        path: \`/login\`,
        name: \`login\`,
        component: () => import(\`../features/auth/Login.vue\`),
    },
    {
        path: "/",
        beforeEnter: [requireAuth],
        component: Shell,
        children: [
            { path: \`\`, redirect: () => (mobile ? \`/agents\` : \`/workspace\`) },
            {
                path: \`agents\`,
                meta: { title: () => t(\`shared.agents\`) },
                component: asyncView(() => import(\`../features/agents/fleet/Agents.vue\`)),
            },
            { path: \`agents/:id\`, component: asyncView(() => import(\`../features/agents/review/AgentDetail.vue\`)) },
            { path: \`sandbox/devices\`, redirect: (to) => ({ name: \`devices\`, query: to.query }) },
            {
                path: \`sandbox/:tab?\`,
                component: asyncView(() => import(\`../features/sandbox/SandboxHub.vue\`), hubOutline(() => t(\`shared.sandboxHub\`), () => \`\`, 7)),
            },
            { path: \`workspace/:path(.*)*\`, component: asyncView(() => import(\`../features/workspace/Workspace.vue\`)) },
        ],
    },
    { path: \`/floating/:panel(chat|terminal|preview)\`, component: () => import(\`../shell/FloatingSection.vue\`) },
    ...(import.meta.env.DEV ? [{ path: \`/kit\`, component: () => import(\`../features/settings/DesignKit.vue\`) } satisfies RouteRecordRaw] : []),
    { path: \`/:pathMatch(.*)*\`, redirect: \`/\` },
];

export const router = createRouter({ history: createWebHistory(), routes, scrollBehavior: (to) => ({ el: to.hash }) });
`;

const table = routeTable(ROUTER);
const address = (query: string): RouteAddress => parseRouteAddress(query)!;
const best = (query: string): string | undefined => matchRoutes(table, address(query))[0]?.route.pattern;

describe("routeTable", () => {
    test("joins children to their parent's path and reads the view each one loads", () => {
        const agents = table.find((route) => route.pattern === "/agents");
        expect(agents).toEqual({ pattern: "/agents", line: 21, component: { spec: "../features/agents/fleet/Agents.vue", kind: "import", line: 23 }, redirect: false });
        expect(table.find((route) => route.pattern === "/")?.component).toMatchObject({ spec: "Shell", kind: "identifier" });
        expect(table.map((route) => route.pattern)).toEqual([
            "/login",
            "/",
            "/",
            "/agents",
            "/agents/:id",
            "/sandbox/devices",
            "/sandbox/:tab?",
            "/workspace/:path(.*)*",
            "/floating/:panel(chat|terminal|preview)",
            "/kit",
            "/:pathMatch(.*)*",
        ]);
    });

    test("a link target with a path is not a route, nor is a route written in a comment", () => {
        expect(table.some((route) => route.pattern === "/platform-unavailable")).toBe(false);
        expect(table.some((route) => route.pattern === "/commented-out")).toBe(false);
    });

    test("a route that only sends elsewhere is marked a redirect", () => {
        expect(table.find((route) => route.pattern === "/sandbox/devices")?.redirect).toBe(true);
    });
});

describe("matching an address", () => {
    test("the most specific route wins, and an optional param may be left out", () => {
        expect(best("/agents")).toBe("/agents");
        expect(best("/agents/42")).toBe("/agents/:id");
        expect(best("/sandbox/devices")).toBe("/sandbox/devices");
        expect(best("/sandbox/agent?section=tools")).toBe("/sandbox/:tab?");
        expect(best("/sandbox")).toBe("/sandbox/:tab?");
    });

    test("parameter values come back by name, a custom-regex param included", () => {
        expect(matchRoutes(table, address("/sandbox/agent"))[0]?.values).toEqual([["tab", "agent"]]);
        expect(matchRoutes(table, address("/floating/chat"))[0]?.values).toEqual([["panel", "chat"]]);
        expect(matchRoutes(table, address("/floating/elsewhere"))).toEqual([]);
    });

    test("a catch-all matches nothing: it would answer every address with home", () => {
        expect(matchRoutes(table, address("/no-such-screen"))).toEqual([]);
        expect(compileRoute("/:pathMatch(.*)*").catchAll).toBe(true);
        expect(compileRoute("/workspace/:path(.*)*").catchAll).toBe(false);
    });

    test("an address carries its query; a file path is not an address", () => {
        expect(parseRouteAddress("/sandbox/agent?section=tools")).toEqual({ path: "/sandbox/agent", segments: ["sandbox", "agent"], query: [["section", "tools"]] });
        expect(parseRouteAddress("/src/app.ts")).toBeUndefined();
        expect(parseRouteAddress("agents")).toBeUndefined();
        expect(parseRouteAddress("/two words")).toBeUndefined();
    });
});

test("JSX routes, the flat form", () => {
    const routes = jsxRoutes(`<Routes>\n  <Route path="/agents" element={<Agents />} />\n  // <Route path="/old" element={<Old />} />\n</Routes>`);
    expect(routes).toEqual([{ pattern: "/agents", line: 2, component: { line: 2, spec: "Agents", kind: "identifier" }, redirect: false }]);
});
