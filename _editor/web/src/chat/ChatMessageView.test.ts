// @vitest-environment jsdom
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { ERRANDS, errandPrompt } from "../composables/chat/errands";
import type { ChatMessage } from "../composables/chat/transcript";

const clock = vi.hoisted(() => ({ turnStartedAt: undefined as number | undefined }));
const roster = vi.hoisted(() => ({ running: 0 }));
/* The pane state the EDIT pencil reads. Both matter to whether it is offered at all: a chat mid-turn hides it
 * (the daemon will not move files under a running agent) and a message whose own edit is armed hides it (the
 * composer is already holding that one), so both are settable rather than baked into the stub. */
const pane = vi.hoisted(() => ({ streaming: true, editing: undefined as ChatMessage | undefined }));
const beginEdit = vi.hoisted(() => vi.fn());
// What the markdown engine hands this row for the message under test: prose runs, and the figures between them
// (see useMarkdown). Empty for every test that is not about the answer's body.
const markdown = vi.hoisted(() => ({
    parts: [] as { readonly kind: string; readonly html?: string; readonly figure?: { readonly kind: string } }[],
}));

vi.hoisted(() => {
    /* The prompt bubble watches its own box twice: a ResizeObserver for whether the clamp is doing anything, an
     * IntersectionObserver for whether it has stuck to the top of the scroller. jsdom has layout for neither.
     * Stubs that never fire leave both flags at their defaults, which is exactly what the component shows before
     * its first measurement, so a user bubble renders here as it does on screen the instant it mounts. */
    const idle = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.IntersectionObserver ??= idle as unknown as typeof globalThis.IntersectionObserver;
});

// Taken as a namespace rather than destructured: this file already imports `h` and `defineComponent` at the top,
// and a factory that names them again shadows them.
vi.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        useDevice: () => ({ mobile: vue.ref(false) }),
        // A real <button> carrying its attrs, because the card's answers are what half these assertions click.
        // The kit's own press lock has its own suite (components/pressLock.test.ts); this only needs the tag.
        Button: vue.defineComponent({
            inheritAttrs: false,
            setup:
                (_props, { attrs, slots }) =>
                () =>
                    vue.h(`button`, attrs, slots[`default`]?.()),
        }),
        /* WHICH picture a figure gets is the design system's question (MarkdownFigure, and mermaid's own parser
         * below it); what this row owns is whether a figure part reaches the bubble at all. So it stands in as a
         * marker naming the kind, rather than dragging a megabyte of diagram grammars into a jsdom transcript. */
        MarkdownFigure: vue.defineComponent({
            props: { figure: { type: Object, required: true } },
            render(): unknown {
                return vue.h(`div`, { class: `figure-stub` }, String(this.figure[`kind`]));
            },
        }),
        /* The shared card shell (ChatCard) IMPORTS its icon rather than taking the global one ChatMessageView's
         * own template uses, so this mock now has to answer for it. Rendered as `<i name>`, which is exactly
         * what the global registration renders: one shape for both, or `marks()` below would see two. */
        Icon: vue.defineComponent({
            props: { name: { type: String, required: true }, spin: Boolean },
            render(): unknown {
                return vue.h(`i`, { name: this.name });
            },
        }),
        // The command block's copy control. Its own behaviour (the clipboard, the copied state) is the design
        // system's to test; what matters here is that a card holding a program still mounts.
        CopyButton: vue.defineComponent({
            props: { text: { type: String, required: true } },
            render(): unknown {
                return vue.h(`button`, { class: `copy-stub` });
            },
        }),
        // The class recipes, as identity: this suite asserts on structure and text, never on the kit's own
        // geometry, so a recipe only has to hand back whatever the call site passed it.
        ui: { linkButton: (extra: string) => extra, textAction: (extra: string) => extra, iconButton: (extra: string) => extra },
        // Highlighting is asynchronous and dynamically imports a grammar chunk; in jsdom it never lands, and
        // the block is written to render plain-but-marked until it does. Answering undefined IS that path.
        useHighlighter: () => ({ tokenizeLine: async () => undefined }),
    };
});
// The document card renders through the ENGINE rather than the app's composable (see ChatDocumentBody), so the
// stub answers with one prose run naming its source: enough to tell a document that is drawn from one that is
// folded away, without a parser in a jsdom mount.
vi.mock("@intentic/ui/markdown", () => ({
    copyCodeFromEvent: vi.fn(),
    renderMarkdownParts: (source: string) => [{ kind: `html`, html: `<p>${source}</p>` }],
}));
// withoutResumeNote is the real behaviour, not a stub: the errand row depends on it to recognise an errand a
// resumed turn re-sent (errands.ts), and a mock that returned the text unchanged would hide that.
/* The contract rides along REAL, with one part stubbed. It used to be the other way round, a hand-written list
 * of the few exports this file wanted, and that list was a tripwire: the contract is what the whole platform is
 * spelled in, its vocabulary is evaluated at module load (role schemas, the capability catalog's country
 * lists), and every addition to it took this suite down with "no such export on the mock" long before any test
 * ran. Nothing here wants a bare module: it wants the real one with the plan parser out of the way. */
