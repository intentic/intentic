import type { ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import type { SshTarget } from "./ssh.js";

// The SSH-creds block every host-deploying provider (host/tunnel/forgejo/forgejo-runner/komodo) shares;
// port defaults to 22 when absent, matching the engine's resolved-input shape. `via` selects the transport:
// "direct" dials address:port over TCP; "cloudflared" reaches the host's SSH through its Cloudflare tunnel
// (the sandbox runs `cloudflared access` to the host's ssh-<id>.<zone> hostname) — for a NAT'd self-host the
// sandbox can't reach by IP. Defaults to "direct" so real servers are unaffected.
export const sshSchema = z.object({
    address: z.string(),
    user: z.string(),
    sshKey: z.string(),
    port: z.number().default(22),
    via: z.enum(["direct", "cloudflared"]).default("direct"),
});

const issues = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ");

// True when any of the named $ref-derived inputs is still the engine's PENDING placeholder (a symbol — its
// dependency is a pending create under plan's lenient resolution). A read seeing one cannot introspect the
// resource yet and must return undefined instead of crashing in schema parsing — the engine's read contract.
// The symbol test is exact for both required and optional ref fields (authored values are never symbols).
export const hasPendingRef = (inputs: ResolvedInputs, ...fields: readonly string[]): boolean =>
    fields.some((field) => typeof inputs[field] === "symbol");

// Validate a node's resolved inputs against a schema, throwing the codebase's labelled
// "<resource> inputs malformed: …" error so callers (and tests) get a consistent, attributable message.
// This is an enriching transformation of the ZodError (like the API call() helpers), not a passthrough.
export const parseInputs = <S extends z.ZodType>(schema: S, inputs: ResolvedInputs, label: string): z.infer<S> => {
    const result = schema.safeParse(inputs);
    if (!result.success) {
        throw new Error(`${label} inputs malformed: ${issues(result.error)}`);
    }
    return result.data;
};

// Validate an EXTERNAL API response (untrusted, off the network) against the shape we consume, throwing a
// clear boundary error on drift instead of letting an unexpected payload surface as undefined deep inside
// a provider. Validates only the fields we read; unknown extra fields are dropped (additive API changes
// stay safe), while missing/renamed fields we depend on fail loudly here.
export const parseResponse = <S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new Error(`${label} returned an unexpected response: ${issues(result.error)}`);
    }
    return result.data;
};

// Map a parsed ssh block to the transport target (the sole sshKey -> privateKey mapping, centralized here).
export const sshTarget = (parsed: z.infer<typeof sshSchema>): SshTarget => ({
    address: parsed.address,
    user: parsed.user,
    privateKey: parsed.sshKey,
    port: parsed.port,
    via: parsed.via,
});

// Split a Forgejo URL into the (domain, https) pair Komodo's git-provider model expects: the host[:port]
// authority and whether to clone over TLS. Komodo clones the platform's app repos from INSIDE the host's
// nested Docker, where the public git.<zone> name does not resolve and the tunnel hairpin is unreachable;
// driving both the build's git_provider and Komodo's config.toml account off Forgejo's internal url
// (http://<internalIp>:3000) makes the clone a direct host-local request. The two MUST agree byte-for-byte
// (Komodo matches the account to a build by this domain), so both derive it here.
export const gitProvider = (forgejoUrl: string): { domain: string; https: boolean } => ({
    domain: forgejoUrl.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    https: forgejoUrl.startsWith("https://"),
});

// The registry image coordinate the CI workflow PUSHES and the Komodo deployment PULLS. Both MUST agree
// byte-for-byte (Komodo pulls exactly what CI pushed), so the single derivation lives here. `owner` is the
// Forgejo admin (the repo + package namespace); `tag` is the environment name so co-located environments
// publish to distinct tags on the same repo.
export const registryImage = (args: { registry: string; owner: string; repoName: string; tag: string }): string =>
    `${args.registry}/${args.owner}/${args.repoName}:${args.tag}`;
