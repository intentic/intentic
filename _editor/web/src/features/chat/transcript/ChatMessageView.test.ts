import "@intentic/testing/dom";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { type App, computed, createApp, h, nextTick, reactive, ref, shallowRef } from "vue";
import {
    type AgentActivity,
    type AgentJob,
    type AgentWatch,
    agentWordsRow,
    childReportPrompt,
    peerMessagePrompt,
    verifyNudgePrompt,
    watchWakePrompt,
    watchWakeRow,
} from "@intentic/sandbox-contract";
import { errandOf, errands, errandPrompt } from "../run/errands";
import { changedNothing, type ChatMessage } from "./transcript";
import { IconStub } from "@intentic/ui/testing";
import { CLOCK_FROM_MS, formatElapsed } from "../../agents/fleet/agentStatus";

const clock = { turnStartedAt: undefined as number | undefined };
const roster = {
    running: 0,
    watches: undefined as AgentWatch[] | undefined,
    jobs: undefined as AgentJob[] | undefined,
    activity: undefined as AgentActivity | undefined,
};
// Async like the action it stands in for: the row awaits it and swallows a failed disarm, so a sync stub rejects.
const stopWatching = jest.fn(async () => undefined);
// Pane state the edit pencil reads: mid-turn streaming and this message's own armed edit both hide it. The rows and
// the held queue are what a notice's send press reads to decide whether it still has anything to send.
const pane = {
    streaming: true,
    editing: undefined as ChatMessage | undefined,
    messages: [] as ChatMessage[],
    queued: [] as { readonly id: string; readonly text: string }[],
};
// The conversation's own release of a held queue, which is all a notice's send press asks of it.
const resume = jest.fn(async () => undefined);
// The conversation's ask that the sandbox run a turn it kept, which is what a press on a sandbox-kept refusal is.
const resendKept = jest.fn(async () => undefined);
const beginEdit = jest.fn();
// The one path every card's answer takes (CardReplies.reply), read back from the one the pane holds.
const reply = jest.fn(async () => true);
// What useMarkdown hands the row under test (prose runs, figures); empty unless the test is about the answer body.
const markdown = {
    parts: [] as { readonly kind: string; readonly html?: string; readonly figure?: { readonly kind: string } }[],
};

// Every ResizeObserver a mounted row builds, with the boxes it watches. jsdom has no layout to fire one, so the pinned
// band's suite fires the row's own by hand; the others are left alone and never fire, as before.
const resizers = [] as { readonly targets: Element[]; readonly fire: () => void }[];

(() => {
    // Resize/IntersectionObserver stubs since jsdom lacks both; never firing leaves clamp/pin at their default state.
    const idle = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.IntersectionObserver ??= idle as unknown as typeof globalThis.IntersectionObserver;
    // Assigned, not `??=`: this replaces the setup file's no-op ResizeObserver with one the suite can fire.
    globalThis.ResizeObserver = class {
        private readonly targets: Element[] = [];
        constructor(callback: ResizeObserverCallback) {
            resizers.push({ targets: this.targets, fire: () => callback([], this as unknown as ResizeObserver) });
        }
        observe(target: Element): void {
            if (!(target instanceof Element)) {
                throw new TypeError(`ResizeObserver requires an Element`);
            }
            this.targets.push(target);
        }
        unobserve(): void {}
        disconnect(): void {
            this.targets.length = 0;
        }
    } as unknown as typeof globalThis.ResizeObserver;
})();

// Imported as a namespace since this file already binds `h`/`defineComponent`, which a destructured factory would
// shadow.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        useDevice: () => ({ mobile: vue.ref(false) }),
        // Real `<button>` with attrs passthrough, since card answers are asserted by click; the kit's own press-lock
        // has its own suite.
        Button: vue.defineComponent({
            inheritAttrs: false,
            setup:
                (_props, { attrs, slots }) =>
                () =>
                    vue.h(`button`, attrs, slots[`default`]?.()),
        }),
        // Stands in for the figure kind only: this row cares whether a figure part reaches the bubble, not which
        // picture it renders as.
        MarkdownFigure: vue.defineComponent({
            props: { figure: { type: Object, required: true } },
            render(): unknown {
                return vue.h(`div`, { class: `figure-stub` }, String(this.figure[`kind`]));
            },
        }),
        // The kit's own stub, not a copy of it: a card reaches Icon through this import OR through the app's global
        // registration, and `marks()` has to read one shape either way.
        Icon: (await import(`@intentic/ui/testing`)).IconStub,
        // No layout under jsdom for a textarea to grow into; the card calls it on every keystroke regardless.
        growTextarea: () => {},
        // Copy/clipboard behavior is the design system's own test; here only that a card holding a program still
        // mounts.
        CopyButton: vue.defineComponent({
            props: { text: { type: String, required: true } },
            render(): unknown {
                return vue.h(`button`, { class: `copy-stub` });
            },
        }),
        // Class-recipe stand-ins return their input unchanged, since this suite asserts structure and text, not the
        // kit's geometry.
        ui: { linkButton: (extra: string) => extra, textAction: (extra: string) => extra, iconButton: (extra: string) => extra },
        // Highlighting never lands in jsdom; returning undefined is the pending-highlight state the block already
        // renders for.
        useHighlighter: () => ({ tokenizeLine: async () => undefined }),
        // Named by the graph (the resources dialog, link and port helpers) but never reached by a card here; bun
        // links an ESM import against exactly what this factory returns.
        SandboxResourcesDialog: vue.defineComponent({ render: () => undefined }),
        browserOwnsClick: () => false,
        clipboardOf: () => undefined,
        parseLoopbackLink: () => undefined,
        openForwardedPort: () => {},
    };
});
// Stub renders one prose run naming its source, enough to tell a drawn document from a folded one without a real
// parser.
jest.mock("@intentic/ui/markdown", () => ({
    copyCodeFromEvent: jest.fn(),
    renderMarkdownParts: (source: string) => [{ kind: `html`, html: `<p>${source}</p>` }],
}));
jest.mock("../drafts/attachmentPreviews", () => ({ attachmentPreview: () => undefined }));
// formatElapsed stays real, since the loader's readout is exactly that format.
jest.mock("../../agents/fleet/agentStatus", () => ({
    CLOCK_FROM_MS,
    effectiveAutoLand: () => false,
    effectiveOutageResume: () => false,
    formatElapsed,
}));
// changedNothing stays real: it decides whether a checklist is drawn at all, which is a card's own reading.
jest.mock("./transcript", () => ({ foldsIntoTurn: (message: ChatMessage) => errandOf(message) !== undefined, changedNothing }));
jest.mock("../../../lib/markdown/useMarkdown", () => {
    return { useMarkdown: () => computed(() => markdown.parts) };
});
jest.mock("../../workspace/files/openFileRef", () => ({ openFileRefFromEvent: jest.fn(), openWorkspaceRef: jest.fn() }));
jest.mock("../../workspace/changes/history/useHistory", () => ({ restoreSnapshot: jest.fn(), invalidateWorkspace: jest.fn() }));
jest.mock("../tools/toolGrouping", () => ({ groupConsecutiveTools: () => [] }));
jest.mock("../composer/ChatAttachmentStrip.vue", () => ({ default: { render: () => undefined } }));
jest.mock("./ChatTodoList.vue", () => ({ default: { render: () => undefined } }));
jest.mock("../tools/ChatToolCard.vue", () => ({ default: { render: () => undefined } }));
jest.mock("../tools/ChatToolGroup.vue", () => ({ default: { render: () => undefined } }));

