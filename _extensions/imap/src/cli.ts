import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { callCardTool } from "@intentic/connector-runtime";
import { z } from "zod";
import { cardIdsFrom, selectCard } from "./card.js";
import type { OutgoingMail } from "./send.js";

// `imap`, on the agent's PATH through contributes.bin. It holds no credential: the card's password or sign-in stays in
// the extension's backend (server.ts), which this CLI reaches through the daemon's door for the card's tools, from the
// turn's own shell. It reads what the agent wrote (a draft, its attachments) and writes what comes back (`curl -o`).
// Whether a send goes out, waits for the owner, or is refused is the daemon's verdict on the owner's action rules, not
// this CLI's. A failure prints to stdout with exit 2; `imap curl` passes curl's own output and exit code through.

const HELP = `imap [--account <card id>] <command>
  send <draft.json>     send a draft from this mailbox, or put it before the owner when the action rules hold imap.message.send (they do unless a rule allows it)
  curl <curl arguments…>  one IMAP request with this mailbox's login, e.g. imap curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" -X "SEARCH UNSEEN" [-o file]
  login                 sign the mailbox in to Exchange Online (OAuth2 cards; run in the background, the owner types a code)`;

// The draft the agent writes: the mail, with its attachments named by workspace path.
const DraftSchema = z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    subject: z.string(),
    text: z.string(),
    html: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.array(z.string()).optional(),
    attachments: z.array(z.object({ path: z.string().min(1), name: z.string().optional(), contentType: z.string().optional() })).optional(),
});

const LEGACY_APPROVAL =
    "that approval was drafted by an older version of imap, which checked it against the workspace file. Nothing was sent. Held sends now go to the owner's approvals queue from the sandbox itself: run `imap send <the draft file>` without --approval-id to propose it again, and it is sent once the owner approves it in the app.";

// The draft as it goes to the backend: its attachments read now, so what the owner approves is what goes out.
const outgoingOf = async (file: string): Promise<OutgoingMail> => {
    const { attachments, ...mail } = DraftSchema.parse(JSON.parse(await readFile(resolve(file), "utf8")));
    if (attachments === undefined) {
        return mail;
    }
    const read = await Promise.all(
        attachments.map(async (attachment) => {
            const data = (await readFile(resolve(attachment.path))).toString("base64");
            const name = attachment.name ?? basename(attachment.path);
            return attachment.contentType === undefined ? { name, data } : { name, contentType: attachment.contentType, data };
        }),
    );
    return { ...mail, attachments: read };
};

const send = async (card: string, args: readonly string[]): Promise<string> => {
    const [draftFile, flag] = args;
    if (flag === "--approval-id") {
        throw new Error(LEGACY_APPROVAL);
    }
    if (draftFile === undefined || args.length !== 1) {
        throw new Error("usage: imap send <draft.json>");
    }
    const answered = await callCardTool(card, "send", await outgoingOf(draftFile));
    if (answered.isError) {
        throw new Error(answered.text);
    }
    return answered.text;
};

const RequestAnswerSchema = z.object({ exitCode: z.number(), stdout: z.base64(), stderr: z.string() });

// `-o <file>` / `--output <file>` is the CLI's own: the answer is written in the agent's checkout, never by the backend.
const outputOf = (args: readonly string[]): { readonly rest: string[]; readonly output?: string } => {
    const rest: string[] = [];
    let output: string | undefined;
    for (let index = 0; index < args.length; index++) {
        const word = args[index] ?? "";
        if (word === "-o" || word === "--output") {
            output = args[++index];
        } else if (word.startsWith("--output=")) {
            output = word.slice("--output=".length);
        } else {
            rest.push(word);
        }
    }
    return output === undefined ? { rest } : { rest, output };
};

const curl = async (card: string, args: readonly string[]): Promise<number> => {
    const { rest, output } = outputOf(args);
    const answered = await callCardTool(card, "request", { args: rest });
    if (answered.isError) {
        throw new Error(answered.text);
    }
    const { exitCode, stdout, stderr } = RequestAnswerSchema.parse(JSON.parse(answered.text));
    const bytes = Buffer.from(stdout, "base64");
    if (output === undefined) {
        process.stdout.write(bytes);
    } else {
        await writeFile(resolve(output), bytes);
    }
    process.stderr.write(stderr);
    return exitCode;
};

const SignInSchema = z.object({ state: z.enum(["pending", "done", "failed"]), lines: z.array(z.string()) });

// Starts the backend's sign-in, prints Microsoft's page and code, then waits for the owner to finish there.
const login = async (card: string): Promise<void> => {
    let printed = 0;
    const step = async (tool: "sign_in" | "sign_in_wait"): Promise<z.infer<typeof SignInSchema>> => {
        const answered = await callCardTool(card, tool, {});
        if (answered.isError) {
            throw new Error(answered.text);
        }
        const view = SignInSchema.parse(JSON.parse(answered.text));
        for (const line of view.lines.slice(printed)) {
            process.stdout.write(`${line}\n`);
        }
        printed = view.lines.length;
        return view;
    };
    let view = await step("sign_in");
    while (view.state === "pending") {
        view = await step("sign_in_wait");
    }
};

const main = async (argv: readonly string[]): Promise<number> => {
    const accountAt = argv[0] === "--account" ? 2 : 0;
    const [command, ...rest] = argv.slice(accountAt);
    if (command === undefined || command === "help" || command === "--help") {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const card = selectCard(cardIdsFrom(process.env), accountAt === 2 ? argv[1] : undefined);
    if (command === "curl") {
        return curl(card, rest);
    }
    if (command === "send") {
        process.stdout.write(`${await send(card, rest)}\n`);
        return 0;
    }
    if (command === "login" && rest.length === 0) {
        await login(card);
        return 0;
    }
    throw new Error(HELP);
};

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    process.stdout.write(`imap: ${error instanceof Error ? error.message : "the command failed"}\n`);
    process.exitCode = 2;
}
