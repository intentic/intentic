import { errorMessage } from "@intentic/base/errors";
import { type Args, bool, flag, parseArgs, rejectUnknownFlags } from "./cli/args.js";
import type { Command, CommandGroup, RootCommand, RootContext } from "./cli/command.js";
import { type Connection, connectionsFrom, describe, retargetAs, selectConnection } from "./google/accounts.js";
import { openSession } from "./google/session.js";
import { accountsCommand, authGroup, whoamiCommand } from "./services/auth.js";
import { calendarGroup } from "./services/calendar.js";
import { contactsGroup } from "./services/contacts.js";
import { docsGroup } from "./services/docs.js";
import { driveGroup } from "./services/drive.js";
import { mailGroup } from "./services/mail.js";
import { sheetsGroup } from "./services/sheets.js";

// `gw`: one command for the whole of Google Workspace, reached through bin/gw on the agent's PATH. The router decides
// once what a switch elsewhere would repeat: which account, whether it may write, and what a failure looks like; a
// command below is only the API call and how to print it.
// The agent-CLI contract: everything, errors included, goes to stdout, since an agent drops stderr and would read a
// failure as an empty answer. Exit 0 is an answer (an empty search says so in words), 2 is anything else: a usage error,
// a refusal, a failed call.

const GROUPS: readonly CommandGroup[] = [mailGroup, calendarGroup, driveGroup, docsGroup, sheetsGroup, contactsGroup, authGroup];
const ROOT_COMMANDS: readonly RootCommand[] = [accountsCommand];
const SESSION_COMMANDS: readonly Command[] = [whoamiCommand];

const usage = (out: (line: string) => void): void => {
    out("gw: Gmail, Calendar, Drive, Docs, Sheets and Contacts for the connected Google accounts.");
    out("");
    out("  gw [--account <name>] [--as someone@company.com] [--json] <group> <command> [flags]");
    out("");
    for (const group of GROUPS) {
        out(`  ${group.name.padEnd(9)} ${group.summary}`);
    }
    for (const command of [...ROOT_COMMANDS, ...SESSION_COMMANDS]) {
        out(`  ${command.name.padEnd(9)} ${command.summary}`);
    }
    out("");
    out("  gw <group>          what that group can do");
    out("  --json              Google's own response instead of the summary lines");
    out("  --account <name>    which connected account, when more than one is (gw accounts)");
    out("  --as <email>        act as another person: company connections only");
};

const groupUsage = (group: CommandGroup, out: (line: string) => void): void => {
    out(`${group.name}: ${group.summary}`);
    out("");
    for (const command of [...group.commands, ...(group.rootCommands ?? [])]) {
        out(`  ${command.usage}`);
        out(`      ${command.summary}`);
    }
};

const run = async (args: Args, out: (line: string) => void): Promise<number> => {
    rejectUnknownFlags(args);
    const json = bool(args, "json");
    const connections = connectionsFrom(process.env);
    const context: RootContext = { args, json, out, connections };
    const [head, second] = args.positional;

    if (head === undefined || head === "help" || (bool(args, "help", "h") && head === undefined)) {
        usage(out);
        return head === undefined ? 2 : 0;
    }

    const rootCommand = ROOT_COMMANDS.find((command) => command.name === head);
    if (rootCommand !== undefined) {
        await rootCommand.run(context);
        return 0;
    }

    // The account this run acts as, resolved lazily so a group's help and its connectionless subcommands work with
    // nothing connected.
    const chosen = (): Connection => retargetAs(selectConnection(connections, flag(args, "account")), flag(args, "as"));

    const sessionCommand = SESSION_COMMANDS.find((command) => command.name === head);
    if (sessionCommand !== undefined) {
        const connection = chosen();
        await sessionCommand.run({ ...context, connection, session: openSession(connection, process.env, process.cwd(), Date.now) });
        return 0;
    }

    const group = GROUPS.find((candidate) => candidate.name === head);
    if (group === undefined) {
        out(`No such group "${head}".`);
        out("");
        usage(out);
        return 2;
    }
    if (second === undefined) {
        groupUsage(group, out);
        return 2;
    }

    const rootSubcommand = group.rootCommands?.find((command) => command.name === second);
    if (rootSubcommand !== undefined) {
        await rootSubcommand.run(context);
        return 0;
    }

    const command = group.commands.find((candidate) => candidate.name === second);
    if (command === undefined) {
        out(`"${head} ${second}" is not a command.`);
        out("");
        groupUsage(group, out);
        return 2;
    }

    const connection = chosen();
    // Google would refuse this too (narrower scopes), but as an auth error, not the setting the owner chose.
    if (command.writes === true && connection.access === "read") {
        out(`"${describe(connection)}" is connected read-only, so ${head} ${second} is not available.`);
        out("Change it to Read & write on the Google Workspace card if that is what you want.");
        return 2;
    }
    await command.run({ ...context, connection, session: openSession(connection, process.env, process.cwd(), Date.now) });
    return 0;
};

// `gw ... | head` closes the pipe under us; EPIPE ends the command quietly, not with node's default stack trace.
let piped = false;
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
        piped = true;
        return;
    }
    throw error;
});

const args = parseArgs(process.argv.slice(2));
const out = (line: string): void => {
    if (piped) {
        return;
    }
    process.stdout.write(`${line}\n`);
};

try {
    process.exitCode = await run(args, out);
} catch (error) {
    // stdout, never stderr: `gw … 2>/dev/null` is an agent reflex. 2 for every failure, so none reads as an answer.
    out(`gw: ${errorMessage(error)}`);
    process.exitCode = 2;
}
