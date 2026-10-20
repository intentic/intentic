import { WEBEXT_TICKET_TTL_MS, WebExtSecretAnswerSchema, webextSecretUrl } from "@intentic/sandbox-contract/webext";
import { pinFocusedField, typeSecretInto } from "../../page/driver.js";
import { askConfirm } from "../../page/overlay.js";
import { needsConfirm, RefusedError } from "../policy.js";
import { store } from "../store.js";
import { announce, inject } from "./page.js";
import { targetTab } from "./tab-access.js";

// A stored secret typed into the field in focus, for the sandbox's own `type_secret` aimed at this browser. The call
// carries a ticket and nothing else; the value is collected here, over this extension's own HTTPS request to the sandbox
// (as lend.ts collects a session), so it never rides the socket, whose answers a model reads. What goes back over the
// socket is where it was typed (host, and whether the field was a password), never the value, the page or a snapshot.
// The site guards are the ones every acting tool passes; whether the secret may go to this host at all is the
// sandbox's question, asked when the ticket is presented with the page's address.

// The person's own question, when their switches ask before every action, has to be answered while the ticket can
// still be collected; the rest of its minute is the round trip's.
const CONFIRM_TIMEOUT_MS = WEBEXT_TICKET_TTL_MS - 15_000;

export interface TicketTyped {
    readonly host: string;
    readonly field: "password" | "text";
}

// Collects the value for `ticket` from the paired sandbox, or throws the sentence why not: the sandbox's own refusal
// when it gave one.
const collect = async (ticket: string, url: string, field: TicketTyped["field"]): Promise<string> => {
    const sandbox = await store.sandbox();
    if (sandbox === undefined) {
        throw new RefusedError(`This browser is not paired with a sandbox any more.`);
    }
    const response = await fetch(webextSecretUrl(sandbox.url), {
        method: "POST",
        headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ticket, url, field }),
    }).catch(() => {
        throw new RefusedError(`This browser could not reach the sandbox to collect the secret, so nothing was typed.`);
    });
    // allow(silent-catch): a body that is not JSON is the unreadable answer refused just below, with its status
    const answer = WebExtSecretAnswerSchema.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) {
        throw new RefusedError(`The sandbox did not hand the secret over (${response.status}), so nothing was typed.`);
    }
    if (!answer.data.ok) {
        throw new RefusedError(answer.data.message);
    }
    return answer.data.value;
};

export const typeTicket = async (ticket: string): Promise<TicketTyped> => {
    const tab = await targetTab("act");
    const { origin, host } = new URL(tab.url);
    const pin = crypto.randomUUID();
    const focused = await inject(tab.id, pinFocusedField, [pin]);
    if (!focused.ok) {
        throw new RefusedError(focused.message);
    }
    if (needsConfirm(await store.scopes(), false)) {
        const what = focused.field === "password" ? "this password field" : "this field";
        if (!(await inject(tab.id, askConfirm, [`Your agent wants to type a stored secret into ${what}. Allow it?`, CONFIRM_TIMEOUT_MS]))) {
            throw new RefusedError(`The person said no (or did not answer) to typing a secret into ${what}. Do not try another way round it; ask them what they would prefer.`);
        }
    }
    const value = await collect(ticket, tab.url, focused.field);
    // Asked again now the value is here: the release may have waited minutes on a person, and the tab could have been
    // paused, narrowed to reading, or moved to another site in that time.
    const now = await targetTab("act", tab.id);
    if (new URL(now.url).origin !== origin) {
        throw new RefusedError(`The page moved to another site while the secret was being released, so nothing was typed.`);
    }
    // Chrome's own words for a failed injection are not passed on: nothing that could quote its arguments may reach a
    // tool answer or the activity list.
    const typed = await inject(tab.id, typeSecretInto, [pin, value, origin]).catch(() => {
        throw new RefusedError(`The page did not take the secret (it may have navigated mid-call), so nothing was typed.`);
    });
    if (!typed.ok) {
        throw new RefusedError(typed.message);
    }
    announce(tab.id, `The agent typed a stored secret into this field`);
    return { host, field: focused.field };
};
