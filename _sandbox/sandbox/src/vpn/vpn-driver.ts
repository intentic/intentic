import type { IntenticLine, VpnConfig, VpnState } from "@intentic/sandbox-contract";

// The per-protocol SPI behind the `vpn` capability. A driver owns exactly one question, "how does THIS kind of
// tunnel get written down, dialled, dropped and observed", and nothing about the manifest, the routes or the
// UI, which is why adding a protocol is a new file plus one line in vpn-drivers.ts.
//
// The key rule is that `probe` reads the OS, never daemon memory: a tunnel the agent dropped from a
// shell, one the UI dropped, and one that died with its gateway all have to read identically, and a daemon
// restart has to observe the truth rather than a remembered guess.

// What a driver can see about a live tunnel. The manifest supplies the rest of a VpnLink (id, provider,
// autoConnect); everything here comes off the machine.
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
    // The gateway a stored connection dials, for display. Never a secret.
    readonly gateway: (config: VpnConfig) => string | undefined;
    // Persist credentials + client config (0600). Idempotent; called on every capability apply.
    readonly write: (id: string, config: VpnConfig) => Promise<void>;
    // Undo `write`. Called after the tunnel is already down.
    readonly erase: (id: string, config: VpnConfig) => Promise<void>;
    // The executable this driver needs, when it is NOT on PATH, the pre-rebuild state, which reads as
    // "unavailable" rather than an error because the capability's image fragment has not been applied yet.
    readonly missingTool: () => Promise<string | undefined>;
    // Dial the tunnel, streaming the client's progress. Throws with the client's own message on failure,
    // a wrong password and an untrusted gateway certificate are things the user has to read.
    readonly connect: (id: string, config: VpnConfig, options: VpnDialOptions) => AsyncGenerator<IntenticLine>;
    // Drop the tunnel. Must tolerate an already-down one: the contract is "make it not be up".
    readonly disconnect: (id: string, config: VpnConfig) => Promise<void>;
    readonly probe: (id: string, config: VpnConfig) => Promise<VpnProbe>;
}
