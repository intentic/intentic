import type { WorkspaceEvent } from "@intentic/sandbox-contract";

export interface DependencyLandOrigin {
    readonly kind: "land";
    readonly agentId: string;
    readonly title?: string;
    readonly branch: string;
    readonly repos: WorkspaceEvent["repos"];
}

export interface DependencyRequestOrigin {
    readonly kind: "request";
    readonly conversationId?: string;
    readonly title?: string;
}

export type DependencyOrigin = DependencyLandOrigin | DependencyRequestOrigin | { readonly kind: "external" } | { readonly kind: "startup" };

export const originPriority = (origin: DependencyOrigin): number =>
    origin.kind === "land" ? 3 : origin.kind === "request" ? 2 : origin.kind === "external" ? 1 : 0;
