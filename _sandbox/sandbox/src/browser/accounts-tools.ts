import { randomInt } from "node:crypto";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { z } from "zod";
import { createRequest, resolveRequest } from "../agent/agent-requests.js";
import { browserAccountPage, clearBrowserHelp, raiseBrowserHelp } from "./browser-sessions.js";
import { markConnected } from "./session-store.js";

/* THE ACCOUNTS TOOLS: what lets the agent CONNECT a browser account itself — sign in, sign up, and call for the
 * owner when a step needs a person — instead of every login being the owner's own hands in the guided window.
 *
 * The design rule throughout is the manifest's TOTP rule, applied to passwords: a stored credential must never
 * enter the model's context. So there is no "read the password" tool. The daemon TYPES it — into the focused
 * field of the account's live page, over the same CDP attach the /browsers view watches through — and when the
 * agent signs UP, the daemon GENERATES the password and stores it on the capability, so even a credential the
 * agent caused to exist is one it never saw. What the model handles is one bit: "typed" or an error.
 *
 * Scoped to the accounts THIS TURN may act through (the identity filter turn-plan already applies to the
 * browser servers): a tool addressed to any other account errors rather than reaching a profile the turn's
 * face was never allowed to wear. */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/* A generated password: 20 characters, all four classes guaranteed. Sites disagree about which symbols they
 * accept, so the symbol set is the conservative handful that virtually every policy allows. Shuffled so the
 * guaranteed classes don't sit at predictable positions. crypto.randomInt throughout — this is a credential. */
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "!@#$%^*-_+=";
const ALL = LOWER + UPPER + DIGIT + SYMBOL;
export const generatePassword = (): string => {
    const pick = (set: string): string => set[randomInt(set.length)] ?? "";
    const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL), ...Array.from({ length: 16 }, () => pick(ALL))];
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
    }
    return chars.join("");
};

// What the daemon needs from the composition — narrowed to the two store calls so tests can hand in a map.
export interface AccountsDeps {
    readonly capabilities: {
        readonly get: (id: string) => Promise<Capability | undefined>;
        readonly upsert: (capability: Capability) => Promise<void>;
    };
    readonly root: string;
    // The browser capability ids this turn's identity speaks for — the same filter the browser servers got.
    readonly accounts: readonly string[];
    readonly conversationId?: string | undefined;
    // An unattended turn gets no request_help: it would park on a person who is not there. The other tools
    // stay — an automation may finish an email-code login with nobody watching.
    readonly attended: boolean;
}

// Resolved per call rather than captured at server build: the owner can add the password mid-turn (the agent
// asked for it in chat, the owner put it on the card) and the very next type_credential should see it.
const browserAccount = async (deps: AccountsDeps, id: string): Promise<Capability | undefined> => {
    if (!deps.accounts.includes(id)) {
        return undefined;
    }
    const capability = await deps.capabilities.get(id);
    return capability?.kind === "browser" ? capability : undefined;
};

const NO_ACCOUNT = (id: string): string =>
    `no browser account "${id}" this turn can act through — the account is the capability's id (the skill that taught you its browser tools names it)`;

// The focused element, if it can take typed text. Checked before typing a credential so a mis-click sends the
// password into an error message here rather than into a search box on the wrong part of the page.
const focusedEditable = async (page: import("playwright").Page): Promise<boolean> =>
    page
        .evaluate(() => {
            const el = document.activeElement;
            if (el === null) {
                return false;
            }
            const tag = el.tagName.toLowerCase();
            return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
        })
        .catch(() => false);

export type AccountsServerFactory = (push: (event: AgentEvent) => void, signal: AbortSignal) => McpSdkServerConfigWithInstance;

