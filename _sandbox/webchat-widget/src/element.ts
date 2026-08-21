import type { WebchatMessage, WebchatPublicConfig } from "@intentic/sandbox-contract";
import { solveProofOfWork, solveTurnstile } from "./challenge.js";
import { renderGoogleSignIn, resetConversation, storeDisplayName, storedDisplayName, visitorConversationId } from "./identity.js";
import { styles } from "./styles.js";
import { type Endpoint, fetchChallenge, sendMessage, WebchatError } from "./transport.js";

/* <intentic-front-desk>, the whole visible widget: a launcher in a corner, and a panel holding the thread.
 *
 * Everything renders into a shadow root so the host page's CSS cannot reach it and ours cannot leak out. The
 * ONE exception is the gate area (Google's sign-in button, Turnstile's checkbox): those are third-party iframes
 * that expect a document-connected container, so they are created in the LIGHT DOM as children of this element
 * and projected back into the panel through a <slot>. They render where they look like they belong, without
 * either of them having to work inside a shadow root. */

const LAUNCHER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const RESET_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;
const SEND_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`;

// How much client-held transcript rides the FIRST message of a thread. After that the sandbox conversation
// resumes and carries its own context, so this only matters when a visitor returns to a thread the daemon has
// since expired.
const HISTORY_MAX = 20;

// Where the "powered by" link goes. The widget is often the only Intentic surface a visitor ever sees.
const INTENTIC_URL = "https://intentic.dev";

interface Turn {
    readonly author: "visitor" | "agent";
    text: string;
}

export class FrontDeskElement extends HTMLElement {
    // Assigned in connectedCallback, which the host calls immediately after `open()` sets these.
    private config!: WebchatPublicConfig;
    private endpoint!: Endpoint;

    private root!: ShadowRoot;
    private panel!: HTMLElement;
    private launcher!: HTMLButtonElement;
    private log!: HTMLElement;
    private composer!: HTMLTextAreaElement;
    private sendButton!: HTMLButtonElement;
    private gate!: HTMLElement;
    private gateNote!: HTMLParagraphElement;
    // The light-DOM host for third-party frames, slotted into `gate`.
    private gateSlotTarget!: HTMLElement;

    private turns: Turn[] = [];
    private conversationId = "";
    private displayName: string | undefined;
    private idToken: string | undefined;
    // The anti-bot answer, held until the first message spends it.
    private antiBotToken: { kind: "turnstile" | "pow"; value: string } | undefined;
    private open = false;
    private sending = false;

    configure(config: WebchatPublicConfig, endpoint: Endpoint): void {
        this.config = config;
        this.endpoint = endpoint;
    }

    connectedCallback(): void {
        this.conversationId = visitorConversationId(this.config.automationId);
        this.displayName = storedDisplayName(this.config.automationId);
        this.root = this.attachShadow({ mode: "open" });
        this.root.innerHTML = this.template();
        this.bind();
    }

    private template(): string {
        return `
<style>${styles(this.config)}</style>
<button class="launcher" part="launcher" aria-haspopup="dialog" aria-expanded="false" aria-label="${escapeAttribute(`Open ${this.config.title}`)}">
    ${LAUNCHER_ICON}
</button>
<div class="panel" role="dialog" aria-modal="false" aria-label="${escapeAttribute(this.config.title)}" hidden>
    <div class="header">
        <span class="title">${escapeHtml(this.config.title)}</span>
        <button class="icon-button reset" aria-label="Start a new chat" title="Start a new chat">${RESET_ICON}</button>
        <button class="icon-button close" aria-label="Close chat">${CLOSE_ICON}</button>
    </div>
    <div class="log" role="log" aria-live="polite"></div>
    <div class="gate" hidden>
        <p class="gate-note"></p>
        <slot name="gate"></slot>
    </div>
    <div class="composer">
        <!-- The shell is what takes focus and draws the edge, so the textarea inside it is bare (see .composer-shell). -->
        <div class="composer-shell">
            <textarea rows="1" placeholder="Write a message…" aria-label="Message"></textarea>
            <button class="send" aria-label="Send message" disabled>${SEND_ICON}</button>
        </div>
    </div>
    <div class="footer"><a href="${INTENTIC_URL}" target="_blank" rel="noopener">Powered by Intentic</a></div>
