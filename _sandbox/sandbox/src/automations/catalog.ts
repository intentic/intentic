import { type AutomationCatalog, type AutomationTemplate, AutomationTemplateSchema, type TriggerSource } from "@intentic/sandbox-contract/schemas/automations";
import { type AutomationTemplateContribution, extensionIdOf, type ListenerContribution } from "@intentic/extension-manifest";
import { installedExtensions } from "../capabilities/extension-inventory/installed-extensions.js";
import type { ExtensionHost, InstalledExtension } from "../capabilities/extension-inventory/installed-extensions.js";
import { type DeclaredKind, declaredKindsOf, sourceProblemAmong } from "./watch/watch-kinds.js";
import { opt } from "../opt.js";

// Trigger catalogue for what can wake an agent: sources and templates the composer offers and `upsert` validates
// against, drawn from one list.
// Declares only what the daemon itself emits (ci); everything else comes from an extension manifest. Bug reports
// (`issues`) and the Visitor chat (`webchat`) were the daemon's own until 2026-11-26 and are the issues and visitor-chat
// extensions' listeners now, under the same providers, so a stored intake's or chat's trigger reads unchanged; `deploys`
// is the Deployments extension's own provider since 2026-11-25.
// A template lives beside the source it fires on so payload and prompt stay in one place; a generic-webhook template
// goes with its connector pack.

// Provider name for CI triggers (ci/events.ts sends them); one value for both vendors, narrowed by repo, branch and
// result, not by host.
export const CI_PROVIDER = "ci";

const CI_SOURCE: TriggerSource = {
    provider: CI_PROVIDER,
    label: "CI/CD",
    icon: "bolt",
    // One source for both vendors: a trigger narrows by repo, branch and result, not by who hosts the pipeline.
    requires: ["github", "gitlab"],
    enabled: true,
    events: [
        { value: "pipeline_failed", label: "Pipeline failed" },
        { value: "pipeline_broken", label: "Pipeline broke" },
        { value: "pipeline_succeeded", label: "Pipeline passed" },
        { value: "pipeline_fixed", label: "Pipeline fixed" },
    ],
    channel: { label: "Repository (optional)", placeholder: "all workspace repos" },
    branchField: {
        label: "Branch (optional)",
        placeholder: "every branch",
        hint: "Exact match. Leave blank and every agent's branch wakes this too, name your default branch to hear only about the one that ships.",
    },
    starterPrompt:
        "CI pipeline results just arrived, each line of the event payload is one JSON event: `type` is `pipeline_failed`, `pipeline_broken` " +
        "(it passed before), `pipeline_succeeded` or `pipeline_fixed`; `channelId` is the workspace repo dir and `branch` is the ref, with " +
        "`extra` carrying sha, url and failedJobs. For a failure: fetch the failing jobs' logs with your GitHub/GitLab capability (the url points " +
        "at the run), reproduce the failure locally in that repo, fix the cause, and push the fix. For a pass or a fix, no action is usually " +
        "needed: summarize briefly.",
};

// (2026-11-25) Not `deploys`: the Deployments extension contributes that provider itself, and a core source of the same
// name would shadow it.
export const CORE_TRIGGER_SOURCES: readonly TriggerSource[] = [CI_SOURCE];

// An extension's declared template, parsed with the daemon's own template schema (the manifest package can't import it),
// or undefined for one that would not be offered: a shape `upsert` would refuse; a watch whose kind no enabled extension
// checks, or whose parameters that kind does not take; a target that wakes another extension's code, which only that
// extension saves (watch/extension-target.ts).
const templateOf = (extension: InstalledExtension, contribution: AutomationTemplateContribution, kinds: readonly DeclaredKind[]): AutomationTemplate | undefined => {
    const parsed = AutomationTemplateSchema.safeParse(contribution);
    if (!parsed.success || (parsed.data.source !== undefined && sourceProblemAmong(kinds, parsed.data.source) !== undefined)) {
        return undefined;
    }
    const target = parsed.data.target;
    return target?.kind === "extension" && target.extension !== extensionIdOf(extension.manifest) ? undefined : parsed.data;
};

// A pack's listener declaration as the catalogue's source row. Every optional field is declared by the pack, never
// assumed: only a source that vouches for `author.id` gets to offer sender rules.
const sourceOf = (extension: InstalledExtension, listener: ListenerContribution): TriggerSource => ({
    provider: listener.provider,
    label: listener.automation.label,
    ...(extension.manifest.logo !== undefined ? { logo: extension.manifest.logo } : {}),
    ...(extension.manifest.icon !== undefined ? { icon: extension.manifest.icon } : {}),
    events: listener.events.map((event) => ({ value: event.type, label: event.label })),
    ...opt("strangers", listener.strangers),
    channel: listener.automation.channel,
    ...(listener.automation.branchField !== undefined ? { branchField: listener.automation.branchField } : {}),
    ...(listener.automation.mentionLabel !== undefined ? { mentionLabel: listener.automation.mentionLabel } : {}),
    ...(listener.automation.sender !== undefined ? { sender: listener.automation.sender } : {}),
    ...(listener.automation.senderGroup !== undefined ? { senderGroup: listener.automation.senderGroup } : {}),
    starterPrompt: listener.automation.starterPrompt,
    // `requires` comes from the pack's own capability entries; none declared means nothing to connect.
    requires: (extension.manifest.contributes?.capabilities ?? []).map((capability) => capability.id),
    enabled: extension.enabled,
});

// One source per provider, first wins: an extension can never shadow the daemon's own (ci, deploys).
export const automationCatalog = async (services: ExtensionHost): Promise<AutomationCatalog> => {
    const installed = await installedExtensions(services);
    const kinds = declaredKindsOf(installed);
    const sources: TriggerSource[] = [...CORE_TRIGGER_SOURCES];
    // (2026-11-26) Every template is an extension's (`contributes.automationTemplates`), offered while it is on: the code
    // chores, the agent-work review and the dreaming session the maintenance extension's, failing CI the pipelines
    // extension's, the release watches and the linked-sandboxes digest the connectors extension's, a page watch the
    // automations extension's, bug reports the issues extension's and the Visitor chat the visitor-chat extension's
    // (each with its source, since their moves). The daemon's own sources (CI, deploys) offer none.
    const templates: AutomationTemplate[] = [];
    const providers = new Set(sources.map((source) => source.provider));
    const ids = new Set(templates.map((template) => template.id));

    // Lists installed packs regardless of enabled: a stored automation outlives a disabled pack's source.
    for (const extension of installed) {
        const listener = extension.manifest.contributes?.listener;
        if (listener !== undefined && !providers.has(listener.provider)) {
            providers.add(listener.provider);
            sources.push(sourceOf(extension, listener));
        }
        // Templates drop with a disabled pack, unlike sources: creating a row that can't fire isn't offered.
        if (!extension.enabled) {
            continue;
        }
        for (const contribution of extension.manifest.contributes?.automationTemplates ?? []) {
            const template = templateOf(extension, contribution, kinds);
            if (template !== undefined && !ids.has(template.id)) {
                ids.add(template.id);
                templates.push(template);
            }
        }
    }
    return { sources, templates, watchKinds: kinds.map((declared) => declared.kind) };
};

// Provider to allowed event types, for `upsert`'s validation, built from the same catalogue the composer draws.
// An empty `events` means no event type to check; callers test provider membership first, event type only if given.
export const triggerSourceEvents = (catalog: AutomationCatalog): Map<string, Set<string>> =>
    new Map(
        catalog.sources.filter((source) => source.enabled).map((source) => [source.provider, new Set(source.events.map((event) => event.value))]),
    );
