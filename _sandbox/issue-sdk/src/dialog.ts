import type { IssueClient } from "./client.js";
import { dialogStyles } from "./styles.js";

/* THE BOX A PERSON TYPES INTO, and the only part of this SDK that renders anything.
 *
 * OPTIONAL BY CONSTRUCTION. Crash capture never touches it, and a host with its own design system calls
 * `report()` from their own form instead. What this exists for is the majority case: somebody who wants a
 * "report a problem" box on their site this afternoon and should not have to build one.
 *
 * NO LAUNCHER BUTTON, which is the deliberate difference from the Front Desk widget. A floating bubble is a
 * standing claim on a corner of somebody's page, and a bug reporter has not earned one: it is wanted when a
 * person is already annoyed, from the site's own "something went wrong" link. So the host opens it, from
 * whatever they already have, with one call.
 *
 * SHADOW DOM, for the widget's reason: the host page's stylesheet cannot reach in, and `all: initial` in
 * styles.ts stops inherited properties reaching in either. */

const TAG = "intentic-issue-dialog";

export class IssueDialogElement extends HTMLElement {
    #client?: IssueClient;
    #root: ShadowRoot;

    constructor() {
        super();
        this.#root = this.attachShadow({ mode: "open" });
    }

    open(client: IssueClient): void {
        this.#client = client;
        this.#render();
    }

    #close(): void {
        this.remove();
    }

    #render(): void {
        const client = this.#client;
        if (client === undefined) {
            return;
        }
        const { title, prompt, askEmail, accent } = client.config;
        this.#root.innerHTML = `
            <style>${dialogStyles(accent)}</style>
            <div class="backdrop" part="backdrop">
                <div class="panel" role="dialog" aria-modal="true" aria-label="${escaped(title)}">
                    <h2>${escaped(title)}</h2>
                    <p class="prompt">${escaped(prompt)}</p>
                    <label for="what">What happened</label>
                    <textarea id="what" placeholder="It did this when I…"></textarea>
                    ${askEmail ? `<label for="email">Your email (optional)</label><input id="email" type="email" autocomplete="email" />` : ""}
                    <div class="actions">
                        <span class="status" role="status"></span>
                        <button type="button" class="cancel">Cancel</button>
                        <button type="button" class="send">Send</button>
                    </div>
                </div>
            </div>`;

        const what = this.#pick<HTMLTextAreaElement>("#what");
        const email = this.#pick<HTMLInputElement>("#email");
        const status = this.#pick<HTMLElement>(".status");
        const sendButton = this.#pick<HTMLButtonElement>(".send");

        this.#pick<HTMLButtonElement>(".cancel")?.addEventListener("click", () => this.#close());
        // Escape closes, the one keyboard affordance a modal cannot do without. Bound on the element rather than
        // the document so a page with its own key handling is not fighting us for the key.
        this.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                this.#close();
            }
        });
        // Focus the box, not the dialog: whoever opened this came here to type.
        what?.focus();

        sendButton?.addEventListener("click", () => {
            const description = what?.value.trim() ?? "";
            if (description === "") {
                what?.focus();
                return;
            }
            /* Disabled for the whole send, because the anti-bot puzzle takes about a second and an enabled
             * button during it is a double-send. The status line says what is happening, since a second of
             * nothing on a button somebody just pressed reads as broken. */
            sendButton.disabled = true;
            if (status !== undefined && status !== null) {
                status.textContent = client.config.antiBot === "pow" ? "Checking…" : "Sending…";
            }
            void client
                .report({ description, ...(email?.value.trim() ? { email: email.value.trim() } : {}) })
                /* The SAME wording whether it landed or not, and the reason is worth stating: `report` resolves
                 * to undefined for a refusal, an offline browser or a sandbox that is asleep, and none of those
                 * is something the person typing can do anything about. Telling them their report failed would
                 * ask them to retype it into the same broken pipe. The site owner learns about it from the
                 * install panel, which is where that news belongs. */
                .then(() => this.#thanks(client.config.thanks));
        });
    }

    #thanks(message: string): void {
        const panel = this.#root.querySelector(".panel");
        if (panel !== null) {
            panel.innerHTML = `<p class="done">${escaped(message)}</p>`;
        }
        setTimeout(() => this.#close(), 2200);
    }

    #pick<T extends Element>(selector: string): T | undefined {
        return this.#root.querySelector<T>(selector) ?? undefined;
    }
}

/* Everything interpolated above is either the owner's own configured text or something a person just typed into
 * this box. Neither is trusted with markup: the config travels through a daemon a site owner controls, and the
 * typed value is a stranger's, so both go through here. Attribute-safe as well as text-safe, since `title` is
 * interpolated into aria-label. */
const escaped = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// Opens the dialog, defining the element on first use. Idempotent: a second call while one is open focuses the
// one that is there rather than stacking a second modal on top of it.
export const openDialog = (client: IssueClient): void => {
    if (customElements.get(TAG) === undefined) {
        customElements.define(TAG, IssueDialogElement);
    }
    const existing = document.querySelector(TAG);
    if (existing !== null) {
        (existing as HTMLElement).focus();
        return;
    }
    const element = document.createElement(TAG) as IssueDialogElement;
    // Focusable so the Escape handler above has somewhere to be heard from.
    element.tabIndex = -1;
    document.body.append(element);
    element.open(client);
};