export const accountsServer =
    (deps: AccountsDeps): AccountsServerFactory =>
    (push, signal) =>
        createSdkMcpServer({
            name: "accounts",
            alwaysLoad: true,
            tools: [
                tool(
                    "type_credential",
                    "Type a browser account's STORED username or password into the focused field of that account's live browser page. You never see the value — click the field with the account's browser_click first, then call this. The result confirms the typed username (you may need it, e.g. to find its inbox); a password is never echoed.",
                    {
                        account: z.string().describe("The browser account (capability id) whose credential to type"),
                        field: z.enum(["username", "password"]).describe("Which stored value to type"),
                    },
                    async ({ account, field }) => {
                        const capability = await browserAccount(deps, account);
                        if (capability === undefined) {
                            return fail(NO_ACCOUNT(account));
                        }
                        const value = (capability.config as BrowserConfig)[field];
                        if (value === undefined || value === "") {
                            return fail(
                                field === "password"
                                    ? `no password is stored for "${account}" — ask the owner to add it on the account's card, or raise request_help so they can type it themselves`
                                    : `no username is stored for "${account}" — ask the owner, or read it off the site if it is visible`,
                            );
                        }
                        const page = browserAccountPage(account);
                        if (page === undefined) {
                            return fail(`"${account}" has no live browser page — open the site with that account's browser tools first`);
                        }
                        if (!(await focusedEditable(page))) {
                            return fail("no text field is focused on the page — browser_click the field first, then call this again");
                        }
                        // A human-ish keystroke cadence, matching the stealth posture of everything else on
                        // this profile; insertText would skip the key events some login forms listen for.
                        await page.keyboard.type(value, { delay: 30 });
                        return ok(field === "username" ? `typed the stored username: ${value}` : "typed the stored password (not shown)");
                    },
                ),
                tool(
                    "create_password",
                    "Generate a strong password for a browser account and STORE it on the account's card (its secret). You never see it — fill sign-up forms by focusing the password field and calling type_credential (twice for a confirm field). Refuses to replace an existing stored password unless `replace` is set.",
                    {
                        account: z.string().describe("The browser account (capability id) to store the password on"),
                        replace: z.boolean().optional().describe("Replace an already-stored password (e.g. the site rejected it)"),
                    },
                    async ({ account, replace }) => {
                        const capability = await browserAccount(deps, account);
                        if (capability === undefined) {
                            return fail(NO_ACCOUNT(account));
                        }
                        const config = capability.config as BrowserConfig;
                        if (config.password !== undefined && config.password !== "" && replace !== true) {
                            return fail(`"${account}" already stores a password — type it with type_credential, or pass replace: true if the site refused it`);
                        }
                        await deps.capabilities.upsert({ ...capability, config: { ...config, password: generatePassword() } } as Capability);
                        return ok(`generated and stored a strong password for "${account}" — focus the site's password field and call type_credential to enter it`);
                    },
                ),
                tool(
                    "mark_connected",
                    "Mark a browser account as connected, AFTER you verified the sign-in landed (you are on the site signed in as the account — not on a login page). This is what flips the capability from pending to active, so future turns get its browser already authenticated.",
                    { account: z.string().describe("The browser account (capability id) that is now signed in") },
                    async ({ account }) => {
                        const capability = await browserAccount(deps, account);
                        if (capability === undefined) {
                            return fail(NO_ACCOUNT(account));
                        }
                        await markConnected(deps.root, account);
                        return ok(`"${account}" is marked connected — its browser opens signed in from now on`);
                    },
                ),
                ...(deps.attended
                    ? [
                          tool(
                              "request_help",
                              "Ask the owner to step into this account's live browser and clear something only a person can (a captcha, a password you don't hold, a phone check). Your browser stays open; the owner sees your message on the Browsers view, takes control, fixes that step, and hands back — this call waits for them and returns how it ended. Say precisely what you need done.",
                              {
                                  account: z.string().describe("The browser account (capability id) whose page needs the owner"),
                                  message: z.string().min(1).describe("What you need the owner to do, in one or two sentences"),
                              },
                              async ({ account, message }) => {
                                  if ((await browserAccount(deps, account)) === undefined) {
                                      return fail(NO_ACCOUNT(account));
                                  }
                                  const { id, wait } = createRequest(
                                      "browser_help",
                                      { kind: "browser_help", requestId: "", helped: false, note: "the turn ended before anyone could help" },
                                      deps.conversationId,
                                  );
                                  const session = raiseBrowserHelp(account, { requestId: id, message, requestedAt: Date.now() });
                                  if (session === undefined) {
                                      // Settle the just-parked waiter so nothing holds its id, then say why.
                                      resolveRequest({ kind: "browser_help", requestId: id, helped: false });
                                      return fail(`"${account}" has no live browser to take control of — open the page you are stuck on first`);
                                  }
                                  push({ kind: "browser_help", requestId: id, session, account, message });
                                  const { reply, resolved } = await wait(signal);
                                  clearBrowserHelp(id);
                                  push(resolved);
                                  const note = reply.note === undefined || reply.note === "" ? "" : ` They say: ${reply.note}`;
                                  return ok(
                                      reply.helped
                                          ? `The owner stepped in and is done — re-check the page state before continuing.${note}`
                                          : `The owner could not help right now — note where you are stuck and continue with what you can.${note}`,
                                  );
                              },
                          ),
                      ]
                    : []),
            ],
        });
