import type { SandboxSummary } from "@intentic-app/api-contract";

/* THE SANDBOX LIST IS TWO LISTS, and every surface that draws it used to draw one.
 *
 * A sandbox that has never checked in is not somewhere you can switch to: it has no daemon, so selecting it can
 * only paint a connecting gate that never resolves — which is why the switcher answered a click on one by
 * bouncing the reader out of the workspace and back onto /setup. As a peer row with a "Setup" chip it read as a
 * machine you own that happens to be busy. What it actually is, is an unfinished errand, and it belongs under a
 * heading that says so rather than in the list of places to go.
 *
 * `lastSeenAt` is the test for the same reason setupGate.ts uses it: the daemon's announce stamps it, so does
 * sandbox.attach, and the stamp never un-happens. A sandbox that is merely DOWN keeps its stamp and stays
 * switchable — saying it is offline is the connection dot's job, not this partition's.
 */
export const connectedSandboxes = (rows: readonly SandboxSummary[]): readonly SandboxSummary[] => rows.filter((entry) => entry.lastSeenAt !== null);

export const unfinishedSandboxes = (rows: readonly SandboxSummary[]): readonly SandboxSummary[] => rows.filter((entry) => entry.lastSeenAt === null);
