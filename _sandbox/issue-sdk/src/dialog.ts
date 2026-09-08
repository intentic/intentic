import type { IssueClient } from "./client.js";
import { dialogStyles } from "./styles.js";

// The only part of this SDK that renders anything, and optional: crash capture never touches it, and a host can call
// `report()` directly from its own UI instead. No launcher button, unlike the Front Desk widget: the host opens it from
// its own link. Shadow DOM keeps the host page's styles out and this widget's styles from leaking in.

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
        // Escape closes; bound on the element, not the document, so the page's own key handling doesn't fight it.
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
            // Disabled for the whole send: the anti-bot puzzle takes about a second, and the status line says why.
            sendButton.disabled = true;
            if (status !== undefined && status !== null) {
                status.textContent = client.config.antiBot === "pow" ? "Checking…" : "Sending…";
            }
            void client
                .report({ description, ...(email?.value.trim() ? { email: email.value.trim() } : {}) })
                // Same thanks either way: a resolved failure isn't the person's to fix; the owner sees it in the
                // install panel.
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

// Neither the config text nor what a person typed is trusted with markup; escaped for both text and attributes, since
// `title` lands in aria-label too.
const escaped = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// Opens the dialog, defining the element on first use; idempotent, so a second call focuses the existing dialog instead
// of stacking another one.
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
    // Focusable, so the Escape handler above has somewhere to be heard from.
    element.tabIndex = -1;
    document.body.append(element);
    element.open(client);
};
