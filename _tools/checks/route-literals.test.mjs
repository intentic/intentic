// Pins what route-literals reads as an app address typed by hand: which roots the app-routes tables give, which literals
// spell one (in code and in a component's markup), and the sites that are not one: comments, a daemon request on the
// line, a user's home directory, and a site that says why.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSubject, routeLiterals, routeRoots } from "./lib/app-route-literals.mjs";

const PAGES = `
export const SANDBOX_PAGES = {
    /** The board: \`agents\`. */
    agents: \`agents\`,
    agent: \`agents/:id\`,
    sandboxSettings: \`settings/:tab?\`,
} as const;
export const ACCOUNT_PAGES = {
    account: \`account/:tab?\`,
} as const;
export const TOP_PAGES = {
    root: \`\`,
    loginConfirm: \`login/confirm\`,
    invite: \`invite/:token\`,
} as const;
export const LOCAL_PAGES = {
    files: \`workspace/:path(.*)*\`,
    process: \`process/:id\`,
} as const;
export const page = {
    agents: (extras?: LinkExtras) => link(\`agents\`, {}, extras),
} as const;
`;
const LEGACY = `
const LEGACY_ROUTES: readonly LegacyRoute[] = [
    { pattern: \`chat\`, to: (_p, q, h) => inside(page.chat(extras(q, h))) },
    {
        pattern: \`sandbox/:tab?\`,
        to: (p, q, h) => inside(page.sandboxSettings(p[\`tab\`], extras(q, h))),
    },
    { pattern: \`:catchAll(.*)\`, to: () => inside(page.chat()) },
];
`;
const PATHS = `
export const SANDBOX_SEGMENT = \`s\`;
export const HOME_SEGMENT = \`home\`;
const joined = (...parts: readonly string[]): string => \`/\${parts.filter((part) => part !== \`\`).join(\`/\`)}\`;
export const floatingPath = (sandbox: string, panel: FloatingPanel): string => joined(SANDBOX_SEGMENT, encodeURIComponent(sandbox), \`floating\`, panel);
`;

const { roots } = routeRoots({ pages: PAGES, legacy: LEGACY, paths: PATHS });
const lines = (code, path = "a.ts") => routeLiterals(path, code, roots).map(({ line }) => line);

test("the roots are the first static segment of every page, old address and frame, read off the tables' text", () => {
    assert.deepEqual(roots, ["account", "agents", "chat", "floating", "home", "invite", "login", "process", "s", "sandbox", "settings", "workspace"]);
    assert.deepEqual(routeRoots({ pages: PAGES.replace("TOP_PAGES", "FIRST_PAGES"), legacy: "", paths: PATHS }).missing, [
        "TOP_PAGES",
        "LEGACY_ROUTES",
    ]);
});

