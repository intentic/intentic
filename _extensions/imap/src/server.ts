import { randomUUID } from "node:crypto";
import { storeRefreshTokenAsExtension } from "@intentic/connector-runtime";
import type { ApprovedAction, ApprovedActionOutcome, ExtensionServerApi, ServerActivation, ToolCard, ToolDefinition, ToolResult } from "@intentic/extension-api";
import { z } from "zod";
import { cardFromConfig, type ImapCard, smtpOf, usesOAuth } from "./card.js";
import { heldStore, type HeldStore } from "./held.js";
import { bindingOf, deviceLogin, mintAccessToken, providerOf } from "./oauth.js";
import { runRequest } from "./request.js";
import { buildMessage, deliver, DeliveryError, type MailCredential, mailDetails, type OutgoingMail, OutgoingMailSchema, recipientsOf, type Transport } from "./send.js";
import { signIns, type SignIns, type SignInView } from "./sign-in.js";

// The IMAP card's backend (2026-11-26): the only place the card's password, OAuth2 refresh token or access token is used.
// The card puts none of them in the agent's environment any more; `imap` on the agent's PATH reads the workspace and calls
// the tools served here for the card (`contributes.tools.perCard`), reached from the turn's shell through the daemon's
// `POST /tools/<card>`, which hands this backend the card's settings and the asking conversation with each call. A send
// asks the daemon for the owner's verdict on `imap.message.send` first (`POST /capabilities/<id>/outward-action`): an
// allowed one goes out here, a denied one is refused with the rule's reason, and a held one waits in the approvals queue
// until a person says yes, when the daemon's approvals executor hands it back to `api.approvals.perform` below. Nothing
// here reads a rule or an approval's status.

const ACTION = "message.send";

// What every part of the backend works with: the api, the held sends, and the way a message goes out.
interface Backend {
    readonly api: ExtensionServerApi;
    readonly held: HeldStore;
    readonly transport?: Transport;
}
// How long one `sign_in_wait` call holds before answering "still waiting", below the host's ten-minute call deadline.
const SIGN_IN_WAIT_MS = 8 * 60_000;
const SUMMARY_MAX = 200;

// What a held send keeps: the mail as it will go out, the card it goes out through and who it goes out as, and a nonce,
// so two identical drafts are two approvals with two digests.
const HeldSendSchema = z.object({
    version: z.literal(1),
    nonce: z.string(),
    card: z.string(),
    from: z.string(),
    smtpHost: z.string(),
    mail: OutgoingMailSchema,
});
type HeldSend = z.infer<typeof HeldSendSchema>;

const RequestInputSchema = z.object({ args: z.array(z.string().max(16_384)).max(64) });

const answer = (value: string, isError = false): ToolResult => {
    const content = [{ type: "text", text: value }] as const;
    return isError ? { content, isError } : { content };
};

const summaryOf = (mail: OutgoingMail): string => {
    const line = `Send email to ${recipientsOf(mail)}: ${mail.subject}`;
    return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
};

// The login this card presents: the password, or an access token minted for it, a token Microsoft rotated on the way
// stored on the card through the daemon (`permissions.daemon` names the route).
const credentialOf = async (api: ExtensionServerApi, card: ImapCard): Promise<MailCredential> =>
    usesOAuth(card)
        ? {
              accessToken: await mintAccessToken(card, {
                  save: async (refreshToken, previous) => {
                      await storeRefreshTokenAsExtension(api, { id: card.id, binding: bindingOf(card), previous, refreshToken });
                  },
              }),
          }
        : { password: card.password };

// The Activity row fields a send carries, the same for its verdict and its outcome.
interface SendCall {
    readonly id: string;
    readonly action: string;
    readonly endpoint: string;
    readonly channel: string;
    readonly content: string;
    readonly conversationId?: string;
}

const callOf = (card: ImapCard, mail: OutgoingMail, conversationId: string | undefined): SendCall => {
    const call: SendCall = {
        id: card.id,
        action: ACTION,
        endpoint: `smtp://${card.smtpHost}`,
        channel: recipientsOf(mail).slice(0, 500),
        content: `${mail.subject}\n\n${mail.text}`.slice(0, 64 * 1024),
    };
    return conversationId === undefined ? call : { ...call, conversationId };
};

