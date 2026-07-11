import type { IntentSet } from "./intent.js";

// The abstract capabilities an intent requires, independent of which concrete option fills them. The
// need resolver derives these from apps; the catalog maps each to the options that can satisfy it.
export type Capability = "source-control" | "docker-registry" | "infra-control" | "deployment-target" | "domain";

// Which plane a capability belongs to. Control = the deploy machinery (git, registry, orchestration);
// application = what serves the app (its runtime target and public domain). Orthogonal to scope below.
export type Plane = "control" | "application";

// One required capability at one scope, on one plane. Control-plane capabilities (source-control,
// docker-registry, infra-control) are scoped to the control-plane host — one platform shared across
// all hosts. Deployment-target is host-scoped (one per host with apps/services). Domain is
// cloud-scoped (one per Cloudflare account).
export interface Need {
    readonly capability: Capability;
    readonly scope: string;
    readonly plane: Plane;
}

const planeOf: Readonly<Record<Capability, Plane>> = {
    "source-control": "control",
    "docker-registry": "control",
    "infra-control": "control",
    "deployment-target": "application",
    domain: "application",
};

// The control-plane capabilities: one git/CI/deploy stack shared across all hosts. Scoped to the
// control-plane host. Separate from deployment-target, which is per host.
const controlPlaneCapabilities: readonly Capability[] = ["source-control", "docker-registry", "infra-control"];

// The control-plane host: the first declared host that has apps, falling back to the first declared
// host (for services-only intents). Returns undefined when no hosts are declared.
export const controlPlaneHostId = (intent: IntentSet): string | undefined =>
    (intent.hosts.find((h) => intent.apps.some((a) => a.on === h.id)) ?? intent.hosts[0])?.id;

// What an intent requires: any apps/services mean the derived control-plane host needs control-plane
// capabilities, each host with apps/services needs a deployment target, and the Cloudflare account
// needs a domain. Validates that every app/service references a declared host.
export const resolveNeeds = (intent: IntentSet): Need[] => {
    if (intent.apps.length === 0 && intent.services.length === 0 && intent.workspaces.length === 0 && intent.backings.length === 0) {
        return [];
    }
    const cloudflare = intent.cloudflare;
    if (cloudflare === undefined) {
        throw new Error("intent declares apps/services/workspaces/backings but no Cloudflare; declare it with i.have.cloudflare");
    }
    const declaredHosts = new Set(intent.hosts.map((h) => h.id));
    const activeHostIds = new Set([
        ...intent.apps.map((a) => a.on),
        ...intent.services.map((s) => s.on),
        ...intent.workspaces.map((w) => w.on),
        ...intent.backings.map((b) => b.on),
    ]);
    for (const hostId of activeHostIds) {
        if (!declaredHosts.has(hostId)) {
            throw new Error(`app/service/workspace/backing targets undeclared host "${hostId}"; declare it with i.have.host`);
        }
    }
    // A workspace's agent tools must reference declared services (the state resolver further checks the
    // service kind exposes an MCP endpoint, which needs the catalog it owns).
    const serviceIds = new Set(intent.services.map((service) => service.id));
    for (const workspace of intent.workspaces) {
        for (const toolId of workspace.tools ?? []) {
            if (!serviceIds.has(toolId)) {
                throw new Error(
                    `workspace "${workspace.id}" exposes tool "${toolId}" that is not a declared service; declare it with i.want.service`,
                );
            }
        }
    }
    const cpHost = controlPlaneHostId(intent);
    if (cpHost === undefined) {
        throw new Error("intent declares apps/services/backings but no host; declare one with i.have.host");
    }

    const needs: Need[] = controlPlaneCapabilities.map((capability) => ({ capability, scope: cpHost, plane: planeOf[capability] }));
    for (const hostId of activeHostIds) {
        needs.push({ capability: "deployment-target", scope: hostId, plane: planeOf["deployment-target"] });
    }
    needs.push({ capability: "domain", scope: cloudflare.id, plane: planeOf.domain });
    return needs;
};

export const needKey = (need: Need): string => `${need.capability}:${need.scope}`;
