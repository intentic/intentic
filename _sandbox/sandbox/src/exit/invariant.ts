import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { InvariantCheck } from "../invariants/invariants.js";
import { countryName } from "./exit-countries.js";
import { exitInterface } from "./exit-paths.js";
import { readObservation, readSelection } from "./exit-state.js";
import { proxyBound } from "./exit-tunnel.js";

// Two promises a geo exit makes, both un-checked after they're first established.
//   an exit routes nothing into the main table: a leak swallows the daemon's own uplink and tunnel, silently.
//   an exit that reads up comes out where it was asked: only provable at the switch; tor rebuilds circuits, a relay can
//   be re-homed after.
// Both checks read state that already exists; neither sends anything through a volunteer relay.

const exec = promisify(execFile);

export const owner = "exit";

export interface ExitInvariantDeps {
    readonly capabilities: CapabilitiesStore;
    // The main routing table as `ip route show` prints it; injected so the check is testable without root.
    readonly mainRoutes?: () => Promise<string>;
}

const readMainRoutes = async (): Promise<string> =>
    await exec("ip", ["route", "show", "table", "main"]).then(
        ({ stdout }) => stdout,
        // No iproute2 or no permission reads as nothing observable, not a violation, or every exit-less sandbox fails.
        () => "",
    );

export const checks = ({ capabilities, mainRoutes = readMainRoutes }: ExitInvariantDeps): readonly InvariantCheck[] => [
    {
        name: "no-exit-route-in-the-main-table",
        // Runs at boot too: a route left by a previous container life would break the uplink before anything notices.
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const ids = (await capabilities.list()).flatMap((capability) => (capability.kind === "exit" ? [capability.id] : []));
            if (ids.length === 0) {
                return;
            }
            const table = await mainRoutes();
            if (table === "") {
                return;
            }
            const leaked = ids.filter((id) => new RegExp(`\\bdev ${exitInterface(id)}\\b`).test(table));
            if (leaked.length > 0) {
                fail(
                    `expected no exit to appear in the main routing table, found route(s) via ${leaked
                        .map((id) => `${exitInterface(id)} (exit "${id}")`)
                        .join(
                            ", ",
                        )}. An exit in table main takes the sandbox's own uplink with it: the daemon, the model endpoint and this container's tunnel all leave through a relay that was never meant to carry them.`,
                );
            }
        },
    },
    {
        name: "up-exits-come-out-where-they-were-asked",
        on: ["sweep"],
        run: async ({ fail }) => {
            const exits = (await capabilities.list()).flatMap((capability) => (capability.kind === "exit" ? [capability] : []));
            const drifted: string[] = [];
            for (const exit of exits) {
                // Only an exit this daemon actually serves can be judged; an unbound proxy is down or mid-repair.
                if (!proxyBound(exit.id) && exit.config.provider !== "tor") {
                    continue;
                }
                const wanted = (await readSelection(exit.id))?.country ?? exit.config.country;
                const seen = (await readObservation(exit.id))?.seen;
                if (wanted === undefined || seen?.country === undefined) {
                    continue;
                }
                if (seen.country !== wanted.toUpperCase()) {
                    drifted.push(
                        `"${exit.id}" was put in ${countryName(wanted)} and is now coming out of ${seen.countryName ?? seen.country} (${seen.ip})`,
                    );
                }
            }
            if (drifted.length > 0) {
                fail(
                    `${drifted.length} exit(s) have drifted from the country they were verified in: ${drifted.join("; ")}. Anything bound to them, a browser account most of all, is still acting as if they had not moved.`,
                );
            }
        },
    },
];