test("a literal of any quote opening with a root and then its end, a slash, a query, an anchor or a substitution", () => {
    assert.deepEqual(
        lines(
            `go('/agents');\ngo("/agents/1");\ngo(\`/settings?tab=x\`);\ngo(\`/sandbox#storage\`);\ngo(\`/s/\${id}/chat\`);\ngo(\`/agents\${tail}\`);`,
        ),
        [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(routeLiterals("a.ts", "const to = `/agents/${encodeURIComponent(id)}?focus=1`;", roots), [
        { line: 1, literal: "/agents/${…}?focus=1" },
    ]);
    assert.deepEqual(lines("const a = { b: `${x ? `/home/${id}` : `/login/confirm`}` };"), [1, 1]);
});

test("a root only counts whole and first: a longer word, a nested path, a based or relative one are not addresses", () => {
    assert.deepEqual(lines("go(`/agents-list`);\ngo('/api/agents');\ngo(`${base}/agents`);\ngo(`agents/${id}`);\ngo('/');\ngo('/sessions');"), []);
});

test("a component's script, its to and href attributes and the code of its bindings are read, each at its own line", () => {
    const component = [
        `<template>`,
        `    <RouterLink to="/agents">{{ t("x") }}</RouterLink>`,
        `    <a href='/s/demo/chat'>x</a>`,
        `    <RouterLink`,
        '        :to="`/agents/${id}`"',
        `        class="text-link"`,
        `    >x</RouterLink>`,
        `    <Button @click="router.push('/settings')" :label="'/chat'" />`,
        `    <span>{{ path === '/workspace' ? 1 : 2 }}</span>`,
        `    <img src="/home/logo.svg" title="/agents" />`,
        `    <!-- <RouterLink to="/agents"> -->`,
        `</template>`,
        `<script setup lang="ts">`,
        `const a = 1;`,
        "void router.replace(`/login`);",
        `</script>`,
    ].join("\n");
    assert.deepEqual(lines(component, "A.vue"), [15, 2, 3, 5, 8, 8, 9]);
});

test("comments are not read: line, block, doc and markup", () => {
    assert.deepEqual(lines("// go('/agents')\n/* go('/agents') */\n/**\n * Opens `/agents/<id>`.\n */\nconst a = 1; // then '/chat'"), []);
});

test("a site that says why is excused, on its line or the line above, and only with a reason", () => {
    assert.deepEqual(lines("go('/agents'); // allow(route-literal): the Android bridge parses this form"), []);
    assert.deepEqual(lines("// allow(route-literal): the Android bridge parses this form\ngo('/agents');"), []);
    assert.deepEqual(lines("go( // allow(route-literal): the Android bridge parses this form\n    '/agents');"), []);
    assert.deepEqual(lines("// allow(route-literal):\ngo('/agents');\ngo('/chat'); // allow(contract-paths): another check's"), [2, 3]);
    assert.deepEqual(
        lines(
            `<template>\n    <!-- allow(route-literal): a static page -->\n    <a\n        class="x"\n        href="/login"\n    >x</a>\n</template>`,
            "A.vue",
        ),
        [],
    );
});

test("a literal handed to the daemon on its line is a request, not an address", () => {
    const requests = [
        "sandboxRaw(`/agents/${id}/documents/raw`);",
        "sandboxJson<Answer>(`/workspace/list`);",
        "sandboxBlob(`/workspace/raw?${query}`);",
        "sandboxRequest('/chat/send');",
        "const url = rawRouteUrl(`/workspace/media`);",
        "procedurePath(`/agents/list`);",
        "await client.request(`/settings`);",
        "await api.daemon.get(`/agents`);",
        "daemon.request('/agents');",
        "await fetch(`/workspace/raw`);",
        "oc.route({ path: `/agents/{id}` });",
    ];
    assert.deepEqual(lines(requests.join("\n")), []);
    assert.deepEqual(lines("go(`/agents`); // fetched later"), [1]);
});

test("a user's home directory is no frame, but Home's addresses still are", () => {
    assert.deepEqual(lines("const dir = '/home/ada/intentic';\nconst b = `/home/ada/${repo}`;\nconst c = '/home/ubuntu/';"), []);
    assert.deepEqual(
        lines("go('/home');\ngo('/home/account');\ngo(`/home/${id}`);\ngo('/home/account/billing');\ngo('/home/demo/agents');\ngo('/home/ada');"),
        [1, 2, 3, 4, 5, 6],
    );
});

test("the files read: the scoped trees' .ts, .mts and .vue, less the tables, tests, fixtures and testing.ts", () => {
    const read = [
        "_editor/web/src/router/index.ts",
        "_editor/desktop-app/src/device/DeviceView.vue",
        "_extensions/pipelines/src/runSide.ts",
        "_site/demo/src/main.ts",
        "_sandbox/sandbox/src/push/notifications.ts",
        "_sandbox/sandbox/src/links/link-tasks.ts",
        "_platform/api/src/sign-in.ts",
        "_editor/web/src/a.mts",
    ];
    const skipped = [
        "_sandbox/sandbox/src/runtimes/execution.testing.ts",
        "_platform/web/src/main.ts",
        "_editor/web/src/router/index.test.ts",
        "_editor/web/src/a.spec.ts",
        "_editor/web/src/lib/testing.ts",
        "_extensions/prawo/src/fixtures/case.ts",
        "_site/demo/src/fixture/home/x.ts",
        "_shared/sandbox-contract/src/app-routes/paths.ts",
        "_editor/web/src/a.js",
        "_editor/web/README.md",
    ];
    assert.deepEqual(read.filter(isSubject), read);
    assert.deepEqual(skipped.filter(isSubject), []);
});
