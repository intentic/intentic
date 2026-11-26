import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { CORE_MODEL_ROLES } from "@intentic/sandbox-contract/models/model-roles";
import { roleLadder } from "@intentic/sandbox-contract/models/model-setups";
import { SandboxSettingsSchema, SandboxSettingsWriteSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import { modelRolesOf } from "./declared-roles.js";

// The jobs the settings page lists and a run resolves by id: the sandbox's own, then each installed extension's
// declaration (`contributes.modelRoles`). Pipelines' is read off its manifest in this repository.

const pipelinesManifest = ExtensionManifestSchema.parse(
    JSON.parse(readFileSync(join(repoRoot(import.meta.url), "_extensions", "pipelines", "intentic-extension.json"), "utf8")),
);

const installed = (manifest: InstalledExtension["manifest"], enabled: boolean): InstalledExtension => ({
    id: `${manifest.publisher}.${manifest.name}`,
    dir: `/opt/extensions/${manifest.name}`,
    manifest,
    source: "workspace",
    enabled,
});

const acme = (roles: readonly object[]): InstalledExtension["manifest"] =>
    ExtensionManifestSchema.parse({ publisher: "acme", name: "jobs", version: "1.0.0", engines: { intentic: "^2.52.0" }, contributes: { modelRoles: roles } });

test("lists the sandbox's own jobs first, then the pipeline fixes Pipelines declares, as the settings page draws them", () => {
    const roles = modelRolesOf([installed(pipelinesManifest, true)]);
    expect(roles.slice(0, CORE_MODEL_ROLES.length).map((role) => role.id)).toEqual(CORE_MODEL_ROLES.map((role) => role.id));
    expect(roles.at(-1)).toEqual({
        id: "pipeline-fix",
        label: "Pipeline fixes",
        blurb: "The agent started by Fix on a failed pipeline.",
        kind: "run",
        icon: "wave-pulse",
        setup: "high",
        extension: "intentic.pipelines",
        enabled: true,
    });
});

test("an extension switched off keeps its job listed, switched off, and the owner's choice for it stays as stored", () => {
    const off = modelRolesOf([installed(pipelinesManifest, false)]).find((role) => role.id === "pipeline-fix");
    expect(off).toMatchObject({ extension: "intentic.pipelines", enabled: false });
    // The owner put the job on Medium; a save made while the extension is off writes the map back as it was.
    const saved = SandboxSettingsSchema.parse({ roleSetups: { "commit-message": "low", "pipeline-fix": "medium" } });
    const resaved = SandboxSettingsWriteSchema.parse({ ...saved, timezone: "Europe/Warsaw" });
    expect(resaved.roleSetups).toEqual({ "commit-message": "low", "pipeline-fix": "medium" });
    // Switched on again, the job reads the same choice.
    const on = modelRolesOf([installed(pipelinesManifest, true)]).find((role) => role.id === "pipeline-fix");
    expect(on?.enabled).toBe(true);
    expect(roleLadder(resaved, "pipeline-fix", on?.setup)).toEqual({ kind: "preset", preset: "medium" });
});

test("a sandbox that placed no job runs an extension's job on the setup its declaration suggests", () => {
    const fix = modelRolesOf([installed(pipelinesManifest, true)]).find((role) => role.id === "pipeline-fix");
    expect(roleLadder(SandboxSettingsSchema.parse({}), "pipeline-fix", fix?.setup)).toEqual({ kind: "preset", preset: "high" });
});

test("one declaration per id: the sandbox's own wins, then the first installed, an enabled one over a switched-off one", () => {
    const takesCore = acme([{ id: "commit-message", label: "Commits", explanation: "Not the sandbox's." }]);
    expect(modelRolesOf([installed(takesCore, true)]).filter((role) => role.id === "commit-message")).toEqual([
        expect.objectContaining({ label: "Commit messages", enabled: true }),
    ]);
    expect(modelRolesOf([installed(takesCore, true)]).find((role) => role.id === "commit-message")?.extension).toBeUndefined();
    const second = ExtensionManifestSchema.parse({ ...acme([{ id: "pipeline-fix", label: "Other fixes", explanation: "Someone else's." }]), name: "other" });
    expect(modelRolesOf([installed(pipelinesManifest, true), installed(second, true)]).filter((role) => role.id === "pipeline-fix")).toEqual([
        expect.objectContaining({ extension: "intentic.pipelines" }),
    ]);
    expect(modelRolesOf([installed(pipelinesManifest, false), installed(second, true)]).filter((role) => role.id === "pipeline-fix")).toEqual([
        expect.objectContaining({ extension: "acme.other", enabled: true }),
    ]);
});
