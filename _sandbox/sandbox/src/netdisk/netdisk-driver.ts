import type { IntenticLine, NetdiskConfig, NetdiskState } from "@intentic/sandbox-contract";

// The per-protocol SPI behind the `netdisk` capability: a driver owns writing a credential, mounting, unmounting and
// observing one kind of share, nothing about the manifest, routes or UI.
// `probe` reads the kernel's mount table, never daemon memory, so a disk unmounted from a shell, the UI, or by a dead
// server all read identically, and a daemon restart observes the truth.

// What a driver can see about a live mount; the manifest supplies the rest of a NetdiskLink.
export interface NetdiskProbe {
    readonly state: NetdiskState;
    // As the kernel enforces it, not as the card asked; absent unless mounted.
    readonly writable?: boolean | undefined;
    readonly detail?: string | undefined;
}

export interface NetdiskDriver {
    // What a stored disk mounts, for display (//server/share/path); never a secret.
    readonly target: (config: NetdiskConfig) => string;
    // Persist the credential (0600). Idempotent; called on every capability apply.
    readonly write: (id: string, config: NetdiskConfig) => Promise<void>;
    // Undo `write`. Called after the disk is already unmounted.
    readonly erase: (id: string, config: NetdiskConfig) => Promise<void>;
    // The executable missing from PATH, if any; reads as unavailable, not an error, pre-rebuild.
    readonly missingTool: () => Promise<string | undefined>;
    // Mounts the share, streaming progress; throws with the mount helper's own message on failure.
    readonly mount: (id: string, config: NetdiskConfig) => AsyncGenerator<IntenticLine>;
    // Unmounts; must tolerate one already down, since the contract is "make it not be mounted".
    readonly unmount: (id: string, config: NetdiskConfig) => Promise<void>;
    readonly probe: (id: string, config: NetdiskConfig) => Promise<NetdiskProbe>;
}