vi.mock("@intentic/sandbox-contract", async (importActual) => ({
    ...(await importActual<typeof import("@intentic/sandbox-contract")>()),
    planParts: (text: string) => ({ body: text }),
}));
vi.mock("../composables/chat/attachmentPreviews", () => ({ attachmentPreview: () => undefined }));
// formatElapsed is the real one: the loader's readout IS that format, so mocking it would test nothing.
vi.mock("../composables/agents/agentStatus", async () => {
    const { formatElapsed } = await vi.importActual<typeof import("../composables/agents/agentStatus")>("../composables/agents/agentStatus");
    return { effectiveAutoLand: () => false, effectiveOutageResume: () => false, formatElapsed };
});
vi.mock("../composables/chat/transcript", async () => {
    const { errandOf } = await vi.importActual<typeof import("../composables/chat/errands")>("../composables/chat/errands");
    return { foldsIntoTurn: (message: ChatMessage) => errandOf(message) !== undefined };
});
vi.mock("../composables/useMarkdown", async () => {
    const { computed } = await import("vue");
    return { useMarkdown: () => computed(() => markdown.parts) };
});
vi.mock("../composables/workspace/openFileRef", () => ({ openFileRefFromEvent: vi.fn() }));
vi.mock("../composables/workspace/useHistory", () => ({ restoreSnapshot: vi.fn() }));
vi.mock("./toolGrouping", () => ({ groupConsecutiveTools: () => [] }));
vi.mock("./ChatAttachmentStrip.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatTodoList.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatToolCard.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatToolGroup.vue", () => ({ default: { render: () => undefined } }));

// The row reads its PANE's conversation, not the focused one (useChat's PANE_VIEW), so what stands in for the
// store here is the pane's view, and `conversation` is the chat this row belongs to.
vi.mock("../composables/chat/useChat", async () => {
    const { computed, ref, shallowRef } = await import("vue");
    const conversation = shallowRef({
        conversationId: `agent-1`,
        providerRetry: ref(undefined),
        turnStartedAt: {
            get value(): number | undefined {
                return clock.turnStartedAt;
            },
        },
    });
    return {
        usePaneView: () => ({
            conversation,
            decidePlan: vi.fn(),
            answerQuestion: vi.fn(),
            cancelQuestion: vi.fn(),
            decidePermission: vi.fn(),
            streaming: computed(() => pane.streaming),
            awaitingDecision: ref(false),
            // No answer is ever in flight in these mounts; the card's buttons stay offered.
            isDeciding: () => false,
            editing: computed(() => pane.editing),
            beginEdit,
        }),
    };
});

// The roster's count of this conversation's live children: what the loader says it is waiting on.
vi.mock("../composables/agents/useAgents", () => ({
    useAgents: () => ({
        agentById: () => ({ subagents: { running: roster.running, total: roster.running } }),
        setAutoLand: vi.fn(),
        setResumeAfterOutage: vi.fn(),
    }),
}));

vi.mock("../composables/sandbox/useSandboxSettings", async () => {
    const { ref } = await import("vue");
    return {
        useSandboxSettings: () => ({ settings: ref(undefined), save: { mutateAsync: vi.fn() } }),
    };
});

const { default: ChatMessageView } = await import("./ChatMessageView.vue");

const message: ChatMessage = { id: 1, role: `assistant`, text: `` };
let app: App | undefined;

