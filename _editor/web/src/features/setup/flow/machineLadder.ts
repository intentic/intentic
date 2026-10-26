// Which machine runs a sandbox being set up: a machine of ours, or one of the reader's own (this computer, a connected
// machine, a server the command is run on). The hosted lane holds it (useHostedLane.ts); a code is minted only off it.
export type Machine = `hosted` | `mine`;