// Delivers and records how it went; recording never fails a delivery that already happened.
const deliverRecorded = async (backend: Backend, card: ImapCard, mail: OutgoingMail, conversationId: string | undefined): Promise<void> => {
    const { api } = backend;
    const record = (outcome: "ok" | "error", error?: string): Promise<void> => {
        const row = { ...callOf(card, mail, conversationId), outcome };
        return api.daemon.rpc.capabilities
            .outwardActionOutcome(error === undefined ? row : { ...row, error: error.slice(0, 2000) })
            .then(
                () => undefined,
                (failure: Error) => api.log(`imap: the send's Activity row was not recorded: ${failure.message}`),
            );
    };
    try {
        await deliver(smtpOf(card, await credentialOf(api, card)), card.username, mail, backend.transport);
    } catch (error) {
        await record("error", error instanceof Error ? error.message : "the send failed");
        throw error;
    }
    await record("ok");
};

// Refuses before anything is asked of the owner: a draft that cannot go out as written, or a card with nowhere to send.
const checkSendable = (card: ImapCard, mail: OutgoingMail): void => {
    if (!card.smtpHost) {
        throw new Error("SMTP connection is incomplete: set the SMTP host on the IMAP card");
    }
    buildMessage(card.username, mail);
};

const send = async (backend: Backend, card: ImapCard, mail: OutgoingMail, conversationId: string | undefined): Promise<ToolResult> => {
    const { api, held } = backend;
    checkSendable(card, mail);
    const record: HeldSend = { version: 1, nonce: randomUUID(), card: card.id, from: card.username, smtpHost: card.smtpHost, mail };
    const digest = await held.put(JSON.stringify(record));
    let verdict: Awaited<ReturnType<typeof api.daemon.rpc.capabilities.outwardAction>>;
    try {
        verdict = await api.daemon.rpc.capabilities.outwardAction({
            ...callOf(card, mail, conversationId),
            hold: { summary: summaryOf(mail), details: mailDetails(card.username, mail), digest },
        });
    } catch (error) {
        await held.drop(digest);
        throw error;
    }
    if (verdict.verdict !== "hold") {
        await held.drop(digest);
    }
    if (verdict.verdict === "deny") {
        return answer(`Not sent: ${verdict.reason}.`, true);
    }
    if (verdict.verdict === "hold") {
        return answer(
            `Held for the owner's approval as ${verdict.approvalId ?? "an approvals-queue item"}: ${verdict.reason}. Nothing was sent. The owner reads the whole message in the app, and it goes out from this mailbox once they approve it; do not send it another way.`,
        );
    }
    await deliverRecorded(backend, card, mail, conversationId);
    return answer("SMTP delivery accepted");
};

const signInText = (view: SignInView | undefined): ToolResult => {
    if (view === undefined) {
        return answer("No sign-in was started for this card: run `imap login`.", true);
    }
    const said = view.lines.join("\n");
    return view.state === "failed" ? answer(said, true) : answer(JSON.stringify({ state: view.state, lines: view.lines }));
};

const startSignIn = (api: ExtensionServerApi, sessions: SignIns, card: ImapCard): Promise<SignInView> =>
    sessions.start(card.id, (out) =>
        deviceLogin(
            card,
            async (refreshToken, previous, login) => {
                await storeRefreshTokenAsExtension(api, { id: card.id, binding: bindingOf(card), previous, refreshToken, login: login === true });
            },
            out,
        ),
    );

const toolsFor = (backend: Backend, sessions: SignIns, tool: ToolCard): ToolDefinition[] => {
    const { api } = backend;
    const card = cardFromConfig(tool.id, tool.config);
    return [
        {
            name: "send",
            description:
                "Send one email from this mailbox through its SMTP server, unless the owner's action rules hold or refuse `imap.message.send` (it holds while no rule names it): a held one goes to the owner's approvals queue and is sent from here once they approve it. Attachments travel as base64 bytes. The `imap send <draft.json>` command calls this with a draft file and the workspace files it names.",
            inputSchema: z.toJSONSchema(OutgoingMailSchema),
            effect: "write",
            call: async (args, context) => send(backend, card, OutgoingMailSchema.parse(args), context.conversationId),
        },
        {
            name: "request",
            description:
                "One IMAP request to this mailbox's own server with its login, as curl arguments: the imaps:// URL, and optionally -X with an IMAP command, -s, -S, -f, -m. Answers curl's exit code, its output as base64 and its error text. The `imap curl` command calls this.",
            inputSchema: z.toJSONSchema(RequestInputSchema),
            effect: "write",
            call: async (args) => {
                const { args: words } = RequestInputSchema.parse(args);
                const ran = await runRequest(card, await credentialOf(api, card), words);
                return JSON.stringify({ exitCode: ran.exitCode, stdout: ran.stdout.toString("base64"), stderr: ran.stderr });
            },
        },
        {
            name: "sign_in",
            description:
                "Start Exchange Online's device-code sign-in for this mailbox (OAuth2 cards): answers Microsoft's page and a code for the owner to type there. Then call sign_in_wait. The `imap login` command does both.",
            inputSchema: { type: "object", properties: {} },
            effect: "write",
            call: async () => {
                if (providerOf(card) !== "microsoft" || !usesOAuth(card)) {
                    return answer("`imap login` signs in to Exchange Online on an OAuth2 card; for Gmail paste a refresh token on the card", true);
                }
                return signInText(await startSignIn(api, sessions, card));
            },
        },
        {
            name: "sign_in_wait",
            description: "Wait for the sign-in sign_in started to finish (up to eight minutes per call); answers pending, done or the refusal.",
            inputSchema: { type: "object", properties: {} },
            effect: "read",
            call: async () => signInText(await sessions.wait(card.id, SIGN_IN_WAIT_MS)),
        },
    ];
};

