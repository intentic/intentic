import type { ExitConfig, ExitObservation, ExitPoint, ExitState, IntenticLine } from "@intentic/sandbox-contract";

/* The per-provider SPI behind the `exit` capability. A driver owns exactly one question, "how does THIS pool
 * of exits get listed, brought up at a country, moved, and read back", and nothing about the manifest, the
 * routes or the UI, which is why adding a provider is a new file plus one line in exit-drivers.ts.
 *
 * Two rules carry over from the vpn subsystem, for the same reasons:
 *   probe READS THE OS, never daemon memory. An exit the agent stopped from a shell, one the UI stopped and
 *     one whose client died all have to read identically, and a daemon restart has to observe the truth.
 *   the driver NEVER TOUCHES THE MAIN ROUTING TABLE. Everything it brings up routes into its own table and is
 *     reached through its own SOCKS port. See ExitConfigSchema for what happens when that rule is broken.
 *
 * And one that is this subsystem's own: `use` and `rotate` return an OBSERVATION, not a boolean. A driver that
 * cannot say where traffic now comes out has not switched country, it has only brought something up, and the
 * links layer treats the difference as a failure. */

// What a driver can see about a live exit, off the machine. The manifest supplies the rest of an ExitLink.
export interface ExitProbe {
    readonly state: ExitState;
    readonly interface?: string | undefined;
    readonly detail?: string | undefined;
}

// Which catalog entry an exit is currently pointed at. `server` is the provider's own handle for it (a VPN
// Gate hostname, a pasted conf's name); tor has none, it picks per circuit.
export interface ExitSelection {
    readonly country?: string | undefined;
    readonly server?: string | undefined;
}

export interface ExitDriver {
    // What this provider can reach, ranked. Live off the provider when it answers; `live: false` means this is
    // the baked fallback and the caller should say so rather than present it as current.
    readonly catalog: (id: string, config: ExitConfig) => Promise<{ readonly countries: readonly ExitPoint[]; readonly live: boolean }>;
    // Persist whatever the provider needs on disk (0600). Idempotent; called on every capability apply.
    readonly write: (id: string, config: ExitConfig) => Promise<void>;
    // Undo `write`. Called after the exit is already down.
    readonly erase: (id: string, config: ExitConfig) => Promise<void>;
    // The executable this driver needs when it is NOT on PATH: the pre-rebuild state, which reads as
    // "unavailable" rather than an error because the capability's image fragment has not been applied yet.
    readonly missingTool: () => Promise<string | undefined>;
    /* Bring the exit up aimed at `country` (undefined = the provider's own choice), and leave its SOCKS proxy
     * listening. Streams progress: a first start pulls a catalog, dials, and waits for an address, which is
     * tens of seconds on the free providers. Must be idempotent in the useful sense, called on an exit that is
     * already up at another country, it MOVES it rather than failing or stacking a second client. */
    readonly start: (id: string, config: ExitConfig, country: string | undefined) => AsyncGenerator<IntenticLine>;
    /* A different address, same country. Cheap where the provider offers it (tor signals for new circuits),
     * a re-dial to another server elsewhere. Returning without changing the address is a failure the links
     * layer reports, small pools genuinely run out and saying so beats pretending. */
    readonly rotate: (id: string, config: ExitConfig) => AsyncGenerator<IntenticLine>;
    // Take it down and remove the routing it installed. Must tolerate an already-down exit.
    readonly stop: (id: string, config: ExitConfig) => Promise<void>;
    readonly probe: (id: string, config: ExitConfig) => Promise<ExitProbe>;
    /* How the observation gets made for THIS provider. Tor answers through its own SOCKS port; a tunnel-based
     * provider can be asked directly from the tunnel's source address. Both end up at the same place, "what
     * address does the far end see", and the driver owns the difference because only it knows the shape of
     * what it brought up. */
    readonly observe: (id: string, config: ExitConfig) => Promise<ExitObservation>;
}
