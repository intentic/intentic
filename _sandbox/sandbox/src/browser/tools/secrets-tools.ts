import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../../engines/claude-sdk.js";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { DesktopTypist } from "../../desktop/desktop-secret-typing.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import { secretReference } from "../../secrets/secret-registry.js";
import type { SecretTickets } from "../../webext/secret-tickets.js";
import { browserAccountPage } from "../sessions/browser-sessions.js";
import { focusedEditable } from "./accounts-tools.js";
import {
    type KeyringTyping,
    notTypeable,
    resolveTypeable,
    TYPE_SECRET_TOOL,
    type TypeableSecret,
    typeInOwnerBrowser,
    typeOnDesktop,
    typeOnDevice,
    valueForUse,
} from "./secret-typing.js";

// Types a stored secret where it is needed without it entering the model's context, widened from type_credential: a
// focused field on a sandbox browser's page, the focused window on one of the owner's computers or an app on a phone
// attached to one (secret-typing.ts), a window on the sandbox's own desktop, a page in the owner's own browser. Each
// place is offered only where this turn reaches it. Where the value went is recorded on the use ledger, so which secret
// went where is answered by the Secrets view.

export { typeableSecret } from "./secret-typing.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export interface SecretsToolsDeps {
    readonly secrets: SecretAccess;
    // Browsers this turn holds, the account-to-owner map the router enforces; scopes where a value can land.
    readonly accounts: Record<string, string>;
    // The owner's computers this turn has mounted (device cards), each a place to type into through its keyring.
    readonly devices?: readonly string[];
    // The keyrings behind them; absent where no daemon stands behind the tool (a test, a bare runtime).
    readonly keyrings?: KeyringTyping;
    // The sandbox's desktop, when this turn has it.
    readonly desktop?: DesktopTypist;
    // The owner's own browsers this turn has mounted (webext cards), and the ticket door their extension redeems at.
    readonly ownBrowsers?: readonly string[];
    readonly tickets?: Pick<SecretTickets, "typeIn">;
    readonly conversationId?: string;
    readonly signal?: AbortSignal;
}

const PAGE = "page";
const DESKTOP = "desktop";

// The places this turn may type into, in the words of the `where` field.
const placesOf = (deps: SecretsToolsDeps): readonly string[] => [
    ...(Object.keys(deps.accounts).length > 0 ? [`"${PAGE}" (a sandbox browser's page, with \`browser\`)`] : []),
    ...(deps.desktop === undefined ? [] : [`"${DESKTOP}" (the sandbox's own desktop)`]),
    ...(deps.keyrings === undefined ? [] : (deps.devices ?? []).map((id) => `"${id}" (the focused window on that computer, or with \`phone\` an app on a phone attached to it)`)),
    ...(deps.tickets === undefined ? [] : (deps.ownBrowsers ?? []).map((id) => `"${id}" (the focused field of the active tab in the owner's own browser)`)),
];

const descriptionOf = (deps: SecretsToolsDeps): string =>
    "Type a stored secret where it is needed: the FOCUSED field or window of the place you name. You never see the value, and nothing you can read " +
    "afterwards shows it: put the cursor in the field with that place's own tools first, then call this with the secret's name (the same name " +
    "`{{secret:name}}` masking shows you). What comes back is where it went (the program or site, whether the field was a password field, whether " +
    "a person was asked). Typing on one of the owner's computers is done by the keyring there, which checks the window against the secret's list " +
    "of programs and may ask the person at that computer. Only user-kept secrets are typeable; an account's own password stays with " +
    `type_credential. Places this turn reaches: ${placesOf(deps).join("; ")}.`;

// A sandbox browser's page: the one place the value is typed from this process, through the page's own keyboard.
const typeOnPage = async (deps: SecretsToolsDeps, secret: TypeableSecret, browser: string | undefined) => {
    const owner = deps.accounts[browser ?? "web"];
    if (owner === undefined) {
        return fail(`no browser "${browser ?? "web"}" this turn drives: \`browser\` is "web" or one of the account ids whose tools you hold`);
    }
    const page = browserAccountPage(owner);
    if (page === undefined) {
        return fail(`"${browser ?? "web"}" has no live page: open the site with the browser tools first`);
    }
    if (!(await focusedEditable(page))) {
        return fail("no text field is focused on the page: browser_click the field first, then call this again");
    }
    const host = ((): string => {
        try {
            return new URL(page.url()).host;
        } catch {
            return "the current page";
        }
    })();
    // Approval gate before the keystrokes, since a typed value can't be undone; asked with the host as destination,
    // which a host-limited secret's list is checked against.
    const released = await deps.secrets.release([secret.name], "browser", host, { kind: "page", url: page.url(), tool: TYPE_SECRET_TOOL });
    if ("refusal" in released) {
        return fail(released.refusal);
    }
    const value = await valueForUse(deps.secrets, secret, "browser", host);
    if ("refusal" in value) {
        return fail(value.refusal);
    }
    // Same human-ish cadence as type_credential; some forms listen for key events.
    await page.keyboard.type(value.value, { delay: 30 });
    const approvedBy = released.approvedBy?.[secret.name];
    deps.secrets.used({ name: secret.name, lane: "browser", detail: host, ...opt("approvedBy", approvedBy) });
    return ok(`typed ${secretReference(secret.name)} into the focused field on ${host} (value not shown)`);
};