</div>`;
    }

    private bind(): void {
        const query = <T extends Element>(selector: string): T => this.root.querySelector<T>(selector) as T;
        this.launcher = query<HTMLButtonElement>(".launcher");
        this.panel = query<HTMLElement>(".panel");
        this.log = query<HTMLElement>(".log");
        this.composer = query<HTMLTextAreaElement>("textarea");
        this.sendButton = query<HTMLButtonElement>(".send");
        this.gate = query<HTMLElement>(".gate");
        this.gateNote = query<HTMLParagraphElement>(".gate-note");

        this.gateSlotTarget = document.createElement("div");
        this.gateSlotTarget.slot = "gate";
        this.append(this.gateSlotTarget);

        this.launcher.addEventListener("click", () => this.toggle());
        query<HTMLButtonElement>(".close").addEventListener("click", () => this.toggle(false));
        query<HTMLButtonElement>(".reset").addEventListener("click", () => this.startNewThread());
        this.sendButton.addEventListener("click", () => void this.submit());
        this.composer.addEventListener("input", () => {
            this.autoGrow();
            this.refreshSendState();
        });
        this.composer.addEventListener("keydown", (event) => {
            // Enter sends, Shift+Enter breaks the line, the convention every chat on the web shares.
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void this.submit();
            }
        });
        // Escape closes from anywhere inside the panel, matching every other dialog on the page.
        this.panel.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                this.toggle(false);
            }
        });
    }

    private toggle(next = !this.open): void {
        this.open = next;
        this.panel.hidden = !next;
        this.launcher.setAttribute("aria-expanded", String(next));
        if (!next) {
            return;
        }
        if (this.turns.length === 0 && this.config.greeting !== "") {
            this.appendTurn("agent", this.config.greeting);
        }
        void this.openGates();
        this.composer.focus();
    }

    /* The two things that can stand between a visitor and the composer, resolved in the order they make sense:
     * sign in (who are you), then the bot check (are you a person). Each renders into the slotted light-DOM
     * container and, once satisfied, hands back a token the first message spends. */
    private async openGates(): Promise<void> {
        if (this.config.access === "google" && this.idToken === undefined) {
            if (this.config.googleClientId === undefined) {
                this.showGate("This chat requires sign-in, but the site hasn't finished setting it up.");
                this.refreshSendState();
                return;
            }
            this.showGate("Sign in to start the chat.");
            this.refreshSendState();
            try {
                const { idToken } = await renderGoogleSignIn(this.gateSlotTarget, this.config.googleClientId);
                this.idToken = idToken;
            } catch (error) {
                this.showGate(messageOf(error));
                return;
            }
        }
        if (this.config.antiBot !== "off" && this.antiBotToken === undefined) {
            try {
                await this.solveAntiBot();
            } catch (error) {
                this.showGate(messageOf(error));
                return;
            }
        }
        this.hideGate();
        this.refreshSendState();
        this.composer.focus();
    }

    private async solveAntiBot(): Promise<void> {
        if (this.config.antiBot === "turnstile") {
            if (this.config.turnstileSiteKey === undefined) {
                throw new Error("This chat's bot check isn't finished being set up.");
            }
            this.showGate("One quick check before we start.");
            this.antiBotToken = { kind: "turnstile", value: await solveTurnstile(this.gateSlotTarget, this.config.turnstileSiteKey) };
            return;
        }
        this.showGate("Checking your browser…");
        const challenge = await fetchChallenge(this.endpoint, this.conversationId);
        this.antiBotToken = { kind: "pow", value: await solveProofOfWork(challenge) };
    }

    private showGate(note: string): void {
        this.gateNote.textContent = note;
        this.gate.hidden = false;
    }

    private hideGate(): void {
        this.gate.hidden = true;
        this.gateSlotTarget.replaceChildren();
    }

    private startNewThread(): void {
        this.conversationId = resetConversation(this.config.automationId);
        this.turns = [];
        this.log.replaceChildren();
        if (this.config.greeting !== "") {
            this.appendTurn("agent", this.config.greeting);
        }
        this.composer.focus();
    }

    private autoGrow(): void {
        this.composer.style.height = "auto";
        this.composer.style.height = `${this.composer.scrollHeight}px`;
    }

    private gatesSatisfied(): boolean {
        const signedIn = this.config.access !== "google" || this.idToken !== undefined;
        return signedIn && (this.config.antiBot === "off" || this.antiBotToken !== undefined);
    }

    private refreshSendState(): void {
        const ready = this.gatesSatisfied() && !this.sending;
        this.composer.disabled = !ready;
        this.sendButton.disabled = !ready || this.composer.value.trim() === "";
    }

    private appendTurn(author: Turn["author"], text: string): HTMLElement {
        const turn: Turn = { author, text };
        this.turns.push(turn);
        const node = document.createElement("div");
        node.className = `msg ${author}`;
        node.textContent = text;
        this.log.append(node);
        this.scrollToEnd();
        return node;
    }

    private notice(text: string, kind: "notice" | "failed"): void {
        const node = document.createElement("div");
        node.className = `msg ${kind}`;
        node.textContent = text;
        this.log.append(node);
        this.scrollToEnd();
    }

    private scrollToEnd(): void {
        this.log.scrollTop = this.log.scrollHeight;
    }

    /* Ask for a name once, inline, before the first message goes out, a modal would be a bigger interruption
     * than the question deserves, and the answer is cosmetic anyway. */
    private captureName(): void {
        if (!this.config.requireName || this.displayName !== undefined) {
            return;
        }
        const typed = window.prompt("What's your name?")?.trim();
        if (typed !== undefined && typed !== "") {
            this.displayName = typed;
            storeDisplayName(this.config.automationId, typed);
        }
    }

    private async submit(): Promise<void> {
        const content = this.composer.value.trim();
        if (content === "" || this.sending || !this.gatesSatisfied()) {
            return;
        }
        this.captureName();
        this.sending = true;
        this.composer.value = "";
        this.autoGrow();
        this.refreshSendState();
        this.appendTurn("visitor", content);

        // A placeholder that becomes the agent's bubble on the first delta, so the panel shows something is
        // happening from the moment the message leaves.
        const bubble = document.createElement("div");
        bubble.className = "msg agent";
        bubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
        this.log.append(bubble);
        this.scrollToEnd();
        const reply: Turn = { author: "agent", text: "" };

        const message: WebchatMessage = {
            conversationId: this.conversationId,
            content,
            ...(this.displayName !== undefined ? { displayName: this.displayName } : {}),
            ...(this.idToken !== undefined ? { idToken: this.idToken } : {}),
            ...(this.antiBotToken?.kind === "turnstile" ? { turnstileToken: this.antiBotToken.value } : {}),
            ...(this.antiBotToken?.kind === "pow" ? { powNonce: this.antiBotToken.value } : {}),
            // Only the first message of a thread carries client-held history; after that the conversation resumes.
            ...(this.turns.length <= 2 ? {} : { history: this.recentHistory() }),
        };

        try {
            await sendMessage(this.endpoint, message, {
                delta: (text) => {
                    reply.text += text;
                    bubble.textContent = reply.text;
                    this.scrollToEnd();
                },
                pending: (notice) => {
                    bubble.remove();
                    this.notice(notice, "notice");
                },
                // The turn answered with nothing. Said out loud, in the same place a transport failure is said,
                // silently dropping the bubble (which is what happened before there was a frame for this) leaves
                // the visitor staring at their own message wondering whether it sent.
                failed: (notice) => {
                    bubble.remove();
                    this.notice(notice, "failed");
                },
            });
            if (reply.text === "") {
                bubble.remove();
            } else {
                this.turns.push(reply);
            }
        } catch (error) {
            bubble.remove();
            this.notice(messageOf(error), "failed");
            // A spent challenge can't be replayed: make the visitor re-clear the gate rather than letting every
            // retry fail the same way.
            if (error instanceof WebchatError && error.status === 403) {
                this.antiBotToken = undefined;
                void this.openGates();
            }
        } finally {
            this.sending = false;
            this.refreshSendState();
            this.composer.focus();
        }
    }

    private recentHistory(): WebchatMessage["history"] {
        // The visitor's own turns are attributed when they gave a name; the agent's need no author (the daemon
        // knows who wrote them), so an entry is either two fields or one.
        return this.turns.slice(-HISTORY_MAX).map((turn) => {
            if (turn.author === "visitor" && this.displayName !== undefined) {
                return { author: this.displayName, content: turn.text };
            }
            return { content: turn.text };
        });
    }
}

const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const escapeAttribute = escapeHtml;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong, please try again.");