const mount = (subject: ChatMessage = message, extra: { doomed?: boolean } = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatMessageView, { message: subject, streaming: true, ...extra }) });
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.component(
        `Icon`,
        defineComponent({
            render: () => h(`i`),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    clock.turnStartedAt = Date.now() - 35_000;
    roster.running = 0;
    markdown.parts = [];
    pane.streaming = true;
    pane.editing = undefined;
    beginEdit.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    vi.useRealTimers();
});

describe(`ChatMessageView loader`, () => {
    it(`counts from the command start even when the view mounts later`, () => {
        const first = mount();
        expect(first.textContent).toContain(`(35s)`);

        app?.unmount();
        app = undefined;
        vi.advanceTimersByTime(12_000);

        const reopened = mount();
        expect(reopened.textContent).toContain(`(47s)`);
    });

    // A long turn is the case the readout exists for, and "(525s)" is arithmetic the reader has to do.
    it(`reads long turns in minutes and hours rather than a growing second count`, () => {
        clock.turnStartedAt = Date.now() - 525_000;
        expect(mount().textContent).toContain(`(8m 45s)`);

        app?.unmount();
        app = undefined;
        clock.turnStartedAt = Date.now() - 3_960_000;
        expect(mount().textContent).toContain(`(1h 6m)`);
    });

    /* THE ONE STRETCH THE CYCLING WORDS ARE WRONG ABOUT. A turn that delegated has written its "I'll come back
     * with their results" and gone quiet: nothing of its own is running, and the only thing between it and the
     * end is agents working elsewhere. "Percolating… (6m 12s)" over that reads as a model that has hung, so
     * the line says what it is actually waiting for, and goes back to the words once they are all in. */
    it(`names the children it is waiting on instead of cycling a word`, () => {
        roster.running = 2;
        const text = mount().textContent ?? ``;
        expect(text).toContain(String(roster.running));
        expect(text).toContain(`subagent`);
    });

    it(`says one child in the singular`, () => {
        roster.running = 1;
        const text = mount().textContent ?? ``;
        expect(text).toContain(String(roster.running));
        expect(text).toContain(`subagent`);
    });

    it(`goes back to the cycling word once they are all in`, () => {
        expect(mount().textContent).not.toContain(`Waiting on`);
    });

    // The counter ticks off a `now` the interval refreshes: a turn whose start is unknown gets no parenthetical
    // at all rather than a stuck "(0s)".
    it(`ticks while the turn runs and drops the readout when the start is unknown`, async () => {
        const element = mount();
        vi.advanceTimersByTime(30_000);
        await nextTick();
        expect(element.textContent).toContain(`(1m 5s)`);

        app?.unmount();
        app = undefined;
        clock.turnStartedAt = undefined;
        expect(mount().textContent).not.toContain(`(`);
    });
});

/* A question that takes SEVERAL answers must not read like one that takes a single pick. Mark shape, the line
 * above the list and the ARIA roles carry that one fact together, so each case below asserts all three: a card
 * that keeps only two of them out of three is the misleading card this suite exists to prevent. */
describe(`ChatMessageView question card`, () => {
    const ask = (multiSelect: boolean): ChatMessage => ({
        id: 3,
        role: `assistant`,
        text: ``,
        question: {
            requestId: multiSelect ? `req-multi` : `req-single`,
            status: `pending`,
            questions: [
                {
                    question: `Which surfaces should the banner appear on?`,
                    header: `Surfaces`,
                    multiSelect,
                    options: [
                        { label: `Chat`, description: `The conversation panel.` },
                        { label: `Agents`, description: `The fleet board.` },
                    ],
                },
            ],
        },
    });

    // The mark of every option row, Other's included, in the order they are shown.
    const marks = (element: HTMLElement): (string | null)[] =>
        [...element.querySelectorAll(`button[role="checkbox"] i, button[role="radio"] i`)].map((icon) => icon.getAttribute(`name`));

    // Picks are mirrored to localStorage per requestId: each case starts from an empty card.
    afterEach(() => localStorage.clear());

    it(`offers a multi-select question as a checkbox list and counts the picks back`, async () => {
        const element = mount(ask(true));
        expect(element.querySelector(`[role="group"]`)).not.toBeNull();
        expect(marks(element)).toEqual([`square`, `square`, `square`]);
        expect(element.querySelector(`button[role="checkbox"]`)).not.toBeNull();

        const rows = [...element.querySelectorAll<HTMLButtonElement>(`button[role="checkbox"]`)];
        rows[0]?.click();
        rows[1]?.click();
        await nextTick();

        // Both picks stand, and the line says so, which is what tells a user habituated to radios that the
        // second click was not going to cost them the first.
        expect(marks(element)).toEqual([`check-square`, `check-square`, `square`]);
        expect(rows[0]?.getAttribute(`aria-checked`)).toBe(`true`);
        expect(element.textContent).toContain(String(2));
    });

    /* WHAT THE QUESTION IS ABOUT, carried on the card itself (the daemon attaches it, see agent.ts). A choice
     * between options describing a write-up is unanswerable without the write-up, and by the time the card is
     * raised, the card that WROTE it has folded itself into `Write · +135 −0` well up the scroll. */
    const document = { path: `docs/findings.md`, title: `Why it is slow`, markdown: `# Why it is slow` };

    it(`draws the document a question is about, inside the card, open`, () => {
        const element = mount({ ...ask(false), question: { ...ask(false).question!, document } });
        expect(element.textContent).toContain(`Why it is slow`);
        // The prose itself, not just its name: the reader must be able to READ it where the decision is.
        expect(element.textContent).toContain(`# Why it is slow`);
        expect(element.textContent).toContain(`findings.md`);
    });

    it(`folds it when the write that produced it is already drawn in the same bubble`, async () => {
        const element = mount({
            ...ask(false),
            question: { ...ask(false).question!, document },
            tools: [
                {
                    id: `w1`,
                    name: `Write`,
                    category: `edit`,
                    status: `completed`,
                    content: [{ type: `diff`, path: `docs/findings.md`, newText: `# Why it is slow` }],
                },
            ],
        });
        // Named, so the reader knows what the question is about and can open it: two full copies of one
        // document in a row is length, not emphasis.
        expect(element.textContent).toContain(`Why it is slow`);
        expect(element.textContent).not.toContain(`# Why it is slow`);

        const fold = [...element.querySelectorAll<HTMLButtonElement>(`button[aria-expanded]`)].find((button) =>
            button.textContent?.includes(`Why it is slow`),
        );
        fold?.click();
        await nextTick();
        expect(element.textContent).toContain(`# Why it is slow`);
    });

    it(`keeps a single-select question round, silent, and one-pick-at-a-time`, async () => {
        const element = mount(ask(false));
        expect(element.querySelector(`button[role="checkbox"]`)).toBeNull();
        expect(element.querySelector(`[role="radiogroup"]`)).not.toBeNull();
        expect(marks(element)).toEqual([`circle`, `circle`, `circle`]);

        const rows = [...element.querySelectorAll<HTMLButtonElement>(`button[role="radio"]`)];
        rows[0]?.click();
        rows[1]?.click();
        await nextTick();

        // The second pick REPLACES the first, which is exactly what the round mark promised it would.
        expect(marks(element)).toEqual([`circle`, `check-circle`, `circle`]);
    });
});

/* An errand is the app's prompt, not the user's (errands.ts): the row says what was asked for, and the words
 * the agent actually got are behind one press rather than gone: the audit trail is the whole reason this is a
 * fold rather than a suppression. */
/* THE PERMISSION CARD, which is the one card in this transcript that asks a person to take responsibility for
 * something. What it has to get right is not the decision (that is the gate's) but the READING: which part of
 * this is the part that stopped it, and, when the sentence is standing in front of the command, that the
 * command is never actually gone. */
describe(`ChatMessageView permission card`, () => {
    const COMMAND = `cd /work && rg -n token .env.production`;
    // Derived, not hand-counted: these offsets stand in for the classifier's own, and a fixture off by two
    // tests the arithmetic of whoever wrote the fixture rather than the card.
    const CREDENTIAL = { start: COMMAND.indexOf(`.env.production`), end: COMMAND.length };
    const held = (extra: Record<string, unknown> = {}): ChatMessage =>
        ({
            id: 3,
            role: `assistant`,
            text: ``,
            permission: {
                requestId: `perm-1`,
                status: `pending`,
                toolName: `Bash`,
                title: `This command would read credential material`,
                alwaysLabel: `Allow everything that would read credential material this turn`,
                program: { text: COMMAND, language: `bash`, truncated: false, spans: [CREDENTIAL] },
                ...extra,
            },
        }) as ChatMessage;

    // Every piece of the rendered program, in order, with the marked ones named: the card must show the whole
    // command and mark exactly the fragment the gate pointed at.
    const program = (element: HTMLElement): { all: string; marked: string[] } => {
        const spans = [...element.querySelectorAll<HTMLElement>(`pre span`)];
        return {
            all: spans.map((span) => span.textContent).join(``),
            marked: spans.filter((span) => span.classList.contains(`chat-command-mark`)).map((span) => span.textContent ?? ``),
        };
    };

    /* Colour is asynchronous and never lands in jsdom, which is exactly the state this asserts against: the
     * marks are the GATE's and do not depend on a grammar chunk, so a card whose highlighting has not arrived
     * (or never will, offline, or in a language we ship no grammar for) still answers the question it exists to
     * ask. */
    it(`shows the whole command and marks the fragment that held it`, () => {
        const rendered = program(mount(held()));
        expect(rendered.all).toBe(COMMAND);
        expect(rendered.marked).toEqual([`.env.production`]);
    });

    // With no sentence to stand in for it, the command IS the body: nothing to disclose, so nothing offering to.
    it(`shows the command outright when there is no explanation`, () => {
        const element = mount(held());
        expect(element.textContent).not.toContain(`Show the command`);
        expect(element.querySelector(`pre`)).not.toBeNull();
    });

    /* THE DISCLOSURE, and the property that makes it defensible. Folded, the card still names the fragments it
     * was stopped for: hiding the command may never hide the evidence, or the fold has turned a wall of shell
     * into a card nobody can audit. */
    it(`folds the command behind a labelled control while keeping the marked fragments on the card`, async () => {
        const explain = `Searches the workspace for token references and reads a credentials file.`;
        const element = mount(held({ explain }));
        expect(element.textContent).toContain(`token references`);
        expect(element.querySelector(`pre`)).toBeNull();
        // The evidence, still stated.
        expect(element.textContent).toContain(`Stopped for`);
        expect([...element.querySelectorAll(`code.chat-command-chip`)].map((chip) => chip.textContent)).toEqual([`.env.production`]);

        const toggle = [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Show the command`));
        expect(toggle?.getAttribute(`aria-expanded`)).toBe(`false`);
        toggle?.click();
        await nextTick();
        expect(program(element).all).toBe(COMMAND);
        expect(element.textContent).toContain(`Hide the command`);
    });

    // The daemon cut the program; the card says so rather than ending mid-word and letting a reader believe
    // they have seen all of it.
    it(`says when the program was shortened`, () => {
        const element = mount(held({ program: { text: `cat .env`, language: `bash`, truncated: true, spans: [] } }));
        expect(element.textContent).toContain(`Shortened for this card`);
    });

    // The title is a SENTENCE, so it wraps in full rather than truncating behind a tooltip: this is the one
    // line that says what the card is about, and a reader on a narrow pane must not have to hover for it.
    it(`wraps its title rather than truncating it`, () => {
        const element = mount(held());
        const title = element.querySelector(`.chat-card-title`);
        expect(title?.textContent).toBe(held().permission!.title);
        expect(title?.classList.contains(`truncate`)).toBe(false);
    });

    it(`freezes with the answer that settled it, and offers nothing once it has`, () => {
        const element = mount(held({ status: `always` }));
        expect(element.textContent).toContain(`✓ Always allowed`);
        expect([...element.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Allow once`))).toBe(false);
    });
});

