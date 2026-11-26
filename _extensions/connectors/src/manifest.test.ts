import { AutomationTemplateSchema, BUILT_IN_WATCH_KINDS } from "@intentic/sandbox-contract/schemas/automations";
import { manifest } from "./manifest.js";

// The two watch kinds the daemon checked itself until 2026-11-26 are this extension's now, under the same ids and
// parameters, so a watch stored before reads and checks the same. The contract keeps their declarations for an editor
// talking to a daemon from before contributed kinds; the two must say the same thing.

test("the npm and GitHub release kinds are declared as the contract records them for older daemons", () => {
    const declared = (manifest.contributes?.watchKinds ?? []).map(({ capabilities: _capabilities, ...kind }) => kind);
    expect(declared).toEqual(BUILT_IN_WATCH_KINDS.map(({ extension: _extension, enabled: _enabled, ...kind }) => kind));
    expect(BUILT_IN_WATCH_KINDS.map((kind) => kind.extension)).toEqual(["intentic.connectors", "intentic.connectors"]);
});

test("the GitHub release check reaches only this extension's own GitHub card", () => {
    expect(manifest.contributes?.watchKinds?.find((kind) => kind.id === "github-release")?.capabilities).toEqual(["github"]);
});

test("every template it offers is one the daemon's own template schema reads", () => {
    for (const template of manifest.contributes?.automationTemplates ?? []) {
        expect(AutomationTemplateSchema.safeParse(template).error?.issues, template.id).toBeUndefined();
    }
    expect((manifest.contributes?.automationTemplates ?? []).map((template) => template.id)).toEqual([
        "github-push",
        "gitlab-push",
        "sentry-alert",
        "package-release",
        "repository-releases",
        "linked-sandboxes-digest",
    ]);
});
