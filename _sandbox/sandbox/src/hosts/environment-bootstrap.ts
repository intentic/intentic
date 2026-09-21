import { installScriptUrl } from "@intentic/constants";
import { HOST_NATIVE_ENVIRONMENT, type HostFacts, hostEntryOf, hostConnectionKey, hostEnvironmentOf } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { callTool } from "./device-reports.js";

// ONE INSTALL CONNECTS THE WHOLE COMPUTER. The owner connected a PC, not one of its shells, so the moment any
// environment of a machine holds a socket the daemon puts an agent in the rest: from the Windows side into every WSL
// distro it lists, from a distro onto the Windows side. Each lands as a connection of the SAME card
// (`<card>::wsl:<distro>`), so there is nothing else to grant and nothing else to click.
//
// Done from here rather than by the agent: the pairing is a credential only the daemon may mint, and the crossing is
// already a `run_command` argument the machine turns into argv (`wsl.exe --exec sh -lc`). Nothing new is asked of the
// agent beyond the release that took `in`.

// Docker Desktop's own distros, which `wsl -l -q` lists like any other and which hold nobody's checkout.
const SYSTEM_DISTROS: ReadonlySet<string> = new Set(["docker-desktop", "docker-desktop-data"]);

// Long enough for a download and a first connect on somebody's laptop, short of the hub's own call ceiling.
const INSTALL_TIMEOUT_MS = 4 * 60_000;
// A machine reconnects whenever it wakes; a failed bootstrap must not be retried on every one of those. Per
// environment, so one distro refusing does not stop the next from being tried.
const RETRY_AFTER_MS = 30 * 60_000;

const attempted = new Map<string, number>();

/** Wipes the cooldown so the next connect tries again: the Connect button on a distro's row, and tests. */
export const forgetBootstrap = (connection?: string): void => void (connection === undefined ? attempted.clear() : attempted.delete(connection));

// Which environments of this machine an agent could be put in from the one that just connected. Read off the
// connected side's own facts: Windows lists its distros, and a distro implies the Windows side it runs on.
export const bootstrapTargets = (environment: string, facts: HostFacts): string[] => {
    if (environment === HOST_NATIVE_ENVIRONMENT) {
        return (facts.wslDistros ?? []).filter((distro) => !SYSTEM_DISTROS.has(distro)).map((distro) => `wsl:${distro}`);
    }
    // A distro can only be reached from Windows and can only reach Windows, so its sibling set is that one side.
    return environment.startsWith("wsl:") ? [HOST_NATIVE_ENVIRONMENT] : [];
};

// The one-liner that puts the agent in the target environment, in that environment's own dialect, plus the `in` that
// carries it there. The token is single-use and minted for the connection it enrolls, so a redeemed one can only ever
// become the environment it was meant for.
const installLine = (target: string, url: string, token: string): { readonly command: string; readonly in: string } =>
    target === HOST_NATIVE_ENVIRONMENT
        ? {
              command: `$env:SANDBOX_URL='${url}'; $env:PAIR_TOKEN='${token}'; irm ${installScriptUrl("devicePs1")} | iex`,
              in: "windows",
          }
        : {
              command: `curl -fsSL ${installScriptUrl("deviceSh")} | env SANDBOX_URL='${url}' PAIR_TOKEN='${token}' sh`,
              in: `wsl:${target.slice("wsl:".length)}`,
          };

// Puts an agent in one environment through the connection we already have. Returns what happened for the log, never
// throws: a machine whose owner switched commands off, or a distro that has no curl, is a fact about that machine and
// not a failure of the connection that triggered this.
const bootstrapOne = async (services: Services, from: string, card: string, target: string): Promise<string> => {
    const url = services.config.sandbox.publicUrl;
    if (url === "") {
        return "this sandbox has no public address for a device to dial yet";
    }
    const connection = hostConnectionKey(card, target);
    if (await services.hosts.enrolled(connection)) {
        return "already connected";
    }
    const { token } = services.hosts.mintPairing(connection);
    const line = installLine(target, url, token);
    const answer = await callTool(
        services,
        from,
        "run_command",
        { command: line.command, in: line.in, timeoutMs: INSTALL_TIMEOUT_MS },
        AbortSignal.timeout(INSTALL_TIMEOUT_MS + 5_000),
    ).catch((error: unknown) => ({ text: error instanceof Error ? error.message : String(error), refused: false }));
    return answer.refused ? `refused by that device: ${answer.text.trim()}` : answer.text.trim().split("\n")[0] ?? "ran";
};

// Called when an environment of a machine comes up and says what it is. Fire-and-forget by design: a connect must not
// wait on a download, and the agent it installs arrives as its own connection when it is ready.
export const bootstrapEnvironments = (services: Services, from: string, facts: HostFacts): void => {
    const card = hostEntryOf(from);
    const now = Date.now();
    for (const target of bootstrapTargets(hostEnvironmentOf(from), facts)) {
        const connection = hostConnectionKey(card, target);
        const last = attempted.get(connection);
        if (last !== undefined && now - last < RETRY_AFTER_MS) {
            continue;
        }
        attempted.set(connection, now);
        void bootstrapOne(services, from, card, target)
            .then((outcome) => {
                services.logger.info({ card, environment: target, outcome }, "hosts: connecting the rest of this computer");
            })
            .catch((error: unknown) => {
                services.logger.warn({ err: error, card, environment: target }, "hosts: could not connect that environment");
            });
    }
};
