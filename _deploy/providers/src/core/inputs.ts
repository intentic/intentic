import type { ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import type { SshTarget } from "./ssh.js";

// SSH-creds block shared by every host-deploying provider (host/tunnel/forgejo/forgejo-runner/komodo); port
// defaults to 22. `via` selects transport: "direct" dials address:port over TCP, "cloudflared" reaches a NAT'd host
// through its Cloudflare tunnel.
export const sshSchema = z.object({
    address: z.string(),
    user: z.string(),
    sshKey: z.string(),
    port: z.number().default(22),
    via: z.enum(["direct", "cloudflared"]).default("direct"),
});

const issues = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ");

// True when any named $ref-derived input is still the engine's PENDING placeholder (a symbol). A read seeing
// one must return undefined rather than parse it; authored values are never symbols.
export const hasPendingRef = (inputs: ResolvedInputs, ...fields: readonly string[]): boolean =>
    fields.some((field) => typeof inputs[field] === "symbol");

// Validates resolved inputs against a schema, throwing a labelled "<label> inputs malformed: …" error on failure.
export const parseInputs = <S extends z.ZodType>(schema: S, inputs: ResolvedInputs, label: string): z.infer<S> => {
    const result = schema.safeParse(inputs);
    if (!result.success) {
        throw new Error(`${label} inputs malformed: ${issues(result.error)}`);
    }
    return result.data;
};

// Validates an external API response against the shape consumed here, throwing a labelled error on drift.
// Unknown extra fields are dropped; missing or renamed fields this code depends on fail here.
export const parseResponse = <S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new Error(`${label} returned an unexpected response: ${issues(result.error)}`);
    }
    return result.data;
};

// Maps a parsed ssh block to the transport target; the sole sshKey -> privateKey mapping.
export const sshTarget = (parsed: z.infer<typeof sshSchema>): SshTarget => ({
    address: parsed.address,
    user: parsed.user,
    privateKey: parsed.sshKey,
    port: parsed.port,
    via: parsed.via,
});

// Splits a Forgejo URL into the (domain, https) pair Komodo's git-provider model expects, derived from
// Forgejo's internal url so the host-local clone resolves. Must agree byte-for-byte with Komodo's config.toml account.
export const gitProvider = (forgejoUrl: string): { domain: string; https: boolean } => ({
    domain: forgejoUrl.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    https: forgejoUrl.startsWith("https://"),
});

// Registry image coordinate CI pushes and Komodo pulls; must agree byte-for-byte, hence one derivation.
// `tag` is the environment name, so co-located environments publish to distinct tags on the same repo.
export const registryImage = (args: { registry: string; owner: string; repoName: string; tag: string }): string =>
    `${args.registry}/${args.owner}/${args.repoName}:${args.tag}`;
