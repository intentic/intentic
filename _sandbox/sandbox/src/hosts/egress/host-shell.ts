import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Device } from "@intentic/sandbox-contract/schemas/devices";

/* WHETHER THIS SANDBOX CAN RUN COMMANDS ON THE MACHINE IT RUNS ON (2026-10-27).

A fence on the host's network refuses the sandbox's own packets; it does nothing about a command the sandbox asks the
machine's agent to run, which leaves from the machine itself. So a sandbox holding a device card with "Run commands"
(`shell`) or "Run programs" (`programs`) on the very computer it runs on reaches past any fence there, and its rows say
so (`egress.hostShell`) for the Devices view to warn beside the fence. Only ic knows the fence and only this daemon
knows its own cards, so this is filled in here, for this sandbox's own row alone: another sandbox's cards are not
this daemon's to read. The same computer is any environment of it (Windows and a distro on it share one machine id). */

// The device cards that run commands out there.
export const commandingCards = (cards: readonly Capability[]): ReadonlySet<string> =>
    new Set(cards.flatMap((card) => (card.kind === "device" && (card.config.shell !== "off" || card.config.programs === "on") ? [card.id] : [])));

// The rows with this sandbox's own `egress.hostShell` said, true or false, wherever ic reported a fence for it.
export const withHostShell = (rows: Device[], ownSlug: string | undefined, commanding: ReadonlySet<string>): Device[] => {
    if (ownSlug === undefined) {
        return rows;
    }
    const reached = new Set(
        rows.flatMap((row) => (row.card !== undefined && row.machineId !== undefined && commanding.has(row.card) ? [row.machineId] : [])),
    );
    return rows.map((row) => {
        const own = row.sandboxes?.find((sandbox) => sandbox.slug === ownSlug);
        if (own?.egress === undefined || row.sandboxes === undefined) {
            return row;
        }
        const hostShell = row.machineId !== undefined && reached.has(row.machineId);
        return {
            ...row,
            sandboxes: row.sandboxes.map((sandbox) =>
                sandbox === own && sandbox.egress !== undefined ? { ...sandbox, egress: { ...sandbox.egress, hostShell } } : sandbox,
            ),
        };
    });
};