/* THE ANSWER'S BODY, which is prose AND the pictures drawn in it. A turn is rendered as parts precisely so a
 * ```mermaid an agent writes becomes a diagram in the chat rather than a wall of arrow syntax: for a long time
 * the file preview drew the diagrams and the answer that wrote them did not. */
describe(`ChatMessageView answer body`, () => {
    const body = { id: 3, role: `assistant`, text: `Here it is.` } as const satisfies ChatMessage;

    it(`draws a figure the answer wrote, in its place among the prose`, () => {
        markdown.parts = [
            { kind: `html`, html: `<p>Here it is.</p>` },
            { kind: `figure`, figure: { kind: `mermaid` } },
            { kind: `html`, html: `<p>And after.</p>` },
        ];
        const element = mount(body);
        const rendered = element.querySelector(`.chat-markdown`)?.children ?? [];
        expect([...rendered].map((child) => child.className)).toEqual([`md-part`, `figure-stub`, `md-part`]);
        expect(rendered[1]?.textContent).toBe(`mermaid`);
    });

    /* The shape every message that holds no figure renders in, and the reason the parts are wrapped in
     * display:contents rather than laid out: a turn's prose must reach .chat-markdown as its own children, or
     * prose.css's edge rules land on a wrapper and the bubble gains margins it never had. */
    it(`keeps a figure-free answer as plain prose wrappers`, () => {
        markdown.parts = [
            { kind: `html`, html: `<p>Settled.</p>` },
            { kind: `html`, html: `<p>Still writing</p>` },
        ];
        const element = mount(body);
        expect(element.querySelectorAll(`.chat-markdown > .md-part`)).toHaveLength(2);
        expect(element.querySelector(`.figure-stub`)).toBeNull();
    });
});