interface TypeInput {
    readonly name: string;
    readonly where?: string | undefined;
    readonly browser?: string | undefined;
    readonly phone?: string | undefined;
    readonly why?: string | undefined;
}

const answer = (result: { readonly ok: boolean; readonly text: string }) => (result.ok ? ok(result.text) : fail(result.text));

const onDesktop = async (deps: SecretsToolsDeps, desktop: DesktopTypist, secret: TypeableSecret) => {
    try {
        return answer(await typeOnDesktop(deps.secrets, desktop, secret));
    } catch (error) {
        // The desktop's own refusal (the owner holds it) or a failed xdotool, neither of which carries the value.
        return fail(error instanceof Error ? error.message : "the sandbox's desktop did not take the keystrokes");
    }
};

const onDevice = async (deps: SecretsToolsDeps, keyrings: KeyringTyping, secret: TypeableSecret, machine: string, input: TypeInput) =>
    answer(
        await typeOnDevice(deps.secrets, keyrings, secret, {
            machine,
            ...opt("phone", input.phone),
            ...opt("why", input.why),
            ...opt("conversationId", deps.conversationId),
            ...opt("signal", deps.signal),
        }),
    );

// The place `where` names, among those this turn reaches.
const typeAt = async (deps: SecretsToolsDeps, secret: TypeableSecret, input: TypeInput, where: string) => {
    const devices = deps.devices ?? [];
    if (where === PAGE) {
        return typeOnPage(deps, secret, input.browser);
    }
    if (where === DESKTOP && deps.desktop !== undefined) {
        return onDesktop(deps, deps.desktop, secret);
    }
    if (deps.keyrings !== undefined && devices.includes(where)) {
        return onDevice(deps, deps.keyrings, secret, where, input);
    }
    if (deps.tickets !== undefined && (deps.ownBrowsers ?? []).includes(where)) {
        return answer(await typeInOwnerBrowser(deps.secrets, deps.tickets, secret, where, deps.signal));
    }
    const places = placesOf(deps);
    return fail(`"${where}" is not a place this turn can type into. It is one of: ${places.length === 0 ? "nowhere: this turn reaches no browser, desktop or computer" : places.join("; ")}`);
};

const typeSecret = async (deps: SecretsToolsDeps, input: TypeInput) => {
    const where = input.where ?? PAGE;
    let secret;
    try {
        secret = await resolveTypeable(deps.secrets, deps.keyrings, input.name);
    } catch {
        return fail("the secret store could not be read: try again");
    }
    if (secret === undefined) {
        return fail(notTypeable(input.name));
    }
    const devices = deps.devices ?? [];
    if (input.phone !== undefined && !devices.includes(where)) {
        const computers = devices.length === 0 ? "none this turn reaches" : devices.join(", ");
        return fail(`\`phone\` names a phone attached to one of the owner's computers: set \`where\` to that computer (${computers})`);
    }
    return typeAt(deps, secret, input, where);
};

export const secretsServer = (deps: SecretsToolsDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "secrets",
        tools: [
            sdk().tool(
                "type_secret",
                descriptionOf(deps),
                {
                    name: z.string().describe("The stored secret's name, e.g. GRAFANA_ADMIN_PASSWORD"),
                    where: z.string().optional().describe(`Where to type it; "${PAGE}" when left out. One of the places listed in this tool's description.`),
                    browser: z.string().optional().describe('With where "page": which browser holds the page, "web" (the default) or a browser account\'s capability id'),
                    phone: z.string().optional().describe("With where naming a computer: the adb serial of a phone attached to it, to type into the app in front there"),
                    why: z.string().max(200).optional().describe("What it is for, in a few words: shown to the person at the computer if they are asked"),
                },
                async (input) => typeSecret(deps, input),
                // A typed secret reaches the page or window, and nothing takes it back.
                { annotations: toolAnnotations("destructive") },
            ),
        ],
    });
