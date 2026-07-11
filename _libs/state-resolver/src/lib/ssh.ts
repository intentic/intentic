import type { HostInput } from "@intentic/need-resolver";

// The SSH connection block copied from a host onto every resource deployed to it over SSH (host, tunnel,
// forgejo/runner, komodo/periphery, backing + bindings, service, workspace, backup). Centralized so all sites
// stay in lockstep — including `via`, which selects direct vs. cloudflared-tunnel transport and must reach
// every SSHing provider. Optional fields (port, via) are omitted when absent so the artifact stays minimal.
export const sshOf = (host: HostInput): Record<string, unknown> => ({
    address: host.address,
    user: host.user,
    sshKey: host.sshKey,
    ...(host.port !== undefined ? { port: host.port } : {}),
    ...(host.via !== undefined ? { via: host.via } : {}),
});
