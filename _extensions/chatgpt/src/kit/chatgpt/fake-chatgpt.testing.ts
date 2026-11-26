// A stand-in for chatgpt.com's page, for the kit's tests: shaped after a real snapshot of it (site.ts says which parts
// were seen and which are guesses), and behaving the way the kit has to cope with. Its message box is a rich editor that
// keeps its own model and ignores text written straight into the DOM, as ProseMirror does; its menu opens on
// pointerdown, as Radix's does; and sending adds the prompt's turn, a Stop button, and later the answer.

export type Reply =
    | { readonly kind: "image"; readonly src: string; readonly text?: string }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "alert"; readonly text: string }
    // An answer that stops at one of ChatGPT's own buttons, waiting on the person, with its Stop button still up.
    | { readonly kind: "confirm"; readonly text: string; readonly button: string }
    | { readonly kind: "never" };

// What the signed-in account holds across pages: its projects. Kept by the suite, so a page loaded later sees a project
// one made earlier. All guessed (site.ts): a project's page is /g/g-p-<id>-<slug>/project.
export interface FakeProject {
    readonly id: string;
    readonly name: string;
    readonly memory: "default" | "project";
    instructions: string;
}

export interface FakeAccount {
    readonly projects: FakeProject[];
}

const projectPath = (project: Pick<FakeProject, "id" | "name">): string =>
    `/g/g-p-${project.id}-${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}/project`;

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
    // Which page this is: a temporary chat (the default, as the kit first knew ChatGPT), the home page, or a project's.
    readonly page?: "temporary" | "home" | "project";
    readonly account?: FakeAccount;
    // The project whose page this is.
    readonly project?: FakeProject | undefined;
    // Told when the page sends the browser elsewhere by itself (to a project it just made), as a navigation.
    readonly onNavigate?: (path: string) => void;
    // A home page without "New project", as an account or a redesign without it.
    readonly noNewProject?: boolean;
    // The tools menu lacks Deep research and agent mode, as a plan without them.
    readonly noTools?: boolean;
}

export interface FakeChatgpt {
    readonly sent: string[];
    // The names of the files put into the composer's file input.
    readonly attached: string[];
    // The tool chosen from the tools menu, if any.
    mode: string | undefined;
    // Whether anything pressed one of ChatGPT's own confirmation buttons (the kit must never).
    confirmed: boolean;
    personalization: "personalized" | "unpersonalized";
    readonly composer: HTMLElement;
    // Text written straight into the box, as a bare `textContent =` would, which the editor's model never sees.
    readonly editorText: () => string;
}

