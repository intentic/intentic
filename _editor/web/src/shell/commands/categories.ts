// The families a built-in command can belong to, in one table because the word is part of the command's name
// everywhere it is read ("Terminal: Split"): two registrars spelling the same family differently would split it into
// two on every surface. An extension names its own family in its manifest.

/** Destinations: areas, hub sections, anything that answers "where". */
export const GO_TO = `Go to`;
export const SANDBOX = `Sandbox`;
export const SETTINGS = `Settings`;

/** The surfaces that own actions of their own. */
export const WORKSPACE = `Workspace`;
export const TERMINAL = `Terminal`;
export const CHAT = `Chat`;
export const PREVIEW = `Preview`;
export const AGENTS = `Agents`;
export const ACCOUNT = `Account`;
