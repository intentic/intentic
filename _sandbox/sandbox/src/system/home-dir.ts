import { homedir } from "node:os";

// The daemon user's home, read from HOME on every call: a suite points HOME at a temp dir, and Bun's homedir() keeps
// the value the process started with where Node's follows the variable, so every dot-file the daemon keeps there
// (ssh config, credentials, VPN and exit state) moves with HOME under either runtime.
export const homeDir = (): string => process.env["HOME"] ?? homedir();
