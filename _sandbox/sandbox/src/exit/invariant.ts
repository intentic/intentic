import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { InvariantCheck } from "../invariants/invariants.js";
import { countryName } from "./exit-countries.js";
import { exitInterface } from "./exit-paths.js";
import { readObservation, readSelection } from "./exit-state.js";
import { proxyBound } from "./exit-tunnel.js";

/* THE TWO PROMISES A GEO EXIT MAKES, BOTH OF WHICH FAIL SILENTLY.
 *
 * This subsystem's whole design rests on two statements that are established once and then never re-checked by
 * anything on the normal path, which is exactly the shape this registry exists for.
 *
 *   AN EXIT ROUTES NOTHING INTO THE MAIN TABLE. Everything else is downstream of this. An exit is a full
 *     tunnel by construction, so a default route leaking into table `main` swallows the daemon's own uplink,
 *     the model endpoint and the tunnel that makes this sandbox reachable. The symptom is the agent going
 *     silent mid-turn with no mention of a VPN, which reads as the agent breaking. The drivers are careful
 *     (`route-nopull` for openvpn, `Table = off` for wg-quick), but "careful" is a property of code that can
 *     be edited, and a provider that changes its pushed config can produce this without anything here
 *     changing at all.
 *
 *   AN EXIT THAT READS UP COMES OUT WHERE IT WAS ASKED TO. The links layer proves this at the moment of the
 *     switch and stops the exit when it cannot. It cannot prove it afterwards: tor rebuilds circuits on its
 *     own schedule and a relay can be re-homed, so an exit verified as German an hour ago is not necessarily
 *     German now. Nothing on the normal path re-asks, and a browser account bound to that exit carries on
 *     believing it.
 *
 * Both checks read state that already exists: the kernel's routing table, and the observation the last check
 * wrote. Neither sends anything through a volunteer relay, because a diagnostic that costs donated bandwidth
 * every sweep is a diagnostic that gets turned off.
 */

const exec = promisify(execFile);

export const owner = "exit";

export interface ExitInvariantDeps {
    readonly capabilities: CapabilitiesStore;
    // The main routing table, as `ip route show` prints it. Injected so the check is testable without root and
    // without a tunnel; the default is the real thing.
    readonly mainRoutes?: () => Promise<string>;
}

const readMainRoutes = async (): Promise<string> =>
    await exec("ip", ["route", "show", "table", "main"]).then(
        ({ stdout }) => stdout,
        // No iproute2, or no permission: nothing observable, which is not the same as a violation. A check that
        // reported a failure here would cry wolf on every sandbox that has never had an exit.
        () => "",
    );

export const checks = ({ capabilities, mainRoutes = readMainRoutes }: ExitInvariantDeps): readonly InvariantCheck[] => [
    {
        name: "no-exit-route-in-the-main-table",
        // On boot as well as on sweep: a route left behind by a previous life of this container is exactly the
        // state that would break the daemon's own uplink before anything else got a chance to notice.
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
                // Only an exit this daemon is actually serving can be judged: one whose proxy is not bound is
                // down, or mid-repair after a restart, and its last observation describes a tunnel nobody can
                // reach through it anyway.
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
