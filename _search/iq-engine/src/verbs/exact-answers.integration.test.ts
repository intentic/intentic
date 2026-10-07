import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { estimateTokens } from "../render/budget.js";
import { createEngine, type Engine } from "../index.js";
import type { QueryRequest } from "../types.js";

// A small i18n'd app: a nested translation catalog in two locales, the components that name its keys, a router with
// nested child routes, a hub that mounts one section per slug, and a section split by a query value. Written per run
// rather than added to the shared fixture, whose file counts other tests assert.
const FILES: Record<string, string> = {
    "web/src/app/i18n/locales/en.json": `{
    "agents": {
        "agentActions": {
            "noConversationLeft": "That agent has no conversation left to send to.",
            "keptFailing": "{to} kept failing, so this machine went back to {from} by itself."
        }
    },
    "sandbox": {
        "nav": { "agent": "Agent" }
    },
    "status": {
        "stalled": "This agent stalled while waiting on a tool",
        "leave": "Are you sure you want to leave this sandbox?"
    }
}
`,
    "web/src/app/i18n/locales/pl.json": `{
    "agents": {
        "agentActions": {
            "noConversationLeft": "Ten agent nie ma już rozmowy, do której można wysłać.",
            "keptFailing": "{to} ciągle zawodziło, więc ta maszyna sama wróciła do {from}."
        }
    }
}
`,
    "web/src/features/agents/agentActions.ts": `import { t } from "../../i18n";

// Sends a nudge to the agent's open conversation, refusing when there is none.
export const askAgentToResolve = (conversation: string | undefined) => {
    if (conversation === undefined) {
        return { kind: "refused", why: t(\`agents.agentActions.noConversationLeft\`) };
    }
    return { kind: "sent" };
};
`,
    "web/src/features/agents/updateOutcome.ts": `import { t } from "../../i18n";

export const outcomeLine = (to: string, from: string) => t(\`agents.agentActions.keptFailing\`, { to, from });
`,
    "web/src/features/agents/pictureQuickLook.ts": "export const quickLook = (url: string) => url;\n",
    "web/src/features/agents/agentStatus.ts": `import { t } from "../../i18n";

export const statusLine = (state: string) => t(\`status.\${state}\`);
export const leaveLine = () => t("status.leave");
`,
    "web/src/features/agents/AgentCard.vue": "<template><div>{{ name }}</div></template>\n",
    "docs/widgets.md": "# Where is the sandbox hub mounted?\n\nThe hub is mounted by the router.\n",
    "web/src/router/index.ts": `import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
    {
        path: \`/\`,
        component: () => import(\`../shell/Shell.vue\`),
        children: [
            { path: \`agents\`, component: () => import(\`../features/agents/Agents.vue\`) },
            { path: \`sandbox/:tab?\`, component: () => import(\`../features/sandbox/SandboxHub.vue\`) },
        ],
    },
    { path: \`/:pathMatch(.*)*\`, redirect: \`/\` },
];

export const router = createRouter({ history: createWebHistory(), routes });
`,
    "web/src/shell/Shell.vue": "<template><RouterView /></template>\n",
    "web/src/features/agents/Agents.vue": "<template><AgentCard /></template>\n",
    "web/src/features/sandbox/sandboxNav.ts": `export const sections = () => [
    { slug: \`overview\`, label: "Overview" },
    { slug: \`agent\`, label: "Agent" },
];
`,
    "web/src/features/sandbox/SandboxHub.vue": `<script setup lang="ts">
import SandboxAgent from "./SandboxAgent.vue";
import { sections } from "./sandboxNav";
</script>

<template>
    <SandboxAgent v-if="slug === \`agent\`" />
</template>
`,
    "web/src/features/sandbox/SandboxAgent.vue": `<script setup lang="ts">
import AgentCodeSearch from "./AgentCodeSearch.vue";
</script>

<template>
    <template v-if="section === \`models\`">
        <AgentModels />
    </template>
    <template v-else-if="section === \`tools\`">
        <AgentCodeSearch />
    </template>
</template>
`,
    "web/src/features/sandbox/AgentCodeSearch.vue": "<template><div /></template>\n",
};

let root: string;
let engine: Engine;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iq-exact-"));
    for (const [path, content] of Object.entries(FILES)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
    }
    engine = createEngine({ root });
});
afterAll(() => rm(root, { recursive: true, force: true }));

const request = (verb: QueryRequest["verb"], query: string, budget = 1500): QueryRequest => ({
    verb,
    query,
    scope: {},
    render: { budget },
    options: {},
    echo: `${verb} "${query}"`,
});

const lineOf = (text: string, prefix: string): string | undefined => text.split("\n").find((line) => line.startsWith(prefix));

