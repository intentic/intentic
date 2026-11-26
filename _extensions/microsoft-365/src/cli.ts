import { CardToolRefused, callCardTool, findWorkspaceRoot } from "@intentic/connector-runtime";
import { accountsFrom, selectAccount } from "./accounts.js";
import { inputsOf, saveAnswer } from "./cli-files.js";
import { HELP, LEGACY_ACTION_RUN, parse, validateArguments } from "./commands.js";
import type { RunAnswer } from "./tools.js";

// `m365`, on the agent's PATH through contributes.bin: picks the card, signs in or runs one command, prints JSON. A
// failure prints to stdout and exits 2, since an agent drops stderr.
// (2026-11-26) The card's sign-in is no longer in this process's environment: every command runs in the extension's
// backend, reached through the daemon's door for this turn's shell, which holds the refresh token and asks the owner's
// action rules (server.ts). This side reads the workspace files a command names and saves what comes back.

// One call to the card's tools; a refusal or a failure the tool reports is this command's failure.
const call = async (card: string, tool: string, args: Parameters<typeof callCardTool>[2]): Promise<string> => {
    const answer = await callCardTool(card, tool, args);
    if (answer.isError) {
        throw new Error(answer.text);
    }
    return answer.text;
};

// One card as `m365 accounts` lists it: what its backend says of its sign-in, or why this turn cannot reach it.
interface AccountRow {
    readonly id: string;
    readonly tenantId: string;
    readonly access: string;
    readonly signedIn?: boolean;
    readonly reachable?: false;
    readonly why?: string;
}

const accounts = async (): Promise<string> => {
    const rows: AccountRow[] = [];
    for (const account of accountsFrom(process.env)) {
        try {
            // SAFETY: the card's `status` tool answers exactly these fields (tools.ts).
            rows.push(JSON.parse(await call(account.id, "status", {})) as AccountRow);
        } catch (error) {
            if (!(error instanceof CardToolRefused)) {
                throw error;
            }
            rows.push({ id: account.id, tenantId: account.tenantId, access: account.access || "write", reachable: false, why: error.message });
        }
    }
    return JSON.stringify(rows, null, 2);
};

// Microsoft's device sign-in, run by the backend: the page and the code are printed, then this waits until it settles.
const login = async (card: string): Promise<string> => {
    process.stdout.write(`${await call(card, "sign_in", {})}\n`);
    for (;;) {
        // SAFETY: sign_in_wait answers { state, message } (sign-in.ts), and fails with why otherwise.
        const waited = JSON.parse(await call(card, "sign_in_wait", {})) as { state: string; message: string };
        if (waited.state !== "pending") {
            return waited.message;
        }
    }
};

const main = async (raw: readonly string[]): Promise<string> => {
    if (raw.length === 0 || raw.includes("--help") || raw[0] === "help") {
        return HELP;
    }
    const args = parse(raw);
    validateArguments(args);
    if (args.words[0] === "accounts") {
        return accounts();
    }
    const account = selectAccount(accountsFrom(process.env), args.flags["account"]);
    if (args.words[0] === "auth") {
        return login(account.id);
    }
    if (args.words.join(" ").startsWith("action run")) {
        throw new Error(LEGACY_ACTION_RUN);
    }
    const root = findWorkspaceRoot(process.env, process.cwd());
    // SAFETY: `run` answers a RunAnswer (tools.ts), and fails with why otherwise.
    const answer = JSON.parse(await call(account.id, "run", { argv: [...raw], files: await inputsOf(root, args) })) as RunAnswer;
    return JSON.stringify(await saveAnswer(root, answer), null, 2);
};

try {
    const output = await main(process.argv.slice(2));
    if (output !== "") {
        process.stdout.write(`${output}\n`);
    }
} catch (error) {
    process.stdout.write(`m365: ${error instanceof Error ? error.message : "the command failed"}\n`);
    process.exitCode = 2;
}
