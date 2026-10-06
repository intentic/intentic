import type { MachineEnvironment, SandboxStatus } from "../desktop";

// WHICH ENVIRONMENT OF THIS COMPUTER KEEPS A SANDBOX (2026-10-05). On Windows one Docker engine serves Windows and every
// WSL distro, and `ic sandbox list --json` lists every sandbox on it from either side, naming the other side that keeps
// one (`keptElsewhere`). That side runs its background care (its keeper, updates, backups); a person's start, stop and
// restart still reach it from here, which is why the row keeps its verbs and only says where it is kept. The distro is
// named when ic names it (`keptElsewhereName`, or the `linux/<distro>` form of `keptElsewhere`), else when exactly one
// distro of this PC runs an agent (the machine agents read off each distro's files, src-tauri/src/agents.rs), else not
// at all.

/** How a person names an environment: `Windows`, `Linux`, `WSL (archlinux)`. */
export const environmentLabel = (environment: Pick<MachineEnvironment, `kind` | `distro`>): string => {
    if (environment.kind === `wsl`) {
        return environment.distro === undefined ? `WSL` : `WSL (${environment.distro})`;
    }
    return environment.kind === `windows` ? `Windows` : `Linux`;
};

/** The other environments of this computer whose machine agent runs, by name. */
export const otherAgents = (environments: readonly MachineEnvironment[]): string[] =>
    environments.filter((environment) => !environment.here && environment.agent && environment.running).map(environmentLabel);

/** Where a sandbox kept by another side of this computer is kept, by name; undefined for this side's own. */
export const keptBy = (
    sandbox: Pick<SandboxStatus, `keptElsewhere` | `keptElsewhereName`>,
    environments: readonly MachineEnvironment[],
): string | undefined => {
    const side = sandbox.keptElsewhere;
    if (side === undefined || side === ``) {
        return undefined;
    }
    // An ic that names the side itself is the answer; it knows the distro off the container's own stamp.
    if (sandbox.keptElsewhereName !== undefined && sandbox.keptElsewhereName !== ``) {
        return sandbox.keptElsewhereName;
    }
    // `platform/env` from an ic that stamps the environment too (2026-10-05): `windows`, `linux/archlinux`, `macos`.
    const [platform, env] = side.split(`/`);
    if (platform === `windows`) {
        return `Windows`;
    }
    if (platform === `macos`) {
        return `macOS`;
    }
    if (platform === `linux` && env !== undefined && env !== `` && env !== `linux`) {
        return environmentLabel({ kind: `wsl`, distro: env });
    }
    // A side ic names by its distro already (`wsl:archlinux`, or the bare name) needs nothing more.
    const named = side.startsWith(`wsl:`) ? side.slice(`wsl:`.length) : side === `linux` ? undefined : side;
    if (named !== undefined && named !== ``) {
        return environmentLabel({ kind: `wsl`, distro: named });
    }
    const distros = environments.filter((environment) => environment.kind === `wsl` && environment.agent && environment.running);
    const [only] = distros;
    return environmentLabel({ kind: `wsl`, distro: distros.length === 1 ? only?.distro : undefined });
};
