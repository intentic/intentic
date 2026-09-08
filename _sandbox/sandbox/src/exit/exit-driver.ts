import type { ExitConfig, ExitObservation, ExitPoint, ExitState, IntenticLine } from "@intentic/sandbox-contract";

// Per-provider SPI behind the `exit` capability: how a driver's own pool of exits is listed, brought up, moved, and
// read back.
//   probe reads the OS, never daemon memory; a shell-stopped and a UI-stopped exit must read identically.
//   the driver never touches the main routing table; everything it brings up stays in its own table and SOCKS port.
//   `use`/`rotate` return an OBSERVATION, not a boolean: not reporting where traffic exits means it hasn't switched
//   country.

// What a driver can see about a live exit, off the machine; the manifest supplies the rest of an ExitLink.
export interface ExitProbe {
    readonly state: ExitState;
    readonly interface?: string | undefined;
    readonly detail?: string | undefined;
}

// Which catalog entry an exit is pointed at; `server` is the provider's own handle (a VPN Gate hostname, a pasted
// conf's name), tor has none, it picks per circuit.
export interface ExitSelection {
    readonly country?: string | undefined;
    readonly server?: string | undefined;
}

export interface ExitDriver {
    // What this provider can reach, ranked; `live: false` means baked fallback, not current data.
    readonly catalog: (id: string, config: ExitConfig) => Promise<{ readonly countries: readonly ExitPoint[]; readonly live: boolean }>;
    // Persist whatever the provider needs on disk (0600); idempotent, called on every capability apply.
    readonly write: (id: string, config: ExitConfig) => Promise<void>;
    // Undo `write`; called after the exit is already down.
    readonly erase: (id: string, config: ExitConfig) => Promise<void>;
    // The executable needed when not on PATH: the pre-rebuild state reads as unavailable, not an error.
    readonly missingTool: () => Promise<string | undefined>;
    // Brings the exit up at `country` (undefined = the provider's choice), leaving its SOCKS proxy listening; streams
    // progress. Idempotent: called on an already-up exit, it moves it rather than failing or stacking a second client.
    readonly start: (id: string, config: ExitConfig, country: string | undefined) => AsyncGenerator<IntenticLine>;
    // A different address, same country; cheap where the provider offers it (tor signals new circuits), else a re-dial
    // elsewhere. Returning unchanged is a reported failure: small pools can run out.
    readonly rotate: (id: string, config: ExitConfig) => AsyncGenerator<IntenticLine>;
    // Takes it down and removes the routing it installed; must tolerate an already-down exit.
    readonly stop: (id: string, config: ExitConfig) => Promise<void>;
    readonly probe: (id: string, config: ExitConfig) => Promise<ExitProbe>;
    // How the observation is made for this provider: tor answers through its own SOCKS port, a tunnel-based provider is
    // asked from the tunnel's source address. The driver owns the difference; both answer what address the far end
    // sees.
    readonly observe: (id: string, config: ExitConfig) => Promise<ExitObservation>;
}
