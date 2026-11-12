// A stand-in for chatgpt.com's page, for the kit's tests: shaped after a real snapshot of it (site.ts says which parts
// were seen and which are guesses), and behaving the way the kit has to cope with. Its message box is a rich editor that
// keeps its own model and ignores text written straight into the DOM, as ProseMirror does; its menu opens on
// pointerdown, as Radix's does; and sending adds the prompt's turn, a Stop button, and later the answer.

export type Reply =
    | { readonly kind: "image"; readonly src: string; readonly text?: string }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "alert"; readonly text: string }
    | { readonly kind: "never" };

export interface FakeOptions {
    // How the browser's own insertText behaves: as Chrome's (raising beforeinput), or missing.
    readonly execCommand?: "chrome" | "missing";
    // The Personalized button keeps its label after a choice, so only the menu's checked radio tells.
    readonly staticLabel?: boolean;
    // A page without the temporary chat's menu.
    readonly noPersonalization?: boolean;
    readonly signedOut?: boolean;
    // What ChatGPT answers each prompt, in order, and after how long.
    readonly replies?: Reply[];
    readonly replyAfterMs?: number;
    // Told when a send moves the page to the chat's own address, as ChatGPT does on its first message.
    readonly onRoute?: (path: string) => void;
    // Sends are ignored, as if the button were broken.
    readonly deaf?: boolean;
    // A "Thinking" label left on the page outside any turn, which says nothing about the answer being waited on.
    readonly leftoverThinking?: boolean;
    // The answer shows its picture but keeps its "Creating image" line after the Stop button has gone.
    readonly lingeringWork?: boolean;
}

export interface FakeChatgpt {
    readonly sent: string[];
    personalization: "personalized" | "unpersonalized";
    readonly composer: HTMLElement;
    // Text written straight into the box, as a bare `textContent =` would, which the editor's model never sees.
    readonly editorText: () => string;
}

export const CHAT_ID = "6731f0c2-4b1e-8000-9a2c-1f2e3d4c5b6a";

const el = (tag: string, attributes: Record<string, string> = {}, text = ""): HTMLElement => {
    const made = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        made.setAttribute(name, value);
    }
    made.textContent = text;
    return made;
};

