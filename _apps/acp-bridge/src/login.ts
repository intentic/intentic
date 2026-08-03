import readline from "node:readline/promises";
import { createDaemonClient } from "./daemon-client.js";
import { writeConfig } from "./config.js";

/* `intentic-acp login` — the ACP terminal auth method (the client runs THIS binary interactively): prompt
 * for the sandbox URL and an owner-minted bridge token, validate with the auth probe, persist to
 * ~/.intentic/acp/config.json (0600). Exit code is the auth outcome the editor reads. */

export const runLogin = async (): Promise<number> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log("Connect this machine's editor to your intentic sandbox.");
        console.log("Mint a bridge token in the sandbox app under Sandbox → Sync → Editor bridge (ACP).\n");
        const url = (await rl.question("Sandbox URL (https://sandbox-…): ")).trim().replace(/\/$/, "");
        const token = (await rl.question("Control token (ict_…): ")).trim();
        const agent = (await rl.question("Agent [claude]: ")).trim();
        if (url === "" || token === "") {
            console.error("Both the URL and the token are required.");
            return 1;
        }
        await createDaemonClient(url, token).listSessions();
        const path = writeConfig({ url, token, ...(agent !== "" ? { agent } : {}) });
        console.log(`\nConnected. Credentials saved to ${path} — your editor can now use the intentic agent.`);
        return 0;
    } catch (error) {
        console.error(`\nLogin failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return 1;
    } finally {
        rl.close();
    }
};
