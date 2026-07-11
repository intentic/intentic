import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { createHostSshTunnel } from "./host-ssh-tunnel.js";

// Used by the sandbox bootstrap (connect.sh), not operators directly: stand up the per-host Cloudflare tunnel
// + DNS that exposes THIS machine's sshd at ssh-<id>.<zone>, so the sandbox can SSH-deploy to it through the
// tunnel (via:"cloudflared") when it can't reach the host by IP (a NAT'd local machine). Prints
// `HOST_SSH_TUNNEL_TOKEN=…` / `HOST_SSH_HOSTNAME=…` on stdout (progress on stderr) so connect.sh can capture
// them and run cloudflared natively on the host. Run inside the sandbox image (which carries this CLI).
export const hostSshTunnel = buildCommand<{ zone?: string }>({
    docs: { brief: "Create/refresh the per-host SSH Cloudflare tunnel + DNS and print its connector token (used by connect.sh)" },
    parameters: {
        flags: {
            zone: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Cloudflare zone for the DNS record (default: the API token's sole zone, or set ZONE)",
            },
        },
    },
    async func(this: CommandContext, flags: { zone?: string }) {
        const config = loadConfig();
        const { cloudflareApiToken: apiToken, connectToken, hostName } = config;
        if (apiToken === "") {
            throw new Error("set CLOUDFLARE_API_TOKEN");
        }
        if (connectToken === "") {
            throw new Error("set CONNECT_TOKEN (the per-sandbox connection token)");
        }
        if (hostName === "") {
            throw new Error("set HOST_NAME (the inventory name of the host being enrolled)");
        }
        const zone = flags.zone ?? (config.zone !== "" ? config.zone : undefined);
        const { token, hostname } = await createHostSshTunnel({
            apiToken,
            connectToken,
            hostName,
            ...(zone !== undefined && zone !== "" ? { zone } : {}),
            log: (message) => this.process.stderr.write(`${message}\n`),
        });
        // Machine-readable on stdout for connect.sh to capture (progress went to stderr).
        this.process.stdout.write(`HOST_SSH_TUNNEL_TOKEN=${token}\nHOST_SSH_HOSTNAME=${hostname}\n`);
    },
});