const refused = (error: string): ApprovedActionOutcome => ({ outcome: "refused", error });

const heldSendOf = (text: string): HeldSend | undefined => {
    try {
        return HeldSendSchema.safeParse(JSON.parse(text)).data;
    } catch {
        // allow(silent-catch): a held file that is not JSON is no held send, which the caller refuses in words
        return undefined;
    }
};

// The card the send was held under, as the daemon holds it now; undefined when it is gone or no longer this extension's.
const cardNow = async (api: ExtensionServerApi, id: string): Promise<ImapCard | undefined> => {
    try {
        const connection = await api.daemon.rpc.capabilities.connection({ id });
        return cardFromConfig(connection.id, connection.config);
    } catch {
        // allow(silent-catch): any refusal of the read means there is no card to send through, which the caller says
        return undefined;
    }
};

/**
 * A held send a person approved, handed over by the daemon only after it matched and spent their yes: sent exactly as it
 * was held, through the same card as the same sender, unless the owner's rules deny it now.
 */
export const performHeld = async (backend: Backend, action: Pick<ApprovedAction, "digest">): Promise<ApprovedActionOutcome> => {
    const { api, held } = backend;
    const taken = await held.take(action.digest);
    if (taken.kind !== "held") {
        return refused(
            taken.kind === "changed"
                ? "the held message changed since it was approved, so it was not sent"
                : "nothing is held under this approval (it may have been sent already, or drafted by an older version of imap): propose it again",
        );
    }
    const record = heldSendOf(taken.text);
    if (record === undefined) {
        return refused("the held message could not be read");
    }
    const card = await cardNow(api, record.card);
    if (card === undefined) {
        return refused(`the IMAP card "${record.card}" this was held under is no longer connected`);
    }
    if (card.username !== record.from || card.smtpHost !== record.smtpHost) {
        return refused(`the IMAP card "${record.card}" now sends as ${card.username} through ${card.smtpHost || "no SMTP host"}, not as it was approved`);
    }
    const verdict = await api.daemon.rpc.capabilities.outwardAction(callOf(card, record.mail, undefined));
    if (verdict.verdict === "deny") {
        return refused(verdict.reason);
    }
    try {
        await deliverRecorded(backend, card, record.mail, undefined);
    } catch (error) {
        if (error instanceof DeliveryError && error.maybeSent) {
            return { outcome: "uncertain", error: error.message };
        }
        return refused(error instanceof Error ? error.message : "the send failed before reaching the server");
    }
    await held.drop(action.digest);
    return { outcome: "done", result: `SMTP delivery accepted for ${recipientsOf(record.mail)}` };
};

export interface BackendOptions {
    // How a message reaches the SMTP server; curl unless a suite stands in for it.
    readonly transport?: Transport;
}

/** The backend's activation, with the seams a suite stands in for. */
export const imapBackend =
    (options: BackendOptions = {}) =>
    (api: ExtensionServerApi): ServerActivation => {
        const base: Backend = { api, held: heldStore(api.stateDir) };
        const backend: Backend = options.transport === undefined ? base : { ...base, transport: options.transport };
        const sessions = signIns();
        api.tools.serve((card) => (card === undefined ? [] : toolsFor(backend, sessions, card)));
        api.approvals.perform((action) => performHeld(backend, action));
        return { deactivate: () => undefined };
    };

export const activateServer = imapBackend();