// Stubs the pane's own view, not the focused one (useChat's PANE_VIEW), since this row reads its pane's conversation.
jest.mock("../panel/useChat-view", () => {
    const conversation = shallowRef({
        conversationId: `agent-1`,
        turn: {
            providerRetry: ref(undefined),
            resume,
            resendKept,
            turnStartedAt: {
                get value(): number | undefined {
                    return clock.turnStartedAt;
                },
            },
        },
        // Nothing is ever in flight, so the card's buttons stay offered in every mount here.
        requests: { reply, isReplying: () => false },
        transcript: { beginEdit },
    });
    return {
        usePaneView: () => ({
            conversation,
            streaming: computed(() => pane.streaming),
            awaitingDecision: ref(false),
            editing: computed(() => pane.editing),
            messages: computed(() => pane.messages),
            queued: computed(() => pane.queued),
        }),
    };
});

// Roster count of this conversation's live subagents, which the loader reports waiting on, and the outside conditions
// it is parked on, which a watch's own notice row reads to say whether it is still waiting.
jest.mock("../../agents/fleet/useAgents", () => ({
    useAgents: () => ({
        agentById: () => ({
            subagents: { running: roster.running, total: roster.running },
            watches: roster.watches,
            jobs: roster.jobs,
            activity: roster.activity,
        }),
        setAutoLand: jest.fn(),
        setResumeAfterOutage: jest.fn(),
        stopWatching,
    }),
}));

jest.mock("../../sandbox/overview/useSandboxSettings", () => {
    return {
        useSandboxSettings: () => ({ settings: ref(undefined), save: { mutateAsync: jest.fn() } }),
    };
});

// A 16 GiB box a connected device can reshape, on an engine a test may resize; 64 GiB leaves a raise room to offer.
const ROOMY_ENGINE = { memoryBytes: 64 * 1024 ** 3, cpus: 8 };
const selfEngine = ref(ROOMY_ENGINE);
jest.mock("../../sandbox/devices/useSelfResources", () => ({
    useSelfResources: () => ({
        slug: computed(() => `box`),
        current: computed(() => ({ memoryBytes: 16 * 1024 ** 3 })),
        engine: computed(() => selfEngine.value),
        reshapable: computed(() => true),
        applying: ref(false),
        apply: jest.fn(async () => undefined),
    }),
}));

const { default: ChatMessageView } = await import("./ChatMessageView.vue");
// Imported so the loader suite's last test can mount it standalone, asserting the same status line with no message at
// all.
const { default: ChatTurnStatus } = await import("./ChatTurnStatus.vue");

const message: ChatMessage = { id: 1, role: `assistant`, text: `` };
let app: App | undefined;

const mount = (subject: ChatMessage = message, extra: { doomed?: boolean } = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatMessageView, { message: subject, streaming: true, ...extra }) });
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    clock.turnStartedAt = Date.now() - 35_000;
    roster.running = 0;
    roster.watches = undefined;
    roster.jobs = undefined;
    roster.activity = undefined;
    stopWatching.mockClear();
    markdown.parts = [];
    pane.streaming = true;
    pane.editing = undefined;
    pane.messages = [];
    pane.queued = [];
    resume.mockClear();
    resendKept.mockClear();
    reply.mockClear();
    beginEdit.mockClear();
    resizers.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
});

it(`releases a removed prompt element and observes its replacement`, async () => {
    const subject = reactive<ChatMessage>({ id: 12, role: `user`, text: `first prompt` });
    const element = mount(subject);
    const errors = jest.fn();
    app!.config.errorHandler = errors;
    await nextTick();
    const first = element.querySelector(`.chat-prompt-text`)!;
    expect(resizers.filter((resizer) => resizer.targets.includes(first))).toHaveLength(1);

    subject.text = ``;
    await nextTick();
    expect(element.querySelector(`.chat-prompt-text`)).toBeNull();
    expect(resizers.filter((resizer) => resizer.targets.includes(first))).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();

    subject.text = `replacement prompt`;
    await nextTick();
    const replacement = element.querySelector(`.chat-prompt-text`)!;
    expect(replacement.textContent?.trim()).toBe(`replacement prompt`);
    expect(resizers.filter((resizer) => resizer.targets.includes(replacement))).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
});