describe("literal first: UI text", () => {
    test("a screenshot's text answers with the component that renders it, through its catalog key", async () => {
        const outcome = await engine.run(request("q", "That agent has no conversation left to send to."));
        expect(outcome.result.groups[0]?.path).toBe("web/src/features/agents/agentActions.ts");
        expect(outcome.result.groups[1]?.path).toBe("web/src/app/i18n/locales/en.json");
        expect(outcome.verdict).toMatchObject({ basis: "literal", confidence: "confident" });
        expect(lineOf(outcome.text, "answer: ")).toMatch(/^answer: web\/src\/features\/agents\/agentActions\.ts:\d+ .*confident/);
        expect(lineOf(outcome.text, "key: ")).toBe(
            "key: agents.agentActions.noConversationLeft · web/src/app/i18n/locales/en.json:4 (+1 locale) · used at web/src/features/agents/agentActions.ts:6",
        );
    });

    test("filled-in placeholders match the catalog template", async () => {
        const outcome = await engine.run(request("q", "1.4.2 kept failing, so this machine went back to 1.4.1 by itself."));
        expect(outcome.result.groups[0]?.path).toBe("web/src/features/agents/updateOutcome.ts");
        expect(lineOf(outcome.text, "key: ")).toContain("agents.agentActions.keptFailing");
    });

    test("text in another locale resolves to the same key and component", async () => {
        const outcome = await engine.run(request("q", "Ten agent nie ma już rozmowy, do której można wysłać."));
        expect(outcome.result.groups[0]?.path).toBe("web/src/features/agents/agentActions.ts");
        expect(lineOf(outcome.text, "key: ")).toContain("web/src/app/i18n/locales/pl.json:4");
    });

    test("a key only ever built from a template points at the template", async () => {
        const outcome = await engine.run(request("q", "This agent stalled while waiting on a tool"));
        expect(outcome.result.groups[0]?.path).toBe("web/src/features/agents/agentStatus.ts");
        expect(lineOf(outcome.text, "key: ")).toBe("key: status.stalled · web/src/app/i18n/locales/en.json:12 · built dynamically at web/src/features/agents/agentStatus.ts:3");
    });

    test("UI copy phrased as a question matches when it is the whole string", async () => {
        const outcome = await engine.run(request("q", "Are you sure you want to leave this sandbox?"));
        expect(outcome.result.groups[0]?.path).toBe("web/src/features/agents/agentStatus.ts");
        expect(outcome.verdict?.basis).toBe("literal");
    });

    test("a question its doc restates is not taken literally", async () => {
        const outcome = await engine.run(request("q", "where is the sandbox hub mounted?"));
        expect(outcome.verdict?.basis).not.toBe("literal");
        expect(outcome.text).not.toContain("matched literally");
    });

    test("find names the key of a catalog match and where code uses it", async () => {
        const outcome = await engine.run(request("find", "no conversation left to send to"));
        expect(outcome.result.groups.map((group) => group.path)).toEqual(["web/src/app/i18n/locales/en.json"]);
        expect(lineOf(outcome.text, "key: ")).toContain("used at web/src/features/agents/agentActions.ts:6");
    });
});

describe("routes", () => {
    test("an address answers with the view its route loads and the declaration", async () => {
        const outcome = await engine.run(request("q", "/agents"));
        expect(outcome.result.groups.map((group) => group.path).slice(0, 2)).toEqual(["web/src/features/agents/Agents.vue", "web/src/router/index.ts"]);
        expect(outcome.verdict).toMatchObject({ basis: "route", confidence: "confident" });
        expect(lineOf(outcome.text, "route: ")).toBe("route: /agents at web/src/router/index.ts:8 loads web/src/features/agents/Agents.vue");
    });

    test("parameter and query values are followed into the hub and the section", async () => {
        const outcome = await engine.run(request("q", "/sandbox/agent?section=tools"));
        // A section that mounts one component is that component; the branch choosing it is anchored beside it.
        expect(lineOf(outcome.text, "answer: ")).toMatch(/^answer: web\/src\/features\/sandbox\/AgentCodeSearch\.vue:1 · confident/);
        expect(lineOf(outcome.text, "tab=agent: ")).toBe("tab=agent: SandboxHub.vue:7 mounts SandboxAgent (web/src/features/sandbox/SandboxAgent.vue)");
        expect(lineOf(outcome.text, "section=tools: ")).toBe("section=tools: SandboxAgent.vue:9 mounts AgentCodeSearch (web/src/features/sandbox/AgentCodeSearch.vue)");
        const paths = outcome.result.groups.map((group) => group.path);
        expect(outcome.result.groups.find((group) => group.path === "web/src/features/sandbox/SandboxAgent.vue")?.hits.map((hit) => hit.line)).toContain(9);
        expect(paths).toContain("web/src/router/index.ts");
        expect(paths).toContain("web/src/features/sandbox/sandboxNav.ts");
    });

    test("an address no route declares falls back to a path search", async () => {
        const outcome = await engine.run(request("q", "/no-such-screen"));
        expect(outcome.verdict?.basis).not.toBe("route");
    });
});

describe("siblings", () => {
    test("the answer's neighbours are named, ranked first, within the budget", async () => {
        const outcome = await engine.run(request("q", "That agent has no conversation left to send to."));
        expect(lineOf(outcome.text, "siblings: ")).toBe("siblings: AgentCard.vue · Agents.vue · agentStatus.ts · pictureQuickLook.ts · updateOutcome.ts");
        for (const budget of [100, 200, 400]) {
            const tight = await engine.run(request("q", "That agent has no conversation left to send to.", budget));
            expect(estimateTokens(tight.text), `budget=${budget}`).toBeLessThanOrEqual(budget);
        }
    });
});

describe("an identifier the index defines", () => {
    test("is a confident answer by its definition", async () => {
        const outcome = await engine.run(request("q", "askAgentToResolve"));
        expect(outcome.result.groups[0]?.path).toBe("web/src/features/agents/agentActions.ts");
        expect(outcome.verdict).toMatchObject({ basis: "identifier", confidence: "confident" });
    });
});
