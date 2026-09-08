import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Per-boot token for the vpn/otp CLIs, scoped by auth/grants.ts to /vpn and the otp mint only.
const AGENT_TOKEN_PATH = "/run/intentic/agent.token";

export const writeAgentToken = async (token: string): Promise<void> => {
    await mkdir(dirname(AGENT_TOKEN_PATH), { recursive: true, mode: 0o700 });
    await writeFile(AGENT_TOKEN_PATH, token, { mode: 0o600 });
};
