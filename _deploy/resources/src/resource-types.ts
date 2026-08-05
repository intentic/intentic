import type { RawNode } from "@intentic/graph";

// The closed vocabulary of resource kinds this resolver stack derives. The protocol IR treats a node's
// `type` as an opaque string; this union is the resolver's authority on which kinds it emits, and the
// key space for OUTPUTS.
export type ResourceType =
    | "host"
    | "cloudflare"
    | "github"
    | "gitlab"
    | "discord"
    | "stripe"
    | "cf-route"
    | "tunnel"
    | "forgejo"
    | "forgejo-user"
    | "forgejo-org"
    | "forgejo-team"
    | "repo"
    | "control-repo"
    | "forgejo-runner"
    | "komodo"
    | "komodo-periphery"
    | "komodo-server"
    | "komodo-user"
    | "ci"
    | "deployment"
    | "forgejo-notify"
    | "komodo-notify"
    | "signoz"
    | "outline"
    | "paperless"
    | "openproject"
    | "invoiceninja"
    | "infisical"
    | "workspace"
    | "backup"
    | "postgres"
    | "postgres-database"
    | "valkey"
    | "valkey-namespace"
    | "authentik"
    | "authentik-client"
    | "garage"
    | "garage-bucket"
    | "gh-repo"
    | "gh-ci"
    | "gl-repo"
    | "gl-ci";

// A RawNode whose kind is constrained to this stack's vocabulary. Resolvers build ResolvedNodes so an
// invalid kind is a compile error here; they flow out as plain RawNodes (ResourceType ⊆ string).
export type ResolvedNode = Omit<RawNode, "type"> & { readonly type: ResourceType };
