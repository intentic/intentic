import type { IntenticLine, VpnConfig, VpnState } from "@intentic/sandbox-contract";

// The per-protocol SPI behind the `vpn` capability: a driver owns writing, dialling, dropping and observing one kind of
// tunnel, nothing about the manifest, routes or UI.
// `probe` reads the OS, never daemon memory, so a tunnel dropped from a shell, the UI, or a dead gateway all read
// identically, and a daemon restart observes the truth.

// What a driver can see about a live tunnel; the manifest supplies the rest of a VpnLink (id, provider, autoConnect).
export interface VpnProbe {
    readonly state: VpnState;
    readonly interface?: string | undefined;
    readonly address?: string | undefined;
    readonly routes?: readonly string[] | undefined;
    readonly dns?: readonly string[] | undefined;
    readonly detail?: string | undefined;
}

export interface VpnDialOptions {
    // A one-time 2FA code, supplied per dial and never stored.
    readonly otp?: string | undefined;
}

export interface VpnDriver {
    // The gateway a stored connection dials, for display; never a secret.
    readonly gateway: (config: VpnConfig) => string | undefined;
    // Persist credentials + client config (0600). Idempotent; called on every capability apply.
    readonly write: (id: string, config: VpnConfig) => Promise<void>;
    // Undo `write`. Called after the tunnel is already down.
    readonly erase: (id: string, config: VpnConfig) => Promise<void>;
    // The executable missing from PATH, if any; reads as unavailable, not an error, pre-rebuild.
    readonly missingTool: () => Promise<string | undefined>;
    // Dials the tunnel, streaming progress; throws with the client's own message on failure.
    readonly connect: (id: string, config: VpnConfig, options: VpnDialOptions) => AsyncGenerator<IntenticLine>;
    // Drops the tunnel; must tolerate one already down, since the contract is "make it not be up".
    readonly disconnect: (id: string, config: VpnConfig) => Promise<void>;
    readonly probe: (id: string, config: VpnConfig) => Promise<VpnProbe>;
}
