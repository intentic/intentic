import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// The per-boot token the in-container `vpn` CLI presents to the daemon (x-intentic-agent). It lives in a file
// rather than an environment variable so EVERY in-container caller can find it the same way: an agent turn's
// Bash, one of the owner's terminal tabs, and a tmux session that outlived the turn that spawned it.
//
// The file is 0600 under /run, which in this container means "root only" — and everything here runs as root, so
// that is a tidiness guarantee, not an isolation one. The isolation that matters is the SCOPE: app.ts admits
// this token to the /vpn routes and nothing else, so possessing it buys the ability to dial and drop the
// tunnels the owner already configured — never to read the credentials behind them, and never any other route.
// It is regenerated every boot, so a leaked copy dies with the container.
export const AGENT_TOKEN_PATH = "/run/intentic/agent.token";

export const writeAgentToken = async (token: string): Promise<void> => {
    await mkdir(dirname(AGENT_TOKEN_PATH), { recursive: true, mode: 0o700 });
    await writeFile(AGENT_TOKEN_PATH, token, { mode: 0o600 });
};