describe(`ChatMessageView loader`, () => {
    it(`counts from the command start even when the view mounts later`, () => {
        const first = mount();
        expect(first.textContent).toContain(`(35s)`);

        app?.unmount();
        app = undefined;
        jest.advanceTimersByTime(12_000);

        const reopened = mount();
        expect(reopened.textContent).toContain(`(47s)`);
    });

    it(`reads long turns in minutes and hours rather than a growing second count`, () => {
        clock.turnStartedAt = Date.now() - 525_000;
        expect(mount().textContent).toContain(`(8m 45s)`);

        app?.unmount();
        app = undefined;
        clock.turnStartedAt = Date.now() - 3_960_000;
        expect(mount().textContent).toContain(`(1h 6m)`);
    });

    it(`names the children it is waiting on instead of its own step`, () => {
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

    it(`goes back to its own step once they are all in`, () => {
        roster.activity = { tool: `Read`, target: `src/a.ts` };
        const text = mount().textContent ?? ``;
        expect(text).not.toContain(`Waiting on`);
        expect(text).toContain(`Read src/a.ts…`);
    });

    it(`says the step the roster reports: the tool with what it reached for, over the checklist item`, () => {
        roster.activity = { tool: `Edit`, target: `src/guard.ts`, todo: `write tests` };
        expect(mount().textContent).toContain(`Edit src/guard.ts…`);
    });

    it(`falls back to the checklist item, then to Thinking when the roster knows nothing yet`, () => {
        roster.activity = { todo: `write tests` };
        expect(mount().textContent).toContain(`write tests…`);

        app?.unmount();
        app = undefined;
        roster.activity = undefined;
        expect(mount().textContent).toContain(`Thinking…`);
    });

    it(`ticks while the turn runs and drops the readout when the start is unknown`, async () => {
        const element = mount();
        jest.advanceTimersByTime(30_000);
        await nextTick();
        expect(element.textContent).toContain(`(1m 5s)`);

        app?.unmount();
        app = undefined;
        clock.turnStartedAt = undefined;
        expect(mount().textContent).not.toContain(`(`);
    });

    it(`says the same thing mounted on its own, with no message to hang off`, () => {
        const element = document.createElement(`div`);
        document.body.append(element);
        app = createApp({ render: () => h(ChatTurnStatus) });
        app.use(VueQueryPlugin, { queryClient: new QueryClient() });
        app.component(`Icon`, IconStub);
        app.mount(element);
        expect(element.textContent).toContain(`(35s)`);
    });
});

// Pins that a multi-select question reads as multi-select via mark shape, hint text, and ARIA role together, every
// case.
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

    // Marks for every option row in order; `data-icon` is the testing stub's published attribute for the `name` prop
    // (ui/testing.ts).
    const marks = (element: HTMLElement): (string | null)[] =>
        [...element.querySelectorAll(`button[role="checkbox"] i, button[role="radio"] i`)].map((icon) => icon.getAttribute(`data-icon`));

    // Picks mirror to localStorage per requestId; cleared so each case starts from an empty card.
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

        expect(marks(element)).toEqual([`check-square`, `check-square`, `square`]);
        expect(rows[0]?.getAttribute(`aria-checked`)).toBe(`true`);
        expect(element.textContent).toContain(String(2));
    });

    // Write-up the question refers to, attached to the card by the daemon (agent.ts). Its opening heading repeats the
    // title, which the card strips (planParts), so the prose below it is what proves the body is drawn.
    const document = { path: `docs/findings.md`, title: `Why it is slow`, markdown: `# Why it is slow\n\nThe index rebuilds on every keystroke.` };
    const BODY = `The index rebuilds on every keystroke.`;

    it(`draws the document a question is about, inside the card, open`, () => {
        const element = mount({ ...ask(false), question: { ...ask(false).question!, document } });
        expect(element.textContent).toContain(`Why it is slow`);
        expect(element.textContent).toContain(BODY);
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
                    content: [{ type: `diff`, path: `docs/findings.md`, newText: document.markdown }],
                },
            ],
        });
        expect(element.textContent).toContain(`Why it is slow`);
        expect(element.textContent).not.toContain(BODY);

        const fold = [...element.querySelectorAll<HTMLButtonElement>(`button[aria-expanded]`)].find((button) =>
            button.textContent?.includes(`Why it is slow`),
        );
        fold?.click();
        await nextTick();
        expect(element.textContent).toContain(BODY);
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

        expect(marks(element)).toEqual([`circle`, `check-circle`, `circle`]);
    });

    // Every row of the card — live, settled, and the Other row — is drawn by the one rule that owns a card's column
    // (`.chat-option` in chat.css). A call site that re-answers the geometry, or puts a rim back on an option, is the
    // drift this pins: the options are a list on the card's own margin, not boxes floating inside it.
    const optionRows = (element: HTMLElement): HTMLElement[] => [...element.querySelectorAll<HTMLElement>(`.chat-option`)];

    it(`draws every option as a row of the card's own list, with no box of its own`, () => {
        const element = mount(ask(true));
        const rows = optionRows(element);
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => row.tagName)).toEqual([`BUTTON`, `BUTTON`, `BUTTON`]);
        expect(rows.filter((row) => /(?:^|\s)(?:border|rounded|bg-)/.test(row.className))).toEqual([]);
    });

    it(`shows the mock-up an option carries, and nothing where an option carries none`, () => {
        // Built from the fixture's own first option, so the card under test differs from the others by the preview alone.
        const card = ask(false).question!;
        const asked = card.questions[0]!;
        const previewed = {
            ...card,
            questions: [{ ...asked, options: [{ ...asked.options[0]!, preview: `[ Banner ]\n  body` }, ...asked.options.slice(1)] }],
        };
        const element = mount({ ...ask(false), question: previewed });
        const previews = [...element.querySelectorAll(`.chat-option-preview`)];
        expect(previews).toHaveLength(1);
        expect(previews[0]?.textContent).toBe(`[ Banner ]\n  body`);
        expect(previews[0]?.closest(`.chat-option`)?.textContent).toContain(`Chat`);
    });

    // The answer that leaves the card: picked labels in order, with the typed words standing in for the Other row.
    it(`answers with the picked labels, and with the reader's own words where Other was picked`, async () => {
        const element = mount(ask(true));
        const rows = [...element.querySelectorAll<HTMLButtonElement>(`button[role="checkbox"]`)];
        rows[0]?.click();
        rows[2]?.click();
        await nextTick();

        const field = element.querySelector<HTMLTextAreaElement>(`textarea`);
        expect(field, `picking Other opens the field it is the payload for`).not.toBeNull();
        field!.value = `Only the release notes page`;
        field?.dispatchEvent(new Event(`input`));
        await nextTick();

        const submit = [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Submit`));
        submit?.click();
        expect(reply).toHaveBeenCalledWith(`req-multi`, {
            kind: `question`,
            answers: { "Which surfaces should the banner appear on?": [`Chat`, `Only the release notes page`] },
        });
    });

    it(`freezes a settled card on its pick, keeping what it was chosen over`, () => {
        const settled = mount({
            ...ask(false),
            question: {
                ...ask(false).question!,
                status: `answered`,
                answers: { "Which surfaces should the banner appear on?": [`Agents`, `Only the release notes page`] },
            },
        });
        expect(settled.querySelector(`button[role="radio"]`), `a decided card offers nothing to press`).toBeNull();

        const rows = optionRows(settled);
        expect(rows.map((row) => row.classList.contains(`chat-option-picked`))).toEqual([false, true, true]);
        expect(rows[0]?.textContent).toContain(`The conversation panel.`);
        expect(rows[2]?.textContent).toContain(`Only the release notes page`);
        expect(settled.textContent).toContain(`Answered`);
    });
});

// An errand is the app's prompt, not the user's; folded so the words the agent actually got stay one press away rather
// than gone.
// Permission card: correctness here is the reading, which part of the sentence stopped the command, not the underlying
// decision.
describe(`ChatMessageView permission card`, () => {
    const COMMAND = `cd /work && rg -n token .env.production`;
    // Offsets derived from the command string, not hand-counted, so a fixture typo doesn't test itself instead of the
    // card.
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
                // The gate's own verdict sentence for this command, not a triage class label.
                title: `Searches the workspace for token references and reads a credentials file.`,
                alwaysLabel: `Always: reading .env files under /work is fine`,
                program: { text: COMMAND, language: `bash`, truncated: false, spans: [CREDENTIAL] },
                ...extra,
            },
        }) as ChatMessage;

    // All rendered program text in order, with marked (gate-flagged) fragments named separately.
    const program = (element: HTMLElement): { all: string; marked: string[] } => {
        const spans = [...element.querySelectorAll<HTMLElement>(`pre span`)];
        return {
            all: spans.map((span) => span.textContent).join(``),
            marked: spans.filter((span) => span.classList.contains(`chat-command-mark`)).map((span) => span.textContent ?? ``),
        };
    };

    it(`folds the command behind a labelled control, and shows it whole and marked when opened`, async () => {
        const element = mount(held());
        expect(element.querySelector(`pre`)).toBeNull();

        const toggle = [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Show the command`));
        expect(toggle?.getAttribute(`aria-expanded`)).toBe(`false`);
        toggle?.click();
        await nextTick();
        expect(program(element)).toEqual({ all: COMMAND, marked: [`.env.production`] });
        expect(element.textContent).toContain(`Hide the command`);
    });

    it(`offers no fragment chips standing in for a reason`, () => {
        const element = mount(held({ explain: `Wipes the second disk.` }));
        expect(element.textContent).not.toContain(`Stopped for`);
        expect(element.querySelector(`code.chat-command-chip`)).toBeNull();
    });

    it(`shows the judge's sentence under a hard-rule title`, () => {
        const element = mount(held({ title: `This command would wipe a disk`, explain: `Formats the second disk.` }));
        expect(element.querySelector(`.chat-card-title`)?.textContent).toBe(`This command would wipe a disk`);
        expect(element.textContent).toContain(`Formats the second disk.`);
    });

    it(`says when the program was shortened`, async () => {
        const element = mount(held({ program: { text: `cat .env`, language: `bash`, truncated: true, spans: [] } }));
        [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Show the command`))?.click();
        await nextTick();
        expect(element.textContent).toContain(`Shortened for this block`);
    });

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

// Answer body renders as parts (prose plus figures) so an agent's mermaid fence becomes a diagram, not raw arrow
// syntax.
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
    const errand = errands().landConflict;
    const prompt = errandPrompt(errand, [`What blocked the land:\nroot\n  - src/auth/session.ts`]);

    it(`names the errand and keeps its prompt one press away rather than on screen`, async () => {
        const element = mount({ id: 2, role: `user`, text: prompt });
        expect(element.textContent).toContain(errand.label);
        expect(element.textContent).toContain(errand.detail);
        expect(element.textContent).not.toContain(`src/auth/session.ts`);
        expect(element.querySelector(`.chat-prompt`)).toBeNull();

        const mark = element.querySelector<HTMLButtonElement>(`button[aria-expanded]`)!;
        // A turn nobody typed still appears as a turn: the line says what it was, the mark holds what it sent.
        expect(mark.textContent).not.toContain(errand.label);
        expect(mark.getAttribute(`aria-label`)).toBe(errand.label);

        mark.click();
        await nextTick();
        expect(element.textContent).toContain(`src/auth/session.ts`);
    });

    // The one errand the DAEMON composes rather than this app (verify-nudge.ts). Built here the way the daemon builds
    // it, through the contract both ends share, so a reworded opening on either side fails rather than quietly
    // un-recognising the nudge and filing it as something the user typed.
    it(`recognises the sandbox's own follow-up, composed the way the daemon composes it`, () => {
        const sent = verifyNudgePrompt([`This turn changed code and no check has passed since the last edit:\n- src/parser.ts`]);
        const element = mount({ id: 4, role: `user`, text: sent });

        expect(element.textContent).toContain(errands().verifyNudge.label);
        expect(element.querySelector(`.chat-prompt`)).toBeNull();
        expect(element.querySelector(`button[aria-label="Edit this message"]`)).toBeNull();
        // The asks stay behind the mark: the row says what happened, not the whole of what was asked for.
        expect(element.textContent).not.toContain(`src/parser.ts`);
    });
});

