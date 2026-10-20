import type { WebExtGrant } from "@intentic/sandbox-contract/webext";
import { siteOf } from "./policy.js";
import { store } from "./store.js";
import { refreshBadge } from "./tools/access.js";

// How a site the person allows becomes one the agent may use: Chrome's grant, plus the read/act mode the person
// picked. The popup can't be the one to file the mode after Chrome says yes, because Chrome closes the popup as soon
// as its own permission dialog takes focus (crbug.com/40721470), so nothing after the popup's
// `await chrome.permissions.request` is sure to run. Filed from there, the mode was lost whenever Chrome asked: the
// site stayed off the agent's list, the agent's request stayed unmet in the chat, and the person had to open the
// popup again and pick the mode a second time. So the popup sends its pick here first (`choose`), and the grant
// arriving files it (`granted`, from `chrome.permissions.onAdded`).

// Something the person did in the popup, in the same activity list as the agent's calls, so "why can it act on
// github.com" has its answer beside what it did there.
export const owner = async (detail: string): Promise<void> => await store.append({ at: Date.now(), tool: "owner", detail, ok: true });

// One at a time: the pick and Chrome's grant can arrive together, and the pick is spent by whichever files it first.
// A step that failed still lets the next one run (`work` is both handlers), and its error reaches its own caller.
let queue: Promise<unknown> = Promise.resolve();
const serial = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next;
    return await next;
};

// The site is Chrome's now: the mode goes on file, and the agent's request for it (if that was the one) is answered.
const file = async (origin: string, mode: WebExtGrant["mode"]): Promise<void> => {
    await store.setMode(origin, mode);
    await store.forgetDecline(origin);
    const pending = await store.pending();
    if (pending === undefined || pending.origin === origin) {
        await store.setPending(undefined);
    }
    await owner(`Allowed ${siteOf(origin)} to ${mode === "act" ? "read and act" : "read only"}`);
};

// The person picked a mode in the popup, which is asking Chrome for the site right now. Chrome may already hold it
// (Passwords' all-sites grant, a site allowed before its mode was filed): then no dialog comes and no grant is added,
// so this pick is the whole answer and files at once.
export const choose = async (origin: string, mode: WebExtGrant["mode"], now = Date.now()): Promise<void> => {
    await serial(async () => {
        await store.setChoice({ origin, mode, at: now });
        if (await chrome.permissions.contains({ origins: [origin] })) {
            await store.takeChoice(origin, now);
            await file(origin, mode);
        }
    });
    await refreshBadge();
};

// Chrome added sites. One the person just picked a mode for files with that mode. One allowed from Chrome's own
// site-access menu while the agent was waiting on it files as read only, since that menu has no read/act and the
// popup's list widens it in one click; left unfiled, Chrome would say yes while the agent's list and the chat's card
// said no. Any other (Passwords' all-sites grant, the sandbox's own origin) is not a site given to the agent.
export const granted = async (origins: readonly string[], now = Date.now()): Promise<void> => {
    await serial(async () => {
        for (const origin of origins) {
            const choice = await store.takeChoice(origin, now);
            const pending = await store.pending();
            if (choice !== undefined) {
                await file(origin, choice.mode);
            } else if (pending?.origin === origin) {
                await file(origin, "read");
            } else {
                await store.forgetDecline(origin);
            }
        }
    });
    await refreshBadge();
};
