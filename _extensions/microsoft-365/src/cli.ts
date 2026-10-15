import { findWorkspaceRoot } from "@intentic/connector-runtime";
import { accountsFrom, selectAccount } from "./accounts.js";
import { deviceLogin, fileTokenCache, saveToVault, tokenSession } from "./auth.js";
import { HELP, parse, runCommand, validateArguments } from "./commands.js";
import { Graph } from "./graph.js";

// `m365`, on the agent's PATH through contributes.bin: picks the card, signs in or runs one command, prints JSON. A
// failure prints to stdout and exits 2, since an agent drops stderr.

const main = async (raw: readonly string[]): Promise<string> => {
    if (raw.length === 0 || raw.includes("--help") || raw[0] === "help") {
        return HELP;
    }
    const args = parse(raw);
    validateArguments(args);
    const accounts = accountsFrom(process.env);
    if (args.words[0] === "accounts") {
        return JSON.stringify(
            accounts.map(({ id, tenantId, access, refreshToken }) => ({ id, tenantId, access: access || "write", signedIn: Boolean(refreshToken) })),
            null,
            2,
        );
    }
    const account = selectAccount(accounts, args.flags["account"]);
    const save = saveToVault(account);
    if (args.words[0] === "auth") {
        await deviceLogin(account, save, (line) => process.stdout.write(`${line}\n`));
        return "";
    }
    const root = findWorkspaceRoot(process.env, process.cwd());
    const graph = new Graph(account, tokenSession(account, save, { cache: fileTokenCache(root, account) }));
    return JSON.stringify((await runCommand(graph, root, args)) ?? { done: true }, null, 2);
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