// Notes mark: same bargain as the errand row, for sandbox-prepended context, in two steps — the mark says how much was
// added and takes no width from the column, opening it names each note, opening a note gives its verbatim words.
describe(`ChatMessageView added-notes mark`, () => {
    const notes = [
        { title: `How to read this message`, text: `## Reading the message below\n\nIt opens with a slash but names no command.` },
        { title: `Dependencies are behind`, text: `Some dependencies declared under /work are not installed.` },
    ];

    it(`stands for the whole preamble as one mark, and names the notes on press`, async () => {
        const element = mount({ id: 3, role: `user`, text: `fix the bug`, notes });

        const mark = element.querySelector(`[aria-expanded]`)!;
        // A count and a glyph is the whole of it: the name is on hover, so the lane stays out of the reading column.
        expect(mark.textContent?.trim()).toBe(String(notes.length));
        expect(mark.getAttribute(`aria-label`)).toBe(`Sent with your message`);
        expect(mark.querySelector(`[data-icon="paperclip"]`)).not.toBeNull();
        expect(element.textContent).not.toContain(notes[0]!.title);

        mark.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await nextTick();
        expect(element.textContent).toContain(notes[0]!.title);
        expect(element.textContent).toContain(notes[1]!.title);
        // A list of what was added costs the list, not the text of everything on it.
        expect(element.textContent).not.toContain(notes[1]!.text);
    });

    it(`opens one note at a time, without repeating the heading its own row already states`, async () => {
        const element = mount({ id: 4, role: `user`, text: `fix the bug`, notes });

        element.querySelector(`[aria-expanded]`)!.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await nextTick();
        const rows = [...element.querySelectorAll(`[aria-expanded]`)].slice(1);
        expect(rows).toHaveLength(notes.length);

        rows[0]!.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await nextTick();
        expect(element.textContent).toContain(`It opens with a slash but names no command.`);
        expect(element.textContent).not.toContain(`##`);
        expect(element.textContent).not.toContain(`Reading the message below`);
        expect(element.textContent).not.toContain(notes[1]!.text);

        rows[1]!.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await nextTick();
        expect(element.textContent).toContain(notes[1]!.text);
        expect(element.textContent).not.toContain(`It opens with a slash but names no command.`);
    });

    it(`sits outside the prompt, so it never rides in the pinned band`, () => {
        const element = mount({ id: 6, role: `user`, text: `fix the bug`, notes });

        const mark = element.querySelector(`[aria-expanded]`);
        expect(mark).not.toBeNull();
        expect(mark!.closest(`.chat-prompt`)).toBeNull();
        expect(element.querySelector(`.chat-prompt`)).not.toBeNull();
    });

    it(`stays out of the way of an ordinary message`, () => {
        const element = mount({ id: 5, role: `user`, text: `fix the bug` });
        expect(element.querySelector(`[aria-label="Sent with your message"]`)).toBeNull();
        expect(element.querySelector(`.chat-mark-bar`)).toBeNull();
    });
});

