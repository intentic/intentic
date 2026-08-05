import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { createSandboxTunnel } from "./sandbox-tunnel.js";

// Used by the sandbox bootstrap (connect.sh / the workspace provider), not operators directly: stand up the
// per-sandbox Cloudflare tunnel + DNS that exposes the daemon at sandbox-<id>.<zone>, reusing the providers'
// Cloudflare client. Prints `TUNNEL_TOKEN=…` / `SANDBOX_HOSTNAME=…` on stdout (progress on stderr) so the
// bootstrap can capture them and run cloudflared. Run inside the sandbox image (which carries this CLI).
export const sandboxTunnel = buildCommand<{ service: string; previewService?: string; sshService?: string; zone?: string; subdomain?: string }>({
    docs: { brief: "Create/refresh the per-sandbox Cloudflare tunnel + DNS and print its connector token (used by connect.sh)" },
    parameters: {
        flags: {
            service: {
                kind: "parsed",
                parse: String,
                brief: "Internal service URL the tunnel routes to (e.g. http://intentic-sandbox-workspace:8787)",
            },
            previewService: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Preview-proxy URL to route the *.<zone> wildcard to (e.g. http://intentic-sandbox-workspace:5173)",
            },
            sshService: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "SSH URL to route ssh-<id>.<zone> to for local sync (e.g. ssh://intentic-sandbox-workspace:22)",
            },
            zone: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Cloudflare zone for the DNS record (default: the API token's sole zone, or set ZONE)",
            },
            subdomain: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Explicit subdomain prefix for the hostname (default: the derived sandbox-<id>)",
            },
        },
    },
    async func(this: CommandContext, flags: { service: string; previewService?: string; sshService?: string; zone?: string; subdomain?: string }) {
        const config = loadConfig();
        const { cloudflareApiToken: apiToken, connectToken } = config;
        if (apiToken === "") {
            throw new Error("set CLOUDFLARE_API_TOKEN");
        }
        if (connectToken === "") {
            throw new Error("set CONNECT_TOKEN (the per-sandbox connection token)");
        }
        const zone = flags.zone ?? (config.zone !== "" ? config.zone : undefined);
        const { token, hostname, sshHostname } = await createSandboxTunnel({
            apiToken,
            connectToken,
            service: flags.service,
            ...(flags.previewService !== undefined && flags.previewService !== "" ? { previewService: flags.previewService } : {}),
            ...(flags.sshService !== undefined && flags.sshService !== "" ? { sshService: flags.sshService } : {}),
            ...(zone !== undefined && zone !== "" ? { zone } : {}),
            ...(flags.subdomain !== undefined && flags.subdomain !== "" ? { subdomain: flags.subdomain } : {}),
            log: (message) => this.process.stderr.write(`${message}\n`),
        });
        // Machine-readable on stdout for connect.sh to capture (progress went to stderr).
        this.process.stdout.write(
            `TUNNEL_TOKEN=${token}\nSANDBOX_HOSTNAME=${hostname}\n${sshHostname !== undefined ? `SANDBOX_SSH_HOSTNAME=${sshHostname}\n` : ""}`,
        );
    },
});
