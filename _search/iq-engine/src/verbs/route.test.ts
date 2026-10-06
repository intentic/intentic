import { branchFor, importSpecOf, resolveImport } from "./route.js";

// A hub that mounts one section per slug, and a section that splits into categories by a query value: the editor's
// SandboxHub.vue and SandboxAgent.vue in miniature.
const HUB = `<script setup lang="ts">
import SandboxAccess from "./access/SandboxAccess.vue";
import SandboxAgent from "./overview/SandboxAgent.vue";
import { sandboxSectionGroups } from "./sandboxNav";
</script>

<template>
    <HubLayout>
        <template #default="{ slug }">
            <SandboxAccess v-if="slug === \`access\`" />
            <SandboxAgent v-else-if="slug === \`agent\`" />
        </template>
    </HubLayout>
</template>
`;

const SECTION = `<script setup lang="ts">
import { useRoute } from "vue-router";
import AgentCodeSearch from "../agent-settings/AgentCodeSearch.vue";
import AgentModels from "../agent-settings/AgentModels.vue";
const SECTIONS = [{ label: "Models", value: \`models\` }, { label: "Tools", value: \`tools\` }];
const section = computed(() => SECTIONS.find((entry) => entry.value === route.query.section)?.value ?? \`models\`);
</script>

<template>
    <div>
        <template v-if="section === \`models\`">
            <AgentModels />
        </template>
        <template v-else-if="section === \`tools\`">
            <AgentCodeSearch />
            <AgentRepoChecks />
        </template>
    </div>
</template>
`;

describe("branchFor", () => {
    test("a branch that mounts its component on the same line", () => {
        expect(branchFor(HUB, "tab", "agent")).toEqual({ line: 11, components: ["SandboxAgent"] });
    });

    test("a branch that opens a block mounts what the block holds, up to where it closes", () => {
        expect(branchFor(SECTION, "section", "tools")).toEqual({ line: 14, components: ["AgentCodeSearch", "AgentRepoChecks"] });
    });

    test("a switch case and a lookup table are branches too", () => {
        expect(branchFor(`switch (tab) {\n    case "usage":\n        return Usage;\n}`, "tab", "usage")?.line).toBe(2);
        expect(branchFor(`const views = {\n    usage: SandboxUsage,\n    agent: SandboxAgent,\n};`, "tab", "agent")).toEqual({ line: 3, components: ["SandboxAgent"] });
    });

    test("no test for the value is no branch", () => {
        expect(branchFor(HUB, "tab", "billing")).toBeUndefined();
    });
});

describe("following an import", () => {
    const allowed = new Set(["web/src/features/sandbox/overview/SandboxAgent.vue", "web/src/features/sandbox/sandboxNav.ts", "web/src/lib/index.ts"]);

    test("a default or named import names the file a component comes from", () => {
        expect(importSpecOf(HUB, "SandboxAgent")).toBe("./overview/SandboxAgent.vue");
        expect(importSpecOf(HUB, "sandboxSectionGroups")).toBe("./sandboxNav");
        expect(importSpecOf(HUB, "Missing")).toBeUndefined();
    });

    test("relative, extensionless, index and @/ specifiers resolve to admitted files; packages do not", () => {
        const hub = "web/src/features/sandbox/SandboxHub.vue";
        expect(resolveImport(hub, "./overview/SandboxAgent.vue", allowed)).toBe("web/src/features/sandbox/overview/SandboxAgent.vue");
        expect(resolveImport(hub, "./sandboxNav", allowed)).toBe("web/src/features/sandbox/sandboxNav.ts");
        expect(resolveImport(hub, "../../lib", allowed)).toBe("web/src/lib/index.ts");
        expect(resolveImport(hub, "@/lib", allowed)).toBe("web/src/lib/index.ts");
        expect(resolveImport(hub, "vue-router", allowed)).toBeUndefined();
    });
});