// Sent-time label: hover-only and out of flow, so it costs the transcript no height while still answering when a turn
// was asked.
describe(`ChatMessageView sent time`, () => {
    // Rendered in the runner's own timezone; assertions check the label's shape (HH:MM), not a specific hour.
    const sentAt = Date.UTC(2026, 7, 10, 14, 32);

    it(`shows the minute a message was sent, revealed by hovering it`, () => {
        const label = mount({ id: 6, role: `user`, text: `fix the bug`, sentAt }).querySelector(`.group-hover\\:opacity-100`);

        expect(label?.textContent?.trim()).toMatch(/^\d{2}:\d{2}$/u);
        expect(label?.className).toContain(`absolute`);
        expect(label?.className).toContain(`opacity-0`);
        expect(label?.className).toContain(`right-full`);
        expect(label?.className).toContain(`inset-y-0`);
        expect(label?.className).toContain(`items-center`);
    });

    it(`draws nothing for a message with no stamp`, () => {
        expect(mount({ id: 7, role: `user`, text: `fix the bug` }).querySelector(`.group-hover\\:opacity-100`)).toBeNull();
    });
});

// Edit pencil arms the composer against this message rather than committing anything (TranscriptView.editing); a click
// only arms it.
describe(`ChatMessageView edit control`, () => {
    // Anchored (has a rewindIndex) and settled: the two conditions the edit control requires.
    const prompt: ChatMessage = { id: 8, role: `user`, text: `fix the bug`, rewindIndex: 2 };
    const pencil = (element: HTMLElement): HTMLElement | null => element.querySelector(`button[aria-label="Edit this message"]`);

    it(`offers the pencil in the margin of a settled prompt, and only arms`, () => {
        pane.streaming = false;
        const button = pencil(mount(prompt));

        expect(button).not.toBeNull();
        expect(button?.className).toContain(`absolute`);
        expect(button?.className).toContain(`left-full`);
        expect(button?.className).toContain(`opacity-0`);

        button?.click();
        expect(beginEdit).toHaveBeenCalledWith(prompt);
    });

    it(`offers nothing where the files could not come back`, () => {
        pane.streaming = false;
        expect(pencil(mount({ id: 9, role: `user`, text: `fix the bug` }))).toBeNull();
    });

    it(`offers nothing while a turn is running`, () => {
        pane.streaming = true;
        expect(pencil(mount(prompt))).toBeNull();
    });

    it(`offers nothing on the message whose own edit is armed`, () => {
        pane.streaming = false;
        pane.editing = prompt;
        expect(pencil(mount(prompt))).toBeNull();

        app?.unmount();
        expect(pencil(mount({ id: 10, role: `user`, text: `and this`, rewindIndex: 4 }))).not.toBeNull();
    });

    it(`offers nothing on the agent's own bubble`, () => {
        pane.streaming = false;
        expect(pencil(mount({ id: 11, role: `assistant`, text: `done`, rewindIndex: 2 }))).toBeNull();
    });

    it(`strikes the rows an armed edit would replace`, () => {
        pane.streaming = false;
        expect(mount(prompt, { doomed: true }).querySelector(`.chat-doomed`)).not.toBeNull();
        app?.unmount();
        expect(mount(prompt).querySelector(`.chat-doomed`)).toBeNull();
    });
});