describe(`ChatMessageView errand row`, () => {
    const errand = ERRANDS.landConflict;
    const prompt = errandPrompt(errand, [`What blocked the land:\nroot\n  - src/auth/session.ts`]);

    it(`names the errand and keeps its prompt one press away rather than on screen`, async () => {
        const element = mount({ id: 2, role: `user`, text: prompt });
        expect(element.textContent).toContain(errand.label);
        expect(element.textContent).toContain(errand.detail);
        expect(element.textContent).not.toContain(`src/auth/session.ts`);
        // Never sticky: the pin belongs to the question this errand serves, one turn up.
        expect(element.querySelector(`.chat-prompt`)).toBeNull();

        element.querySelector(`button`)?.click();
        await nextTick();
        expect(element.textContent).toContain(`src/auth/session.ts`);
    });
});

/* THE NOTES ROW: the same bargain the errand row strikes, for text the daemon put in FRONT of the user's
 * message rather than instead of it. Collapsed so a turn that was told four things does not bury the answer;
 * openable because an agent visibly acting on instructions the reader cannot reach is the thing this replaces. */
describe(`ChatMessageView added-notes row`, () => {
    const notes = [
        { title: `How to read this message`, text: `## Reading the message below\n\nIt opens with a slash but names no command.` },
        { title: `Dependencies are behind`, text: `Some dependencies declared under /work are not installed.` },
    ];

    it(`names every note and keeps the words the agent got one press away`, async () => {
        const element = mount({ id: 3, role: `user`, text: `fix the bug`, notes });

        // Titles up front, so the reader knows what the turn was told without opening anything…
        expect(element.textContent).toContain(notes[0]!.title);
        expect(element.textContent).toContain(notes[1]!.title);
        // …and their words are collapsed, not absent.
        expect(element.textContent).not.toContain(notes[0]!.text);

        element.querySelector(`[aria-expanded]`)?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await nextTick();
        expect(element.textContent).toContain(`It opens with a slash but names no command.`);
        expect(element.textContent).toContain(notes[1]!.text);
        // The note's own `##` heading is written for a model reading markdown. Under a row that already names
        // the note it is raw syntax and a duplicate title, so it is the one line not drawn.
        expect(element.textContent).not.toContain(`##`);
        expect(element.textContent).not.toContain(`Reading the message below`);
    });

    // A turn nobody added anything to says nothing: no row, no chevron, nothing to click.
    it(`stays out of the way of an ordinary message`, () => {
        expect(mount({ id: 5, role: `user`, text: `fix the bug` }).textContent).not.toContain(`Sent with your message`);
    });
});

