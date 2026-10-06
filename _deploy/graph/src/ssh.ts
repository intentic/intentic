// How the sandbox reaches a host over SSH, the one shape three stages read: the host an intent authors
// (state-resolver's HostInput, its key a secret reference), the block the resolver copies onto every resource deployed to
// that host (state-resolver's sshOf), and what each SSHing provider parses once secrets are filled in (providers'
// sshSchema, its key the value). They used to spell it three times, `via`'s two transports included.

// "direct" dials address:port over TCP; "cloudflared" reaches a NAT'd host through its own Cloudflare SSH tunnel.
export const SSH_TRANSPORTS = ["direct", "cloudflared"] as const;
export type SshTransport = (typeof SSH_TRANSPORTS)[number];

// The connection block, over what its key is at that stage. Port defaults to 22 and `via` to "direct" where read.
export interface SshBlock<Key> {
    readonly address: string;
    readonly user: string;
    readonly sshKey: Key;
    readonly port?: number;
    readonly via?: SshTransport;
}