export const mountFakeChatgpt = (options: FakeOptions = {}): FakeChatgpt => {
    document.body.innerHTML = "";
    const replies = [...(options.replies ?? [])];
    let model = "";
    let routed = false;
    const fake: FakeChatgpt = { sent: [], personalization: "personalized", composer: el("div"), editorText: () => model };

    const header = el("header");
    const personalized = el("button", { "aria-haspopup": "menu" }, "Personalized");
    header.append(personalized, el("button", {}, "Turn off temporary chat"));
    if (options.signedOut === true) {
        header.append(el("button", {}, "Log in"), el("button", {}, "Sign up for free"));
    }
    const main = el("main");
    main.append(el("h1", {}, "Temporary chat"), el("p", {}, "This chat can reference memory, plugins, and custom instructions, but it won't appear in your history."));
    const conversation = el("div", { role: "region", "aria-label": "Conversation" });
    const form = el("form");
    const composer = el("div", { contenteditable: "true", "aria-label": "Ask ChatGPT", id: "prompt-textarea" });
    const send = el("button", { type: "button", "aria-label": "Send", disabled: "" });
    form.append(el("button", { "aria-label": "Add files and more" }), composer, el("button", { "aria-label": "Select ChatGPT model" }), send);
    main.append(conversation, form);
    if (options.leftoverThinking === true) {
        main.append(el("p", {}, "Thinking"));
    }
    document.body.append(header, main);
    if (options.noPersonalization === true) {
        personalized.remove();
    }
    Object.assign(fake, { composer });

    // The editor: its model changes only through the events a person's typing raises, and the DOM is drawn from it.
    const render = (): void => {
        composer.innerHTML = model === "" ? `<p><br></p>` : `<p>${model}</p>`;
        send.toggleAttribute("disabled", model === "");
    };
    composer.addEventListener("beforeinput", (event) => {
        if (event instanceof InputEvent && event.inputType === "insertText") {
            event.preventDefault();
            model = event.data ?? "";
            render();
        }
    });
    composer.addEventListener("paste", (event) => {
        if (event instanceof ClipboardEvent) {
            event.preventDefault();
            model = event.clipboardData?.getData("text/plain") ?? "";
            render();
        }
    });
    Object.defineProperty(document, "execCommand", {
        configurable: true,
        value:
            options.execCommand === "missing"
                ? undefined
                : (command: string, _ui: boolean, value: string): boolean => {
                      const target = document.activeElement;
                      if (command !== "insertText" || target === null) {
                          return false;
                      }
                      target.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true, cancelable: true }));
                      return true;
                  },
    });
    render();

    // The Personalized menu: open on pointerdown, choose on click, closed by the choice or Escape.
    let menu: HTMLElement | undefined;
    const closeMenu = (): void => {
        menu?.remove();
        menu = undefined;
    };
    const item = (label: string, value: "personalized" | "unpersonalized", detail: string): HTMLElement => {
        const radio = el("div", { role: "menuitemradio", "aria-checked": String(fake.personalization === value) }, `${label} ${detail}`);
        radio.addEventListener("click", () => {
            fake.personalization = value;
            if (options.staticLabel !== true) {
                personalized.textContent = label;
            }
            closeMenu();
        });
        return radio;
    };
    personalized.addEventListener("pointerdown", () => {
        if (menu !== undefined) {
            closeMenu();
            return;
        }
        menu = el("div", { role: "menu", "aria-label": "Personalized" });
        menu.append(
            item("Personalized", "personalized", "This chat can reference plugins and custom instructions"),
            item("Unpersonalized", "unpersonalized", "This chat will ignore plugins and custom instructions"),
        );
        document.body.append(menu);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeMenu();
        }
    });

    // Sending: the prompt's own turn, the page's move to the chat's address, a Stop button, and the reply later.
    // seen: "Thinking" on the page while it works, gone once it has answered; here it sits in the answer's own turn.
    const answer = (reply: Reply, stop: HTMLElement, assistant: HTMLElement, thinking: HTMLElement): void => {
        if (reply.kind === "never") {
            return;
        }
        stop.remove();
        if (options.lingeringWork === true) {
            thinking.textContent = "Creating image";
        } else {
            thinking.remove();
        }
        if (reply.kind === "alert") {
            document.body.append(el("div", { role: "alert" }, reply.text));
            return;
        }
        if (reply.kind === "image") {
            const frame = el("div");
            const button = el("button", { "aria-label": "Generated image 1" });
            button.append(el("img", { alt: "Generated image", src: reply.src, width: "1672", height: "941" }));
            frame.append(button, el("button", { "aria-label": "Edit generated image 1" }), el("button", { "aria-label": "Copy image" }));
            assistant.append(frame);
        }
        if (reply.text !== undefined) {
            assistant.append(el("p", {}, reply.text));
        }
        document.body.append(el("div", { role: "status" }, "Response complete"));
    };
    const submit = (): void => {
        if (options.deaf === true || model === "") {
            return;
        }
        fake.sent.push(model);
        const article = el("article");
        article.append(el("div", { "data-message-author-role": "user" }, model));
        conversation.append(article);
        model = "";
        render();
        if (!routed) {
            routed = true;
            options.onRoute?.(`/c/${CHAT_ID}`);
        }
        const stop = el("button", { "aria-label": "Stop streaming" });
        form.append(stop);
        const assistant = el("div", { "data-message-author-role": "assistant" });
        const thinking = el("p", {}, "Thinking");
        assistant.append(thinking);
        const answering = el("article");
        answering.append(assistant);
        conversation.append(answering);
        const reply = replies.shift() ?? { kind: "never" };
        setTimeout(() => answer(reply, stop, assistant, thinking), options.replyAfterMs ?? 40);
    };
    send.addEventListener("click", submit);
    composer.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            submit();
        }
    });
    return fake;
};

// jsdom lays nothing out; every element gets a box, so the kit's visibility test keeps them.
export const giveEveryElementABox = (): void => {
    Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
};