// THE PINNED BAND (.chat-prompt-pinned in chat.css), which is the only thing painting the opaque background a stuck
// prompt needs. CSS cannot ask whether a sticky row is stuck, so the class is measured in JS — and a row is stuck by
// layout alone as readily as by scrolling: content above it loses height, or the box around it resizes. Measured off
// scroll events only, the row lifts with no event behind it and the turn scrolls through a transparent prompt.
describe(`ChatMessageView pinned band`, () => {
    const prompt: ChatMessage = { id: 12, role: `user`, text: `fix the bug` };
    // jsdom lays nothing out, so both boxes answer from here; a test moves the row across the scroller's own edge.
    // The row's flow position starts below it (8px down the scroller), which is a prompt that has not pinned yet.
    const box = { rowTop: 8, scrollerTop: 0 };

    const rectAt = (top: number): DOMRect =>
        ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    // The transcript as ChatPane builds it: the scroller the prompt pins against, and the wrapper inside it that
    // grows with the turn.
    // Async because the row's own measurement is a post-flush watcher: it runs, and builds its observers, on the
    // tick after the mount.
    const mountInTranscript = async (): Promise<{ row: HTMLElement; scroller: HTMLElement; content: HTMLElement }> => {
        box.rowTop = 8;
        const scroller = document.createElement(`div`);
        scroller.className = `chat-scroller`;
        const content = document.createElement(`div`);
        scroller.append(content);
        document.body.append(scroller);
        app = createApp({ render: () => h(ChatMessageView, { message: prompt, streaming: false }) });
        app.use(VueQueryPlugin, { queryClient: new QueryClient() });
        app.component(`Icon`, IconStub);
        app.directive(`tooltip`, {});
        app.mount(content);
        await nextTick();
        const row = scroller.querySelector<HTMLElement>(`.chat-prompt`)!;
        scroller.getBoundingClientRect = (): DOMRect => rectAt(box.scrollerTop);
        row.getBoundingClientRect = (): DOMRect => rectAt(box.rowTop);
        return { row, scroller, content };
    };

    // Reports the observation as the browser would, and answers how many observers were watching that box at all —
    // zero means nothing is measuring it, which is the state this suite exists to catch.
    const resize = (target: Element): number => {
        const watching = resizers.filter((resizer) => resizer.targets.includes(target));
        for (const resizer of watching) {
            resizer.fire();
        }
        return watching.length;
    };

    it(`paints the band when the turn above the prompt changes height, with nothing scrolled`, async () => {
        const { row, content } = await mountInTranscript();
        expect(row.className).not.toContain(`chat-prompt-pinned`);

        // A card above folds: the row lifts past the scroller's edge while scrollTop never moves, so no scroll
        // event follows the change.
        box.rowTop = -1;
        expect(resize(content)).toBeGreaterThan(0);
        await nextTick();

        expect(row.className).toContain(`chat-prompt-pinned`);
    });

    it(`paints the band when the pane itself resizes under a stuck prompt`, async () => {
        const { row, scroller } = await mountInTranscript();
        expect(row.className).not.toContain(`chat-prompt-pinned`);

        // The floating window fitting itself around a second pane: the box moves, the scroll position does not.
        box.rowTop = -1;
        expect(resize(scroller)).toBeGreaterThan(0);
        await nextTick();

        expect(row.className).toContain(`chat-prompt-pinned`);
    });

    it(`takes the band off again the moment the row is back in flow`, async () => {
        const { row, content } = await mountInTranscript();
        box.rowTop = -1;
        resize(content);
        await nextTick();
        expect(row.className).toContain(`chat-prompt-pinned`);

        // In flow the band must not paint: it would lie over the half-rem a run bar's count mark is pulled into
        // the row's padding, and shave the mark's ring off (see .chat-prompt in chat.css).
        box.rowTop = 8;
        resize(content);
        await nextTick();

        expect(row.className).not.toContain(`chat-prompt-pinned`);
    });

    // A TURN WHOSE REMAINING CONTENT IS WITHIN ONE COLLAPSE OF FILLING THE PANE, read from the foot of the scroller:
    // the band's own one-line title frees the px it saves, there is no scroll left below to absorb them, so the clamped
    // scroll hands them back and the row's flow position drops by that much — below the edge, where the same
    // measurement says unpin. Measured without hysteresis the two states chased each other at frame rate (~180 class
    // flips a second in the popped-out chat). Both boxes answer from the class actually on the row, which is the loop.
    const feedback = (row: HTMLElement, wrapped: { top: number; height: number }, titled: { top: number; height: number }): void => {
        const collapsed = (): boolean => row.className.includes(`chat-prompt-pinned`);
        row.getBoundingClientRect = (): DOMRect => rectAt(collapsed() ? titled.top : wrapped.top);
        Object.defineProperty(row, `offsetHeight`, { configurable: true, get: () => (collapsed() ? titled.height : wrapped.height) });
    };

    // Each round is the browser observing the height the round before changed, which is how the loop ran.
    const rounds = async (row: HTMLElement, fire: () => void): Promise<number> => {
        let flips = 0;
        let previous = row.className;
        for (let round = 0; round < 10; round += 1) {
            fire();
            await nextTick();
            if (row.className === previous) {
                break;
            }
            previous = row.className;
            flips += 1;
        }
        return flips;
    };

    it(`settles pinned when its own collapse is what drops the row back past the edge`, async () => {
        const { row } = await mountInTranscript();
        // Stuck 44px above the edge while the prompt wraps, 12px below it as a one-line title: 56px of collapse.
        feedback(row, { top: -44, height: 96 }, { top: 12, height: 40 });

        expect(await rounds(row, () => resize(row))).toBe(1);
        expect(row.className).toContain(`chat-prompt-pinned`);
    });

    it(`releases the band once the row sits below the edge by more than its collapse freed`, async () => {
        const { row, scroller } = await mountInTranscript();
        feedback(row, { top: -44, height: 96 }, { top: 12, height: 40 });
        await rounds(row, () => resize(row));
        expect(row.className).toContain(`chat-prompt-pinned`);

        // Scrolled back by more than the 56px the collapse freed: this is the reader moving the row, not the band.
        row.getBoundingClientRect = (): DOMRect => rectAt(60);
        scroller.dispatchEvent(new Event(`scroll`));
        await nextTick();

        expect(row.className).not.toContain(`chat-prompt-pinned`);
    });
});

describe(`another agent's words`, () => {
    const PEER = peerMessagePrompt({ from: `sharp-shale-htw8`, title: `Bun migration`, message: `the sweep is done` });
    const REPORT = childReportPrompt({ child: `sub-x7`, title: `Port the parser`, failed: true, report: `tests fail`, verification: undefined });
    // Built by the daemon's own reader, rather than transcribed.
    const rowOf = (prompt: string): ChatMessage => ({ id: 12, ...agentWordsRow(prompt)! });

    it(`draws a peer's message as a notice naming the sender, never as a prompt the user could edit`, () => {
        const element = mount(rowOf(PEER));
        expect(element.querySelector(`.chat-prompt`)).toBeNull();
        expect(element.querySelector(`button[aria-label="Edit this message"]`)).toBeNull();
        expect(element.textContent).toContain(`Message from another conversation: "Bun migration" (sharp-shale-htw8).`);
        expect([...element.querySelectorAll(`i`)].map((icon) => icon.getAttribute(`data-icon`))).toContain(`comments`);
    });

    it(`keeps what was sent one press away, verbatim`, async () => {
        const element = mount(rowOf(PEER));
        expect(element.querySelector(`pre`)).toBeNull();
        const toggle = element.querySelector<HTMLButtonElement>(`button[aria-expanded="false"]`)!;
        expect(toggle.textContent?.trim()).toBe(`Show the message`);
        toggle.click();
        await nextTick();
        expect(element.querySelector(`pre`)?.textContent).toBe(PEER);
    });

    it(`weights a child that failed like a watch that gave up`, () => {
        const element = mount(rowOf(REPORT));
        expect(element.textContent).toContain(`Child agent "Port the parser" (sub-x7) failed.`);
        expect(element.querySelector(`.text-danger`)).not.toBeNull();
        expect(mount(rowOf(PEER)).querySelector(`.text-danger`)).toBeNull();
    });
});

