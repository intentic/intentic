// EVERYTHING THIS KIT ASSUMES ABOUT CHATGPT'S PAGES, in one place: when ChatGPT changes its layout and the kit stops
// working, the fix is here. Elements are found the way the snapshot names them, by role and accessible name, which
// survive a restyle; class names do not. Each line says where it came from: "seen" was in a real snapshot of
// chatgpt.com (2026-11-11, Brave on Windows), "guess" was not, and is the first place to look when the kit fails.

// A regular expression as it crosses into the page: a host hands a step its arguments as JSON, which a RegExp does not
// survive.
export interface Pattern {
    readonly source: string;
    readonly flags: string;
}

const pattern = (expression: RegExp): Pattern => ({ source: expression.source, flags: expression.flags });

// An element found by role and accessible name, with a stable attribute to fall back on where ChatGPT has one.
export interface Lookup {
    readonly role: string;
    readonly name: Pattern;
    readonly testId?: string;
    readonly id?: string;
}

export interface ChatGptPage {
    // The prompt box, a ProseMirror contenteditable. seen: `textbox "Ask ChatGPT"`; the other names and the id are guesses.
    readonly composer: Lookup;
    // seen: `button "Send"`; testId guess.
    readonly send: Lookup;
    // Present while ChatGPT is still answering. guess: the button that replaces Send while it streams.
    readonly stop: Lookup;
    // The temporary chat's personalization menu. seen: `button "Personalized"` opening `menu "Personalized"` with
    // `menuitemradio "Personalized This chat can reference plugins…"` and `menuitemradio "Unpersonalized This chat will
    // ignore plugins…"`. guess: the button reads "Unpersonalized" once that is chosen; the kit also reopens the menu and
    // reads the radio's checked state, so it does not rely on the label alone.
    readonly personalization: Lookup;
    readonly personalizedItem: Lookup;
    readonly unpersonalizedItem: Lookup;
    readonly unpersonalizedLabel: Pattern;
    // One per image in the conversation. seen: `button "Generated image 1"`, beside `button "Edit generated image 1"`.
    // guess: the picture is an <img> inside that button or close above it.
    readonly generatedImage: Lookup;
    readonly generatedImageAlt: Pattern;
    // Each turn of the conversation. guess: ChatGPT marks a turn's author on an attribute; <article> is the fallback.
    readonly userTurn: string;
    readonly assistantTurn: string;
    readonly anyTurn: string;
    // A signed-out page. guess: ChatGPT's own "Log in" and "Sign up" buttons.
    readonly signIn: Lookup;
    // A line on the page while it works, matched against the whole text of one element with no children, so a word in
    // an answer's prose does not count. seen: "Thinking"; the rest are guesses.
    readonly working: Pattern;
    // What a failure says, read from the new answer and from alerts once ChatGPT has stopped. All guesses, kept broad;
    // a refusal is only judged when no image came.
    readonly limit: Pattern;
    readonly error: Pattern;
    readonly refusal: Pattern;
    // THE PROJECT a sandbox's chats live in (project.ts). seen (2026-11-14, Brave 157, a workspace account): the
    // sidebar's "Projects" section holds `button "Add new project"` and `list "No projects"` (or a link per project).
    // guess, from OpenAI's help pages: it opens a dialog with a "Project name" box, a settings (gear) button holding the
    // memory choice, and "Create project". A plain click() did not open it; the kit's pointer-sequence press is untested.
    readonly newProject: Lookup;
    readonly projectName: Lookup;
    readonly projectSettings: Lookup;
    readonly projectOnlyMemory: Lookup;
    readonly createProject: Lookup;
    // guess: a project's page offers "Add instructions" (or "Instructions"), a dialog with one text box and "Save".
    readonly projectInstructions: Lookup;
    readonly instructionsBox: Lookup;
    readonly save: Lookup;
    // THE COMPOSER'S TOOLS. seen (2026-11-14): `button "Add files and more"` beside `textbox "Ask ChatGPT"`, and a
    // `group "Composer mode"` above them with `button "Chat"` and `button "Work"`. guess: the button opens a menu whose
    // items name each tool, and a chosen tool shows as a pill button in the composer named after it.
    readonly toolsMenu: Lookup;
    readonly modes: { readonly deep_research: Pattern; readonly agent: Pattern };
    // guess: the composer's own file input, which "Add photos & files" opens.
    readonly fileInput: string;
    // guess: what ChatGPT puts in front of an answer it will not go on with until the person says so: an app about to
    // search outside the project, agent mode's sensitive step, a sign-in it hands over. The kit never presses one.
    readonly confirmation: Lookup;
}

