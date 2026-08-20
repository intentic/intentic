import { type Args, UsageError, bool, flag, parseArgs } from "./cli/args.js";
import type { Command, CommandGroup, RootCommand, RootContext } from "./cli/command.js";
import { type Connection, connectionsFrom, describe, selectConnection } from "./google/accounts.js";
import { openSession } from "./google/session.js";
import { accountsCommand, authGroup, whoamiCommand } from "./services/auth.js";
import { calendarGroup } from "./services/calendar.js";
import { contactsGroup } from "./services/contacts.js";
import { docsGroup } from "./services/docs.js";
import { driveGroup } from "./services/drive.js";
import { mailGroup } from "./services/mail.js";
import { sheetsGroup } from "./services/sheets.js";

/* `gw`, one command for the whole of Google Workspace, reached through bin/gw on the agent's PATH.
 *
 * The router is thin on purpose. Every decision that could be spread across commands is made once here:
 * which account (there may be several connected, and guessing is not acceptable), whether the account is
 * allowed to change anything, and what a failure looks like. A command below is then only the API call and
 * how to print it. */

const GROUPS: readonly CommandGroup[] = [mailGroup, calendarGroup, driveGroup, docsGroup, sheetsGroup, contactsGroup, authGroup];
const ROOT_COMMANDS: readonly RootCommand[] = [accountsCommand];
const SESSION_COMMANDS: readonly Command[] = [whoamiCommand];

const usage = (out: (line: string) => void): void => {
    out("gw — Gmail, Calendar, Drive, Docs, Sheets and Contacts for the connected Google accounts.");
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
    out("  --as <email>        act as another person — company connections only");
};

const groupUsage = (group: CommandGroup, out: (line: string) => void): void => {
    out(`${group.name} — ${group.summary}`);
    out("");
    for (const command of [...group.commands, ...(group.rootCommands ?? [])]) {
        out(`  ${command.usage}`);
        out(`      ${command.summary}`);
    }
};

// `--as` retargets a company connection at another person in the domain; on a personal grant there is nobody
// else it could act as, and pretending otherwise would produce a token for the wrong mailbox.
const retarget = (connection: Connection, as: string | undefined): Connection => {
    if (as === undefined) {
        return connection;
    }
    if (connection.mode !== "domain") {
        throw new UsageError(
            `--as only works on a company (service account) connection. "${describe(connection)}" is one person's own grant, so it can only act as ${connection.email}.`,
        );
    }
    return { ...connection, email: as };
};

const run = async (args: Args, out: (line: string) => void): Promise<number> => {
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

    // The account this run acts as, chosen once, resolved lazily so a group's own help and its connectionless
    // subcommands still work with nothing connected.
    const chosen = (): Connection => retarget(selectConnection(connections, flag(args, "account")), flag(args, "as"));

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
    /* THE READ-ONLY REFUSAL, in one place. A read-only connection also holds narrower scopes, so Google would
     * refuse this too, but it would refuse it as an authentication error, which reads like something broken
     * rather than like the setting the owner chose. */
    if (command.writes === true && connection.access === "read") {
        out(`"${describe(connection)}" is connected read-only, so ${head} ${second} is not available.`);
        out("Change it to Read & write on the Google Workspace card if that is what you want.");
        return 1;
    }
    await command.run({ ...context, connection, session: openSession(connection, process.env, process.cwd(), Date.now) });
    return 0;
};

/* `gw … | head` closes the pipe under us, and node's default for a write to a closed pipe is an unhandled
 * 'error' event, a stack trace where the answer should be. Piping a listing into `head` is a completely
 * ordinary thing to do to this tool, so a broken pipe ends the command quietly instead. */
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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
}