/* WHEN THE MESSAGE WAS SENT, in the margin beside the bubble it belongs to. Hover-only and out of flow, because
 * the hour a turn was sent at is worth nothing to someone reading the answer and everything to someone scrolling
 * back for "what did I ask on Tuesday", so it costs the transcript no height and the reader no attention. */
describe(`ChatMessageView sent time`, () => {
    // 2026-08-10T14:32 UTC. Rendered in the runner's zone, so the assertion is on the SHAPE of the label rather
    // than on an hour: every zone agrees it is a two-digit 24-hour clock and nothing else.
    const sentAt = Date.UTC(2026, 7, 10, 14, 32);

    it(`shows the minute a message was sent, revealed by hovering it`, () => {
        const label = mount({ id: 6, role: `user`, text: `fix the bug`, sentAt }).querySelector(`.group-hover\\:opacity-100`);

        // The clock alone: the day is carried by the transcript's own marker row (see dayMarksOf), which is what
        // keeps this label narrow enough for the margin it hangs in.
        expect(label?.textContent?.trim()).toMatch(/^\d{2}:\d{2}$/u);
        // Out of flow and hidden until the pointer arrives: the two halves of costing the transcript nothing.
        expect(label?.className).toContain(`absolute`);
        expect(label?.className).toContain(`opacity-0`);
        // BESIDE the bubble, not under it: below it the label sat in the gap between two turns, touching both.
        expect(label?.className).toContain(`right-full`);
        // And centred on the message rather than pinned to its first line: it spans the message's height and
        // aligns in the middle of it, which is what keeps it off the top corner of a six-line prompt.
        expect(label?.className).toContain(`inset-y-0`);
        expect(label?.className).toContain(`items-center`);
    });

    // Nothing is invented for a row with no stamp: a message recorded before the daemon wrote them down draws
    // no label at all rather than a plausible-looking time.
    it(`draws nothing for a message with no stamp`, () => {
        expect(mount({ id: 7, role: `user`, text: `fix the bug` }).querySelector(`.group-hover\\:opacity-100`)).toBeNull();
    });
});

