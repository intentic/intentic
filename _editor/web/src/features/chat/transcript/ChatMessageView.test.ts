// @vitest-environment jsdom
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { ERRANDS, errandPrompt } from "../run/errands";
import type { ChatMessage } from "./transcript";
import { IconStub } from "@intentic/ui/testing";

const clock = vi.hoisted(() => ({ turnStartedAt: undefined as number | undefined }));
const roster = vi.hoisted(() => ({ running: 0 }));
// Pane state the edit pencil reads: mid-turn streaming and this message's own armed edit both hide it.
const pane = vi.hoisted(() => ({ streaming: true, editing: undefined as ChatMessage | undefined }));
const beginEdit = vi.hoisted(() => vi.fn());
// Hoisted rather than fresh per call, so a card's answer can be read back from the one the pane actually holds.
const answerQuestion = vi.hoisted(() => vi.fn());
// What useMarkdown hands the row under test (prose runs, figures); empty unless the test is about the answer body.
const markdown = vi.hoisted(() => ({
    parts: [] as { readonly kind: string; readonly html?: string; readonly figure?: { readonly kind: string } }[],
}));

// Every ResizeObserver a mounted row builds, with the boxes it watches. jsdom has no layout to fire one, so the pinned
// band's suite fires the row's own by hand; the others are left alone and never fire, as before.
const resizers = vi.hoisted(() => [] as { readonly targets: Element[]; readonly fire: () => void }[]);

vi.hoisted(() => {
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
            this.targets.push(target);
        }
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.ResizeObserver;
});

// Imported as a namespace since this file already binds `h`/`defineComponent`, which a destructured factory would
// shadow.
vi.mock("@intentic/ui", async () => {
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
    };
});
// Stub renders one prose run naming its source, enough to tell a drawn document from a folded one without a real
// parser.
vi.mock("@intentic/ui/markdown", () => ({
    copyCodeFromEvent: vi.fn(),
    renderMarkdownParts: (source: string) => [{ kind: `html`, html: `<p>${source}</p>` }],
}));
// `withoutResumeNote` stays real, since the errand row depends on it to recognize a resumed turn's re-sent errand.
// Rides on the real contract with only `planParts` stubbed, since hand-listing exports breaks on every addition to the
// contract's vocabulary.
vi.mock("@intentic/sandbox-contract", async (importActual) => ({
    ...(await importActual<typeof import("@intentic/sandbox-contract")>()),
    planParts: (text: string) => ({ body: text }),
}));
vi.mock("../drafts/attachmentPreviews", () => ({ attachmentPreview: () => undefined }));
// formatElapsed stays real, since the loader's readout is exactly that format.
vi.mock("../../agents/fleet/agentStatus", async () => {
    const { formatElapsed } = await vi.importActual<typeof import("../../agents/fleet/agentStatus")>("../../agents/fleet/agentStatus");
    return { effectiveAutoLand: () => false, effectiveOutageResume: () => false, formatElapsed };
});
vi.mock("./transcript", async () => {
    const { errandOf } = await vi.importActual<typeof import("../run/errands")>("../run/errands");
    return { foldsIntoTurn: (message: ChatMessage) => errandOf(message) !== undefined };
});
vi.mock("../../../lib/markdown/useMarkdown", async () => {
    const { computed } = await import("vue");
    return { useMarkdown: () => computed(() => markdown.parts) };
});
vi.mock("../../workspace/files/openFileRef", () => ({ openFileRefFromEvent: vi.fn() }));
vi.mock("../../workspace/changes/useHistory", () => ({ restoreSnapshot: vi.fn() }));
vi.mock("../tools/toolGrouping", () => ({ groupConsecutiveTools: () => [] }));
vi.mock("../composer/ChatAttachmentStrip.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatTodoList.vue", () => ({ default: { render: () => undefined } }));
vi.mock("../tools/ChatToolCard.vue", () => ({ default: { render: () => undefined } }));
vi.mock("../tools/ChatToolGroup.vue", () => ({ default: { render: () => undefined } }));

// Stubs the pane's own view, not the focused one (useChat's PANE_VIEW), since this row reads its pane's conversation.
vi.mock("../panel/useChat-view", async () => {
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
            answerQuestion,
            cancelQuestion: vi.fn(),
            decidePermission: vi.fn(),
            streaming: computed(() => pane.streaming),
            awaitingDecision: ref(false),
            // isDeciding always false, so the card's buttons stay offered in every mount here.
            isDeciding: () => false,
            editing: computed(() => pane.editing),
            beginEdit,
        }),
    };
});

