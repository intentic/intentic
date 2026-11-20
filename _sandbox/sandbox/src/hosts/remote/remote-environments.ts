import { HOST_NATIVE_ENVIRONMENT } from "@intentic/sandbox-contract/schemas/hosts";

/* WHICH ENVIRONMENT A CONNECTION'S SCREEN AND TERMINALS ARE (2026-11-20). One rule, decided here: every connection is
   served by its OWN machine agent's remoted, for its own environment. A PC's Windows side and each WSL distro with an
   agent of its own are separate connections of one card (`rog`, `rog::wsl:archlinux`); the distro's agent runs a Linux
   remoted beside it, so a terminal opened on the distro's row is a native Linux pseudo-terminal there, never
   `wsl.exe -d` through the Windows side's ConPTY. The screen is the Windows side's alone: a distro's connection offers
   none (describe.ts tells agents the same: "the screen, the GUI and the clipboard are the Windows side's").

   Names: remoted calls its own environment `native` whatever it runs on, while `remote.*` and the editor name
   environments as the PC does, `native` for the metal and `wsl:<distro>` for a distro. So a distro's remoted's `native`
   reads as `wsl:<distro>` here and back. The Windows side's remoted also lists `wsl:<distro>` for every distro wsl.exe
   can enter: a distro with a connection of its own on the same card is left out of that list and refused there (its own
   row opens it), and one without an agent stays reachable through the Windows side.

   Rejected: the Windows side's remoted serving every distro through `wsl.exe -d` (remoted's first design). A distro
   with its own agent would then have two remoteds offering its shell, and the editor's distro row would have opened a
   terminal on the Windows connection. */

const WSL_PREFIX = "wsl:";

// What a connection's environments are, as the hub knows them.
export interface ConnectionEnvironments {
    // The connection's own environment as the PC names it: `native`, or `wsl:<distro>`.
    readonly own: string;
    // `wsl:<distro>` environments of the same card that have a connection (and so an agent) of their own.
    readonly ownConnections: ReadonlySet<string>;
}

export const isDistro = (environment: string): boolean => environment.startsWith(WSL_PREFIX);

// Only a native side shows a screen.
export const servesScreen = (environments: ConnectionEnvironments): boolean => !isDistro(environments.own);

// One environment remoted named, as the PC names it. Pure.
export const fromRemoted = (environment: string, environments: ConnectionEnvironments): string =>
    environment === HOST_NATIVE_ENVIRONMENT ? environments.own : environment;

// What remoted lists, as `remote.*` offers it: in the PC's names, without a distro its own connection serves. Pure.
export const offeredEnvironments = (listed: readonly string[], environments: ConnectionEnvironments): string[] =>
    listed.map((environment) => fromRemoted(environment, environments)).filter((environment) => environment === environments.own || !environments.ownConnections.has(environment));

export type RemotedEnvironment = { readonly ok: true; readonly environment: string | undefined } | { readonly ok: false; readonly reason: string };

// The environment to ask remoted for: none (its own) for the connection's own or nothing asked; a refusal for one
// another connection serves, the native side included when asked of a distro's. Pure.
export const toRemoted = (asked: string | undefined, environments: ConnectionEnvironments, device: string): RemotedEnvironment => {
    if (asked === undefined || asked === environments.own) {
        return { ok: true, environment: undefined };
    }
    if (isDistro(environments.own)) {
        return { ok: false, reason: `"${device}" opens terminals in ${environments.own} only; open ${asked} on its own connection.` };
    }
    if (environments.ownConnections.has(asked)) {
        return { ok: false, reason: `${asked} has a connection of its own on this computer; open its terminal there.` };
    }
    return { ok: true, environment: asked };
};