/* THE EDIT PENCIL: "ask this turn again, differently", on the user's own bubble.
 *
 * It is deliberately NOT the pencil that was removed from here once: that one forked the chat into a new tab
 * and left the files alone while calling itself an edit. This one arms the composer against this message and
 * commits nothing (see Conversation.editing), which is why these assert that a click merely ARMS. */
describe(`ChatMessageView edit control`, () => {
    // Anchored (the daemon still holds a state for it) and settled: the two conditions an edit needs.
    const prompt: ChatMessage = { id: 8, role: `user`, text: `fix the bug`, rewindIndex: 2 };
    const pencil = (element: HTMLElement): HTMLElement | null => element.querySelector(`button[aria-label="Edit this message"]`);

    it(`offers the pencil in the margin of a settled prompt, and only arms`, () => {
        pane.streaming = false;
        const button = pencil(mount(prompt));

        expect(button).not.toBeNull();
        // In the column's RIGHT margin, the same gutter the fork mark stands in at the other end of the turn:
        // and out of flow, so a prompt is exactly as tall with this control as without it.
        expect(button?.className).toContain(`absolute`);
        expect(button?.className).toContain(`left-full`);
        expect(button?.className).toContain(`opacity-0`);

        button?.click();
        expect(beginEdit).toHaveBeenCalledWith(prompt);
    });

    /* No checkpoint means the files cannot come back to this point, and an edit that quietly kept today's files
     * would start the replacement turn on the very work it was meant to discard. Hidden rather than disabled: a
     * margin mark is invisible until hovered anyway, so there is no gap for a greyed one to explain. */
    it(`offers nothing where the files could not come back`, () => {
        pane.streaming = false;
        expect(pencil(mount({ id: 9, role: `user`, text: `fix the bug` }))).toBeNull();
    });

    // A rewind under a running agent is the one interleaving the daemon's lease exists to refuse, so the control
    // is not offered while the chat is mid-turn.
    it(`offers nothing while a turn is running`, () => {
        pane.streaming = true;
        expect(pencil(mount(prompt))).toBeNull();
    });

    // The composer is already holding this one: a second way to start what is running describes a state the
    // user left a moment ago.
    it(`offers nothing on the message whose own edit is armed`, () => {
        pane.streaming = false;
        pane.editing = prompt;
        expect(pencil(mount(prompt))).toBeNull();

        // A different prompt in the same chat still gets its own.
        app?.unmount();
        expect(pencil(mount({ id: 10, role: `user`, text: `and this`, rewindIndex: 4 }))).not.toBeNull();
    });

    // The agent's words are not the user's to rewrite: that is what the composer's agent voice is for.
    it(`offers nothing on the agent's own bubble`, () => {
        pane.streaming = false;
        expect(pencil(mount({ id: 11, role: `assistant`, text: `done`, rewindIndex: 2 }))).toBeNull();
    });

    /* WHAT AN ARMED EDIT WOULD SPEND, drawn on the rows themselves: struck AND faded, because fading alone is
     * this transcript's word for "quiet" and the thing these rows need to say is "about to be deleted".
     * Nothing has happened to them: the class is a preview, and cancelling restores them in place. */
    it(`strikes the rows an armed edit would replace`, () => {
        pane.streaming = false;
        expect(mount(prompt, { doomed: true }).querySelector(`.chat-doomed`)).not.toBeNull();
        app?.unmount();
        expect(mount(prompt).querySelector(`.chat-doomed`)).toBeNull();
    });
});