// A job's row is written once, at its start; how it is doing after that is read live off the card.
describe(`background jobs`, () => {
    const jobRow = (): ChatMessage => ({
        id: 7,
        role: `notice`,
        text: `Background job: Run the web e2e suite`,
        backgroundJob: { id: `job-1`, label: `Run the web e2e suite`, command: `pnpm -C web e2e --project=chromium`, startedAt: Date.now() - 65_000 },
    });

    const live = (over: Partial<AgentJob> = {}): AgentJob => ({
        id: `job-1`,
        label: `Run the web e2e suite`,
        session: `agent-1`,
        startedAt: Date.now() - 65_000,
        ...over,
    });

    const icons = (element: HTMLElement): (string | null)[] => [...element.querySelectorAll(`i`)].map((icon) => icon.getAttribute(`data-icon`));

    it(`names the job by the agent's words, not its command, and says it is running and for how long`, () => {
        roster.jobs = [live()];
        const element = mount(jobRow());
        expect(element.textContent).toContain(`Run the web e2e suite`);
        expect(element.textContent).toContain(`Running in the background · 1m 5s`);
        expect(element.textContent).not.toContain(`pnpm`);
        expect(icons(element)).toContain(`spinner`);
        expect(icons(element)).not.toContain(`info-circle`);
    });

    it(`keeps counting while the job runs`, async () => {
        roster.jobs = [live()];
        const element = mount(jobRow());
        jest.advanceTimersByTime(60_000);
        await nextTick();
        expect(element.textContent).toContain(`2m 5s`);
    });

    it(`says how a job ended once the card reports it, weighting a failure`, () => {
        roster.jobs = [live({ endedAt: Date.now() - 13_000, exitCode: 0 })];
        const finished = mount(jobRow());
        expect(finished.textContent).toContain(`Finished in 52s`);
        expect(icons(finished)).toContain(`check`);

        app?.unmount();
        app = undefined;
        roster.jobs = [live({ endedAt: Date.now() - 24_000, exitCode: 2 })];
        const failed = mount(jobRow());
        expect(failed.textContent).toContain(`Failed (exit 2) after 41s`);
        expect(failed.querySelector(`.text-danger`)).not.toBeNull();
    });

    // A daemon restart forgets a job's live state; the row then claims nothing about how it went.
    it(`claims no outcome for a job the card no longer knows`, () => {
        const element = mount(jobRow());
        expect(element.textContent).toContain(`Background job · started`);
        expect(element.textContent).not.toContain(`Running`);
        expect(icons(element)).not.toContain(`spinner`);
    });

    it(`keeps the command one press away`, async () => {
        roster.jobs = [live()];
        const element = mount(jobRow());
        element.querySelector<HTMLButtonElement>(`button[aria-expanded="false"]`)!.click();
        await nextTick();
        expect(element.textContent).toContain(`pnpm -C web e2e --project=chromium`);
    });
});

// A watch is the one thing in a conversation that acts while nobody is looking: it is armed inside one turn and fires
// into another, hours later. Both moments are rows nobody typed, and drawing either as a user bubble credits the
// reader with words the daemon wrote — which the edit pencil would then offer to rewind the conversation to.
describe(`condition watches`, () => {
    const WAKE = watchWakePrompt({
        outcome: `met`,
        id: `watch-2`,
        note: `CI run 316 on intentic/intentic`,
        elapsed: `43m`,
        command: `gh run view 316 --json status`,
        exitCode: 0,
        output: `completed success`,
    });

    // As the daemon's own readers build it (sandbox-contract/watch-wake.ts), rather than transcribed: a row hand-built
    // here would keep passing after the composer changed under it.
    const wakeRow = (prompt: string = WAKE): ChatMessage => ({ id: 9, ...watchWakeRow(prompt)! });

    const armedRow = (): ChatMessage => ({
        id: 8,
        role: `notice`,
        text: `Watching for CI run 316 on intentic/intentic, checked every 60s.`,
        noticeWait: `watch`,
        noticeWaitId: `watch-2`,
        noticeAction: `watchStop`,
    });

    const armed = (over: Partial<AgentWatch> = {}): AgentWatch => ({
        id: `watch-2`,
        note: `CI run 316 on intentic/intentic`,
        intervalSeconds: 60,
        deadlineAt: Date.now() + 90 * 60_000,
        ...over,
    });

    it(`draws a wake as a notice line, never as a prompt the user could edit`, () => {
        const element = mount(wakeRow());
        expect(element.querySelector(`.chat-prompt`)).toBeNull();
        expect(element.querySelector(`button[aria-label="Edit this message"]`)).toBeNull();
        expect(element.textContent).toContain(`CI run 316 on intentic/intentic — the watch fired after 43m.`);
    });

    // The board marks a watch with `eye` (AgentsView's Stop watching command); one conversation's watch reading as two
    // different things in two places is how a reader stops connecting them.
    it(`marks a settled wake with the board's own watch glyph`, () => {
        const icons = [...mount(wakeRow()).querySelectorAll(`i`)].map((icon) => icon.getAttribute(`data-icon`));
        expect(icons).toContain(`eye`);
        expect(icons).not.toContain(`info-circle`);
    });

    it(`keeps the check out of the reading column until it is asked for, then shows what was actually sent`, async () => {
        const element = mount(wakeRow());
        expect(element.querySelector(`pre`)).toBeNull();

        element.querySelector<HTMLButtonElement>(`button[aria-expanded="false"]`)!.click();
        await nextTick();

        // Verbatim, not a summary: the exit code and the check's own tail are the evidence for a line nobody typed.
        expect(element.querySelector(`pre`)?.textContent).toBe(WAKE);
        expect(element.querySelector(`pre`)?.textContent).toContain(`Last exit code: 0`);
    });

    // The one ending that calls for a different next step, so it is the one that carries weight rather than reading as
    // the good news beside it.
    it(`weights a watch that gave up differently from one that fired`, () => {
        const gaveUp = watchWakePrompt({
            outcome: `timeout`,
            id: `watch-2`,
            note: `the deploy`,
            elapsed: `2h`,
            command: `curl -sf https://example.test/health`,
            exitCode: 22,
            output: ``,
        });
        expect(mount(wakeRow(gaveUp)).querySelector(`.text-danger`)).not.toBeNull();
        expect(mount(wakeRow()).querySelector(`.text-danger`)).toBeNull();
    });

    it(`counts an armed watch down to its deadline, so the row says when the chat next moves`, () => {
        roster.watches = [armed()];
        const element = mount(armedRow());
        expect(element.querySelector(`i[data-spin]`)).not.toBeNull();
        expect(element.textContent).toContain(`1h 30m`);
    });

    // Without the row's own id every armed watch settles when any one of them does, and a chat still parked on a
    // deploy would read as finished.
    it(`settles a row whose own watch is gone, while another stays armed`, () => {
        roster.watches = [armed({ id: `watch-7`, note: `the deploy` })];
        const element = mount(armedRow());
        expect(element.querySelector(`i[data-spin]`)).toBeNull();
        expect(element.textContent).toContain(`Watching for CI run 316 on intentic/intentic, checked every 60s.`);
        expect(element.textContent).not.toContain(`Stop watching`);
    });

    it(`disarms the one watch the row names, leaving the conversation's others alone`, () => {
        roster.watches = [armed(), armed({ id: `watch-7`, note: `the deploy` })];
        const element = mount(armedRow());

        [...element.querySelectorAll(`button`)].find((button) => button.textContent === `Stop watching`)!.click();

        expect(stopWatching).toHaveBeenCalledWith(`agent-1`, `watch-2`);
    });

    it(`offers no stop on a wake, which has already happened`, () => {
        expect(mount(wakeRow()).textContent).not.toContain(`Stop watching`);
    });
});