// Which stand-in a browser shows at `url`: the page of the kind the address names, or undefined for an address that
// loads nothing new. A chat's own address (/c/…) keeps the page as it was, as ChatGPT's client-side route does.
export const fakePageAt = (url: string, account: FakeAccount): Pick<FakeOptions, "page" | "project"> | undefined => {
    const at = new URL(url);
    if (at.host !== "chatgpt.com" || at.pathname.includes("/c/")) {
        return undefined;
    }
    const projectId = /^\/g\/g-p-([A-Za-z0-9]+)/.exec(at.pathname)?.[1];
    const project = account.projects.find((each) => each.id === projectId);
    return { page: at.searchParams.get("temporary-chat") === "true" ? "temporary" : project !== undefined ? "project" : "home", project };
};

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
    const fake: FakeChatgpt = { sent: [], attached: [], mode: undefined, confirmed: false, personalization: "personalized", composer: el("div"), editorText: () => model };
    const kind = options.page ?? "temporary";

    const header = el("header");
    const personalized = el("button", { "aria-haspopup": "menu" }, "Personalized");
    if (kind === "temporary") {
        header.append(personalized, el("button", {}, "Turn off temporary chat"));
    }
    if (options.signedOut === true) {
        header.append(el("button", {}, "Log in"), el("button", {}, "Sign up for free"));
    }
    const main = el("main");
    if (kind === "temporary") {
        main.append(el("h1", {}, "Temporary chat"), el("p", {}, "This chat can reference memory, plugins, and custom instructions, but it won't appear in your history."));
    } else if (kind === "project" && options.project !== undefined) {
        main.append(el("h1", {}, options.project.name));
    } else {
        main.append(el("h1", {}, "What can I help with?"));
    }
    const conversation = el("div", { role: "region", "aria-label": "Conversation" });
    const form = el("form");
    const composer = el("div", { contenteditable: "true", "aria-label": "Ask ChatGPT", id: "prompt-textarea" });
    const send = el("button", { type: "button", "aria-label": "Send", disabled: "" });
    const tools = el("button", { type: "button", "aria-label": "Add files and more" });
    const fileInput = el("input", { type: "file", multiple: "" });
    form.append(tools, fileInput, composer, el("button", { "aria-label": "Select ChatGPT model" }), send);
    main.append(conversation, form);
    if (kind !== "temporary" && options.signedOut !== true) {
        document.body.append(sidebar(options));
    }
    if (kind === "project" && options.project !== undefined) {
        main.append(instructionsButton(options.project));
    }
    toolsMenu(tools, form, fake, options);
    // The input as a person's choice leaves it: `files` set, then `change`. jsdom's own setter wants a real FileList.
    let chosen: ArrayLike<File> = [];
    Object.defineProperty(fileInput, "files", {
        configurable: true,
        get: () => chosen,
        set: (files: ArrayLike<File>) => {
            chosen = files;
        },
    });
    fileInput.addEventListener("change", () => {
        fake.attached.push(...Array.from(chosen, (file) => file.name));
    });
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
        if (reply.kind === "confirm") {
            thinking.remove();
            const button = el("button", {}, reply.button);
            button.addEventListener("click", () => {
                fake.confirmed = true;
            });
            assistant.append(el("p", {}, reply.text), button);
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
            options.onRoute?.(kind === "project" && options.project !== undefined ? projectPath(options.project).replace(/\/project$/, `/c/${CHAT_ID}`) : `/c/${CHAT_ID}`);
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

// The sidebar of a signed-in page: "New project" (opening its dialog) and a link to each of the account's projects.
const sidebar = (options: FakeOptions): HTMLElement => {
    const nav = el("nav", { "aria-label": "Chat history" });
    const account = options.account ?? { projects: [] };
    if (options.noNewProject !== true) {
        const opener = el("button", {}, "New project");
        opener.addEventListener("click", () => document.body.append(newProjectDialog(account, options)));
        nav.append(opener);
    }
    for (const project of account.projects) {
        nav.append(el("a", { href: projectPath(project) }, project.name));
    }
    return nav;
};

// The new-project dialog: a name box, a settings button whose menu holds the memory choice, and "Create project",
// pressable once a name is typed. Creating sends the browser to the project's page.
const newProjectDialog = (account: FakeAccount, options: FakeOptions): HTMLElement => {
    const dialog = el("div", { role: "dialog", "aria-label": "Create project" });
    const name = el("input", { type: "text", "aria-label": "Project name" });
    const settings = el("button", { "aria-label": "Project settings" });
    const create = el("button", { disabled: "" }, "Create project");
    let memory: FakeProject["memory"] = "default";
    name.addEventListener("input", () => create.toggleAttribute("disabled", !(name instanceof HTMLInputElement) || name.value === ""));
    settings.addEventListener("pointerdown", () => {
        const menu = el("div", { role: "menu", "aria-label": "Memory" });
        const choice = (label: string, value: FakeProject["memory"]): HTMLElement => {
            const radio = el("div", { role: "menuitemradio", "aria-checked": String(memory === value) }, label);
            radio.addEventListener("click", () => {
                memory = value;
                menu.remove();
            });
            return radio;
        };
        menu.append(choice("Default", "default"), choice("Project-only", "project"));
        dialog.append(menu);
    });
    create.addEventListener("click", () => {
        const project: FakeProject = { id: `6a1b2c${account.projects.length}`, name: name instanceof HTMLInputElement ? name.value : "", memory, instructions: "" };
        account.projects.push(project);
        dialog.remove();
        options.onNavigate?.(projectPath(project));
    });
    dialog.append(name, settings, create);
    return dialog;
};

// A project's "Add instructions": a dialog with one text box and "Save".
const instructionsButton = (project: FakeProject): HTMLElement => {
    const opener = el("button", {}, "Add instructions");
    opener.addEventListener("click", () => {
        const dialog = el("div", { role: "dialog", "aria-label": "Instructions" });
        const box = el("textarea", { "aria-label": "Instructions" });
        const save = el("button", {}, "Save");
        save.addEventListener("click", () => {
            project.instructions = box instanceof HTMLTextAreaElement ? box.value : "";
            dialog.remove();
        });
        dialog.append(box, save);
        document.body.append(dialog);
    });
    return opener;
};

// The composer's tools menu, opened on pointerdown as Radix does: choosing a tool puts its pill in the composer.
const toolsMenu = (button: HTMLElement, form: HTMLElement, fake: FakeChatgpt, options: FakeOptions): void => {
    button.addEventListener("pointerdown", () => {
        const menu = el("div", { role: "menu" });
        const item = (label: string): HTMLElement => {
            const entry = el("div", { role: "menuitem" }, label);
            entry.addEventListener("click", () => {
                fake.mode = label;
                form.append(el("button", { type: "button", "aria-label": label }, label));
                menu.remove();
            });
            return entry;
        };
        menu.append(el("div", { role: "menuitem" }, "Add photos & files"));
        if (options.noTools !== true) {
            menu.append(item("Deep research"), item("Agent mode"));
        }
        document.body.append(menu);
        // Escape closes it, as a Radix menu closes.
        const close = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                menu.remove();
                document.removeEventListener("keydown", close);
            }
        };
        document.addEventListener("keydown", close);
    });
};

// jsdom lays nothing out; every element gets a box, so the kit's visibility test keeps them.
export const giveEveryElementABox = (): void => {
    Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
};
