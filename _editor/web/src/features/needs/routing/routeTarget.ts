import type { RouteNeed } from "@intentic/sandbox-contract/schemas/needs";

// WHICH OF THE READER'S SANDBOXES A ROUTE CARD PAIRS WITH. The daemon names the target by its tunnel id and the address
// the platform gave it, while the editor's list holds platform rows (their own ids, their daemon URL), so the target is
// found by its address, or by its name when no address matches. Undefined when it is not among them (a sandbox the reader
// has never opened in this editor, or one with no address yet), or when two answer to the name.

const hostOf = (address: string): string =>
    address
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, ``)
        .replace(/[/:?#].*$/, ``);

/** The reader's sandbox the card's target is, with an address to reach it at. */
export const farSandboxOf = <Candidate extends { readonly id: string; readonly name: string; readonly daemonUrl: string | null }>(
    candidates: readonly Candidate[],
    subject: Pick<RouteNeed, "address" | "targetName">,
): (Candidate & { readonly daemonUrl: string }) | undefined => {
    const reachable = candidates.filter((candidate): candidate is Candidate & { readonly daemonUrl: string } => candidate.daemonUrl !== null && candidate.daemonUrl !== ``);
    const address = subject.address;
    const byAddress = address === undefined ? undefined : reachable.find((candidate) => hostOf(candidate.daemonUrl) === hostOf(address));
    if (byAddress !== undefined) {
        return byAddress;
    }
    const named = reachable.filter((candidate) => candidate.name.toLowerCase() === subject.targetName.toLowerCase());
    return named.length === 1 ? named[0] : undefined;
};