// Low memory is a warning, not a wall: the daemon lets the next send through, so the row carries the press that makes it.
describe(`a low-memory hold`, () => {
    const hold = (noticeAction: `sendAnyway` | `sandboxMemory` = `sendAnyway`): ChatMessage => ({
        id: 21,
        role: `notice`,
        text: `Sandbox memory is low: 9.5 GiB of 10.0 GiB used. Your message is held: send it again to start anyway.`,
        noticeAction,
    });
    const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button`)];
    const sendAnyway = (element: HTMLElement): HTMLButtonElement | undefined =>
        buttons(element).find((button) => button.textContent?.trim() === `Send anyway`);
    // By its lead words, so a withdrawal cannot pass on a changed size alone.
    const raise = (element: HTMLElement): HTMLButtonElement | undefined =>
        buttons(element).find((button) => button.textContent?.trim().startsWith(`Raise its memory to`) === true);
    const remount = (row: ChatMessage): HTMLElement => {
        app?.unmount();
        document.body.innerHTML = ``;
        return mount(row);
    };

    beforeEach(() => {
        pane.streaming = false;
        pane.queued = [{ id: `held`, text: `fix the flaky test` }];
        selfEngine.value = ROOMY_ENGINE;
    });

    it(`sends the held message on one press, with no raise on a hold that named no ceiling`, () => {
        const row = hold();
        pane.messages = [row];
        const element = mount(row);

        expect(raise(element)).toBeUndefined();
        sendAnyway(element)!.click();

        expect(resume).toHaveBeenCalledTimes(1);
    });

    it(`offers the send beside the raise on a hold that named a ceiling`, () => {
        const row = hold(`sandboxMemory`);
        pane.messages = [row];
        const element = mount(row);

        // 16 GiB now plus the component's 4 GiB step, well under this engine's 64.
        expect(raise(element)?.textContent?.trim()).toBe(`Raise its memory to 20 GiB`);
        sendAnyway(element)!.click();

        expect(resume).toHaveBeenCalledTimes(1);
    });

    // The WSL guest's 19.53 GiB engine derives exactly the 16 this box has; the raise reaches into its reserve.
    it(`offers a raise past the derived share, up to the engine's own size`, () => {
        selfEngine.value = { memoryBytes: 20479632 * 1024, cpus: 16 };
        const row = hold(`sandboxMemory`);
        pane.messages = [row];
        const element = mount(row);

        expect(raise(element)?.textContent?.trim()).toBe(`Raise its memory to 19 GiB`);
    });

    it(`withdraws the raise, and keeps the send, once the cap already reaches the engine's size`, () => {
        selfEngine.value = { memoryBytes: 16.5 * 1024 ** 3, cpus: 16 };
        const row = hold(`sandboxMemory`);
        pane.messages = [row];
        const element = mount(row);

        expect(raise(element)).toBeUndefined();
        expect(sendAnyway(element)?.textContent?.trim()).toBe(`Send anyway`);
    });

    // The raise promises the message waits through the restart: false once it has gone, and a restart kills a live turn.
    it(`withdraws both presses once the conversation has moved past the warning`, () => {
        const row = hold(`sandboxMemory`);
        pane.messages = [row, { id: 22, role: `user`, text: `fix the flaky test` }];
        const element = mount(row);

        expect(sendAnyway(element)).toBeUndefined();
        expect(raise(element)).toBeUndefined();
    });

    // The bug this exists for: a fix press the sandbox started was turned away, and with no composer ever holding its
    // prompt the press never showed. The sandbox keeps those words, so the press stands with nothing queued here.
    it(`offers the send on a turn the sandbox kept, with nothing queued, and asks the sandbox to run it`, () => {
        const opener: ChatMessage = { id: 20, role: `user`, text: `The CI pipeline failed. Investigate and fix it.`, run: `run-1` };
        const row: ChatMessage = { ...hold(`sandboxMemory`), sandboxHeld: true, run: `run-1` };
        pane.messages = [opener, row];
        pane.queued = [];
        const element = mount(row);

        expect(raise(element)?.textContent?.trim()).toBe(`Raise its memory to 20 GiB`);
        sendAnyway(element)!.click();

        expect(resendKept).toHaveBeenCalledWith({ text: opener.text, attachments: [] });
        expect(resume).not.toHaveBeenCalled();
    });

    it(`offers to send again a turn the sandbox kept past a refusal no raise would clear`, () => {
        const opener: ChatMessage = { id: 20, role: `user`, text: `Carry the parser fix`, attachments: [`notes/plan.md`], run: `run-2` };
        const row: ChatMessage = {
            id: 21,
            role: `notice`,
            text: `Claude sign-in was revoked. Nothing has run yet: the message above is kept here to send again once that is sorted.`,
            noticeAction: `sendAgain`,
            sandboxHeld: true,
            run: `run-2`,
        };
        pane.messages = [opener, row];
        pane.queued = [];
        const element = mount(row);

        expect(sendAnyway(element)).toBeUndefined();
        buttons(element)
            .find((button) => button.textContent?.trim() === `Send again`)!
            .click();

        expect(resendKept).toHaveBeenCalledWith({ text: opener.text, attachments: [{ name: `plan.md`, path: `notes/plan.md` }] });
    });

    it(`withdraws both presses with nothing held to send, or a turn already running`, () => {
        const row = hold(`sandboxMemory`);
        pane.messages = [row];
        pane.queued = [];
        const empty = mount(row);
        expect(sendAnyway(empty)).toBeUndefined();
        expect(raise(empty)).toBeUndefined();

        pane.queued = [{ id: `held`, text: `fix the flaky test` }];
        pane.streaming = true;
        const running = remount(row);
        expect(sendAnyway(running)).toBeUndefined();
        expect(raise(running)).toBeUndefined();
    });
});
