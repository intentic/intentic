import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findWorkspaceRoot, storeRefreshTokenAsAgent } from "@intentic/connector-runtime";
import { cardsFrom, type ImapCard, selectCard, smtpOf, usesOAuth } from "./card.js";
import { bindingOf, deviceLogin, mintAccessToken, type SaveToken } from "./oauth.js";
import {
    approvalsDir,
    curlLogin,
    deliver,
    draftDigest,
    type MailCredential,
    type MailDraft,
    prepareApproval,
    sendRule,
    settingsFile,
    withCurlLogin,
} from "./send.js";

// `imap`, on the agent's PATH through contributes.bin: sends a draft through the card's SMTP server (held for the
// owner's approval by default), runs curl against the mailbox with the card's login kept out of the command line and
// the output, and signs a mailbox in to Exchange Online. A failure prints to stdout with exit 2; `imap curl` passes
// curl's own output and exit code through.

const HELP = `imap [--account <card id>] <command>
  send <draft.json> [--approval-id <id>]   send a draft (held for approval unless an action rule allows imap.message.send)
  curl <curl arguments…>                    curl with this mailbox's login, e.g. imap curl --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" -X "SEARCH UNSEEN"
  login                                     sign the mailbox in to Exchange Online (OAuth2 cards; run in the background, the owner types a code)`;

const saveFor =
    (card: ImapCard): SaveToken =>
    async (refreshToken, previous, login) => {
        await storeRefreshTokenAsAgent({ id: card.id, binding: bindingOf(card), previous, refreshToken, login: login === true });
    };

// The login this command presents: the password, or an access token minted for it.
const credentialOf = async (card: ImapCard): Promise<MailCredential> =>
    usesOAuth(card) ? { accessToken: await mintAccessToken(card, { save: saveFor(card) }) } : { password: card.password };

const send = async (card: ImapCard, args: readonly string[]): Promise<string> => {
    const [draftFile, flag, approvalId] = args;
    if (draftFile === undefined || (flag !== undefined && (flag !== "--approval-id" || approvalId === undefined)) || args.length > 3) {
        throw new Error("usage: imap send <draft.json> [--approval-id <id>]");
    }
    const root = findWorkspaceRoot(process.env, process.cwd());
    // SAFETY: the agent's own draft; buildMessage validates every address and header before anything is sent.
    const draft = JSON.parse(await readFile(resolve(draftFile), "utf8")) as MailDraft;
    // SAFETY: only actionRules is read, and sendRule treats a missing or unknown value as hold.
    const settings = JSON.parse(await readFile(settingsFile(root), "utf8").catch(() => "{}")) as { actionRules?: Record<string, string> };
    const rule = sendRule(settings.actionRules);
    if (rule === "deny") {
        throw new Error("imap.message.send is denied by this sandbox's action rules");
    }
    if (approvalId === undefined && rule === "hold") {
        return `Held for the owner's approval: ${await prepareApproval(root, draft, card.id)}. Nothing was sent.`;
    }
    if (approvalId !== undefined) {
        if (!/^imap-send-[a-f0-9-]+$/.test(approvalId)) {
            throw new Error("that is not an IMAP approval id");
        }
        // SAFETY: status and instructions are the only fields read; both are checked against this exact draft below.
        const item = JSON.parse(await readFile(`${approvalsDir(root)}/${approvalId}.json`, "utf8")) as { status?: string; instructions?: string };
        if (item.status !== "running" || item.instructions?.includes(await draftDigest(draft)) !== true) {
            throw new Error("the owner has not set this exact draft running");
        }
    }
    await deliver(smtpOf(card, await credentialOf(card)), card.username, draft);
    return "SMTP delivery accepted";
};

// curl with the login in a 0600 config file: never on its command line, never in its output.
const curl = async (card: ImapCard, args: readonly string[]): Promise<number> => {
    const login = curlLogin(card.username, await credentialOf(card));
    return withCurlLogin(
        login,
        (config) =>
            new Promise<number>((done, fail) => {
                const child = spawn("curl", ["--config", config, ...args], { stdio: "inherit" });
                child.on("error", fail);
                child.on("close", (code) => done(code ?? 1));
            }),
    );
};

const main = async (argv: readonly string[]): Promise<number> => {
    const accountAt = argv[0] === "--account" ? 2 : 0;
    const [command, ...rest] = argv.slice(accountAt);
    if (command === undefined || command === "help" || command === "--help") {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const card = selectCard(cardsFrom(process.env), accountAt === 2 ? argv[1] : undefined);
    if (command === "curl") {
        return curl(card, rest);
    }
    if (command === "send") {
        process.stdout.write(`${await send(card, rest)}\n`);
        return 0;
    }
    if (command === "login" && rest.length === 0) {
        await deviceLogin(card, saveFor(card), (line) => process.stdout.write(`${line}\n`));
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