export const CHATGPT_PAGE: ChatGptPage = {
    composer: { role: "textbox", name: pattern(/^(Ask ChatGPT|Ask anything|Message ChatGPT)/i), id: "prompt-textarea" },
    send: { role: "button", name: pattern(/^Send( prompt| message)?$/i), testId: "send-button" },
    stop: { role: "button", name: pattern(/^Stop( streaming| generating| answering)?/i), testId: "stop-button" },
    personalization: { role: "button", name: pattern(/^(Personalized|Unpersonalized)$/i) },
    personalizedItem: { role: "menuitemradio", name: pattern(/^Personalized/i) },
    unpersonalizedItem: { role: "menuitemradio", name: pattern(/^Unpersonalized/i) },
    unpersonalizedLabel: pattern(/^Unpersonalized$/i),
    generatedImage: { role: "button", name: pattern(/^Generated image \d+$/i) },
    generatedImageAlt: pattern(/generated image/i),
    userTurn: '[data-message-author-role="user"]',
    assistantTurn: '[data-message-author-role="assistant"]',
    anyTurn: "article",
    signIn: { role: "button", name: pattern(/^(Log in|Sign up( for free)?)$/i) },
    working: pattern(/^(Thinking|Creating image|Generating image|Getting started|Researching|Starting research|Searching|Working)\b/),
    limit: pattern(/(reached (?:your|the) [^.]*limit|usage (?:limit|cap)|rate limit|too many requests|limit resets|hit the (?:free )?plan limit)/i),
    error: pattern(/(something went wrong|there was an error|an error occurred|network error|error in (?:the )?message stream|unable to load conversation)/i),
    refusal: pattern(
        /(\b(?:can(?:'|’)?t|cannot|unable to|not able to|won(?:'|’)t be able to)\b[^.]{0,40}\b(?:help|create|generate|make|produce|fulfil)|content polic|violat|against (?:our|the) (?:usage )?polic)/i,
    ),
    newProject: { role: "button", name: pattern(/^(Add new project|New project)$/i), testId: "create-new-project-button" },
    projectName: { role: "textbox", name: pattern(/^(Project name|Name)/i) },
    projectSettings: { role: "button", name: pattern(/^(Project settings|Settings|Memory)/i) },
    projectOnlyMemory: { role: "menuitemradio", name: pattern(/^Project-only/i) },
    createProject: { role: "button", name: pattern(/^Create( project)?$/i) },
    projectInstructions: { role: "button", name: pattern(/^(Add instructions|Instructions)/i) },
    instructionsBox: { role: "textbox", name: pattern(/instruction/i) },
    save: { role: "button", name: pattern(/^Save$/i) },
    toolsMenu: { role: "button", name: pattern(/^(Add files and more|Add photos (&|and) files|Tools)/i), testId: "composer-plus-btn" },
    modes: { deep_research: pattern(/^Deep research/i), agent: pattern(/^Agent( mode)?/i) },
    fileInput: 'form input[type="file"]',
    confirmation: { role: "button", name: pattern(/^(Confirm|Allow|Approve|Take over|Continue)$/i) },
};

// The site's addresses, used only by the engine and its hosts.
export const CHATGPT_SITE = {
    host: "chatgpt.com",
    home: "https://chatgpt.com/",
    // seen: a temporary chat starts here, and begins personalized ("can reference memory, plugins, and custom
    // instructions") until the Personalized menu is set to Unpersonalized.
    newTemporaryChat: "https://chatgpt.com/?temporary-chat=true",
    chat: (id: string): string => `https://chatgpt.com/c/${id}`,
    // seen: a chat's address once its first message is sent. guess: a chat in a project lives under the project's own
    // path, /g/g-p-<id>-<slug>/c/<chat>, and /c/<chat> takes the browser there.
    chatPath: /^(?:\/g\/[A-Za-z0-9-]+)?\/c\/([A-Za-z0-9-]{6,80})(?:[/?#]|$)/,
    // guess: a project's page, /g/g-p-<id>-<slug>/project, whose message box starts a chat in the project.
    projectPath: /^\/g\/(g-p-[A-Za-z0-9]+)[A-Za-z0-9-]*(?:\/project|\/c\/|\/?$)/,
} as const;