// Roster count of this conversation's live subagents, which the loader reports waiting on.
vi.mock("../../agents/fleet/useAgents", () => ({
    useAgents: () => ({
        agentById: () => ({ subagents: { running: roster.running, total: roster.running } }),
        setAutoLand: vi.fn(),
        setResumeAfterOutage: vi.fn(),
    }),
}));

vi.mock("../../sandbox/overview/useSandboxSettings", async () => {
    const { ref } = await import("vue");
    return {
        useSandboxSettings: () => ({ settings: ref(undefined), save: { mutateAsync: vi.fn() } }),
    };
});

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
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    clock.turnStartedAt = Date.now() - 35_000;
    roster.running = 0;
    markdown.parts = [];
    pane.streaming = true;
    pane.editing = undefined;
    beginEdit.mockClear();
    resizers.length = 0;
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

    it(`reads long turns in minutes and hours rather than a growing second count`, () => {
        clock.turnStartedAt = Date.now() - 525_000;
        expect(mount().textContent).toContain(`(8m 45s)`);

        app?.unmount();
        app = undefined;
        clock.turnStartedAt = Date.now() - 3_960_000;
        expect(mount().textContent).toContain(`(1h 6m)`);
    });

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

    // Write-up the question refers to, attached to the card by the daemon (agent.ts).
    const document = { path: `docs/findings.md`, title: `Why it is slow`, markdown: `# Why it is slow` };

    it(`draws the document a question is about, inside the card, open`, () => {
        const element = mount({ ...ask(false), question: { ...ask(false).question!, document } });
        expect(element.textContent).toContain(`Why it is slow`);
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
        expect(answerQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), {
            "Which surfaces should the banner appear on?": [`Chat`, `Only the release notes page`],
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
        expect(element.textContent).toContain(`Shortened for this card`);
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
    const errand = ERRANDS.landConflict;
    const prompt = errandPrompt(errand, [`What blocked the land:\nroot\n  - src/auth/session.ts`]);

    it(`names the errand and keeps its prompt one press away rather than on screen`, async () => {
        const element = mount({ id: 2, role: `user`, text: prompt });
        expect(element.textContent).toContain(errand.label);
        expect(element.textContent).toContain(errand.detail);
        expect(element.textContent).not.toContain(`src/auth/session.ts`);
        expect(element.querySelector(`.chat-prompt`)).toBeNull();

        element.querySelector(`button`)?.click();
        await nextTick();
        expect(element.textContent).toContain(`src/auth/session.ts`);
    });
});

// Notes row: same bargain as the errand row, for daemon-prepended context; collapsed by default, openable to the
// verbatim text.
describe(`ChatMessageView added-notes row`, () => {
    const notes = [
        { title: `How to read this message`, text: `## Reading the message below\n\nIt opens with a slash but names no command.` },
        { title: `Dependencies are behind`, text: `Some dependencies declared under /work are not installed.` },
    ];

    it(`names every note and keeps the words the agent got one press away`, async () => {
        const element = mount({ id: 3, role: `user`, text: `fix the bug`, notes });

        expect(element.textContent).toContain(notes[0]!.title);
        expect(element.textContent).toContain(notes[1]!.title);
        expect(element.textContent).not.toContain(notes[0]!.text);

        element.querySelector(`[aria-expanded]`)?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await nextTick();
        expect(element.textContent).toContain(`It opens with a slash but names no command.`);
        expect(element.textContent).toContain(notes[1]!.text);
        expect(element.textContent).not.toContain(`##`);
        expect(element.textContent).not.toContain(`Reading the message below`);
    });

    it(`sits outside the prompt, so it never rides in the pinned band`, () => {
        const element = mount({ id: 6, role: `user`, text: `fix the bug`, notes });

        const pill = element.querySelector(`[aria-expanded]`);
        expect(pill).not.toBeNull();
        expect(pill!.closest(`.chat-prompt`)).toBeNull();
        expect(element.querySelector(`.chat-prompt`)).not.toBeNull();
    });

    it(`stays out of the way of an ordinary message`, () => {
        expect(mount({ id: 5, role: `user`, text: `fix the bug` }).textContent).not.toContain(`Sent with your message`);
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

// Edit pencil arms the composer against this message rather than committing anything (Conversation.editing); a click
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
});
