import { contributedServerMintingKinds } from "@intentic/extension-manifest";
// The MCP servers the daemon mounts under its own names, and whether each carries content from outside this container.
// One source of truth: the outside-content guard's exemption list is the `control` subset of this, and a capability
// whose id would become `mcp__<id>__…` is refused when the id is one of these, so nothing the owner configures can
// shadow a daemon server. A daemon server's name is what reaches the model as the `mcp__<name>__` prefix.

// Where a server's results come from, which decides whether they are wrapped as untrusted on the way into a turn:
// - control: the server relays only this daemon's own state; its results are never outside content
// - outside: the server carries content from beyond the container (a web page, a provider's verbatim sentence)
export type ServerProvenance = "control" | "outside";

// Every server agent/run/agent.ts and agent/run/harness/harness-servers.ts mount themselves, plus the browser router's two
// names (web, browser), which every turn mounts on its lease at the daemon's MCP door (browser-tools.ts) and which the
// text scan reads from their constants. A server added anywhere else without a row here fails the conformance test in the sandbox guard package.
export const DAEMON_MCP_SERVERS: Readonly<Record<string, ServerProvenance>> = {
    ui: "control", // agent.ts: AskUserQuestion
    accounts: "control", // agent.ts: the account roster and the credential typists
    terminal: "control", // agent.ts: the owner's tmux handover; its pane output wraps at the tool, not here
    code: "control", // agent.ts: the in-container JS backend; wrapped only when its script fetches, via its own branch
    secrets: "control", // harness: types a stored value into a focused field
    hashline: "control", // harness: hash-anchored Edit/Write replacements
    subagents: "control", // harness: the `wait` park
    watch: "control", // harness: condition watches
    deps: "control", // harness: dependency readiness
    diagnostics: "outside", // harness: two tools relay a provider's own sentence verbatim
    web: "outside", // the turn's mounts: the anonymous browser router; the page is the internet
    browser: "outside", // the turn's mounts: the signed-in browser router; the page is the internet
};

// Every daemon-mounted server name, the set a capability id may not collide with.
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(Object.keys(DAEMON_MCP_SERVERS));

// The subset whose results are the daemon's own and are never wrapped as outside content; the guard's exemption list
// derives from this, so a new control server is exempt the moment it is named above.
export const CONTROL_MCP_SERVERS: ReadonlySet<string> = new Set(
    Object.entries(DAEMON_MCP_SERVERS)
        .filter(([, provenance]) => provenance === "control")
        .map(([name]) => name),
);

// Capability kinds whose id becomes an MCP server name for the turn, and so whose id must not collide with a daemon
// server: `mcp`, a core kind that is its own endpoint, and every contributable kind the manifest schema says mints one
// (a device's and a connected browser's peer bridge, a cli card that serves tools), read off the schema's own meaning
// (`contributedServerMintingKinds`), so a kind that starts minting is refused here without a second list. Other kinds
// mint accounts, providers or infrastructure, never a `mcp__<id>__` server keyed by the id.
export const MCP_SERVER_MINTING_KINDS: ReadonlySet<string> = new Set(["mcp", ...contributedServerMintingKinds()]);

// Whether adding or renaming a capability of this kind to this id would shadow a daemon server. The one predicate the
// capability routes consult, so the refusal and this list can't drift.
export const collidesWithReservedServer = (kind: string, id: string): boolean =>
    MCP_SERVER_MINTING_KINDS.has(kind) && RESERVED_MCP_SERVER_NAMES.has(id);
