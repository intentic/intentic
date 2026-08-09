// @vitest-environment jsdom
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { ERRANDS, errandPrompt } from "../composables/chat/errands";
import type { ChatMessage } from "../composables/chat/transcript";

const clock = vi.hoisted(() => ({ turnStartedAt: undefined as number | undefined }));
const roster = vi.hoisted(() => ({ running: 0 }));

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    /* The prompt bubble watches its own box twice — a ResizeObserver for whether the clamp is doing anything, an
     * IntersectionObserver for whether it has stuck to the top of the scroller. jsdom has layout for neither.
     * Stubs that never fire leave both flags at their defaults, which is exactly what the component shows before
     * its first measurement, so a user bubble renders here as it does on screen the instant it mounts. */
    const idle = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.ResizeObserver ??= idle;
    globalThis.IntersectionObserver ??= idle as unknown as typeof globalThis.IntersectionObserver;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

vi.mock("@intentic/ui", async () => {
    const { ref } = await import("vue");
    return { useDevice: () => ({ mobile: ref(false) }) };
});
vi.mock("@intentic/ui/markdown", () => ({ copyCodeFromEvent: vi.fn() }));
// withoutResumeNote is the real behaviour, not a stub: the errand row depends on it to recognise an errand a
// resumed turn re-sent (errands.ts), and a mock that returned the text unchanged would hide that.
vi.mock("@intentic/sandbox-contract", async () => {
    const { GrantedRoleSchema, MemberRoleSchema, roleAtLeast, withoutResumeNote } =
        await vi.importActual<typeof import("@intentic/sandbox-contract")>("@intentic/sandbox-contract");
    // The role vocabulary rides along real: api-contract's schemas evaluate MemberRoleSchema/GrantedRoleSchema
    // at module load, so a mock without them kills every import graph that touches the platform contract.
    return { planParts: (text: string) => ({ body: text }), GrantedRoleSchema, MemberRoleSchema, roleAtLeast, withoutResumeNote };
});
vi.mock("../composables/chat/attachmentPreviews", () => ({ attachmentPreview: () => undefined }));
// formatElapsed is the real one — the loader's readout IS that format, so mocking it would test nothing.
vi.mock("../composables/agents/agentStatus", async () => {
    const { formatElapsed } = await vi.importActual<typeof import("../composables/agents/agentStatus")>("../composables/agents/agentStatus");
    return { effectiveAutoLand: () => false, formatElapsed };
});
vi.mock("../composables/chat/transcript", async () => {
    const { errandOf } = await vi.importActual<typeof import("../composables/chat/errands")>("../composables/chat/errands");
    return { foldsIntoTurn: (message: ChatMessage) => errandOf(message) !== undefined };
});
vi.mock("../composables/useMarkdown", async () => {
    const { computed } = await import("vue");
    return { useMarkdown: () => computed(() => ({ settled: ``, tail: `` })) };
});
vi.mock("../composables/workspace/openFileRef", () => ({ openFileRefFromEvent: vi.fn() }));
vi.mock("../composables/workspace/useHistory", () => ({ restoreSnapshot: vi.fn() }));
vi.mock("./toolGrouping", () => ({ groupConsecutiveTools: () => [] }));
vi.mock("./ChatAttachmentStrip.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatTodoList.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatToolCard.vue", () => ({ default: { render: () => undefined } }));
vi.mock("./ChatToolGroup.vue", () => ({ default: { render: () => undefined } }));

// The row reads its PANE's conversation, not the focused one (useChat's PANE_VIEW) — so what stands in for the
// store here is the pane's view, and `conversation` is the chat this row belongs to.
vi.mock("../composables/chat/useChat", async () => {
    const { ref, shallowRef } = await import("vue");
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
            streaming: ref(true),
            awaitingDecision: ref(false),
        }),
    };
});

// The roster's count of this conversation's live children — what the loader says it is waiting on.
vi.mock("../composables/agents/useAgents", () => ({
    useAgents: () => ({ agentById: () => ({ subagents: { running: roster.running, total: roster.running } }), setAutoLand: vi.fn() }),
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

const mount = (subject: ChatMessage = message): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatMessageView, { message: subject, streaming: true }) });
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
     * end is agents working elsewhere. "Percolating… (6m 12s)" over that reads as a model that has hung — so
     * the line says what it is actually waiting for, and goes back to the words once they are all in. */
    it(`names the children it is waiting on instead of cycling a word`, () => {
        roster.running = 2;
        expect(mount().textContent).toContain(`Waiting on 2 subagents…`);
    });

    it(`says one child in the singular`, () => {
        roster.running = 1;
        expect(mount().textContent).toContain(`Waiting on 1 subagent…`);
    });

    it(`goes back to the cycling word once they are all in`, () => {
        expect(mount().textContent).not.toContain(`Waiting on`);
    });

    // The counter ticks off a `now` the interval refreshes — a turn whose start is unknown gets no parenthetical
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

    // Picks are mirrored to localStorage per requestId — each case starts from an empty card.
    afterEach(() => localStorage.clear());

    it(`offers a multi-select question as a checkbox list and counts the picks back`, async () => {
        const element = mount(ask(true));
        expect(element.textContent).toContain(`Select all that apply`);
        expect(element.querySelector(`[role="group"]`)).not.toBeNull();
        expect(marks(element)).toEqual([`square`, `square`, `square`]);

        const rows = [...element.querySelectorAll<HTMLButtonElement>(`button[role="checkbox"]`)];
        rows[0]?.click();
        rows[1]?.click();
        await nextTick();

        // Both picks stand — and the line says so, which is what tells a user habituated to radios that the
        // second click was not going to cost them the first.
        expect(marks(element)).toEqual([`check-square`, `check-square`, `square`]);
        expect(rows[0]?.getAttribute(`aria-checked`)).toBe(`true`);
        expect(element.textContent).toContain(`2 selected`);
    });

    it(`keeps a single-select question round, silent, and one-pick-at-a-time`, async () => {
        const element = mount(ask(false));
        expect(element.textContent).not.toContain(`Select all that apply`);
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
 * the agent actually got are behind one press rather than gone — the audit trail is the whole reason this is a
 * fold rather than a suppression. */
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

/* THE NOTES ROW — the same bargain the errand row strikes, for text the daemon put in FRONT of the user's
 * message rather than instead of it. Collapsed so a turn that was told four things does not bury the answer;
 * openable because an agent visibly acting on instructions the reader cannot reach is the thing this replaces. */
describe(`ChatMessageView added-notes row`, () => {
    const notes = [
        { title: `Your workspace moved on underneath this agent`, text: `## Your branch moved onto newer main\n\nRe-read src/auth/session.ts.` },
        { title: `Dependencies are behind`, text: `Some dependencies declared under /work are not installed.` },
    ];

    it(`names every note and keeps the words the agent got one press away`, async () => {
        const element = mount({ id: 3, role: `user`, text: `fix the bug`, notes });

        // Titles up front, so the reader knows what the turn was told without opening anything…
        expect(element.textContent).toContain(`Your workspace moved on underneath this agent`);
        expect(element.textContent).toContain(`Dependencies are behind`);
        // …and their words are collapsed, not absent.
        expect(element.textContent).not.toContain(`Re-read src/auth/session.ts.`);

        element.querySelector(`[aria-expanded]`)?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await nextTick();
        expect(element.textContent).toContain(`Re-read src/auth/session.ts.`);
        expect(element.textContent).toContain(`Some dependencies declared under /work are not installed.`);
        // The note's own `##` heading is written for a model reading markdown. Under a row that already names
        // the note it is raw syntax and a duplicate title, so it is the one line not drawn.
        expect(element.textContent).not.toContain(`##`);
        expect(element.textContent).not.toContain(`Your branch moved onto newer main`);
    });

    // The mid-turn note rides a notice with nothing of its own to say. The empty line must not draw.
    it(`draws a note-only notice as the row alone, with no empty line above it`, () => {
        const element = mount({ id: 4, role: `notice`, text: ``, notes: notes.slice(0, 1) });

        expect(element.textContent).toContain(`Sent with your message`);
        expect(element.querySelectorAll(`[aria-expanded]`)).toHaveLength(1);
    });

    // A turn nobody added anything to says nothing — no row, no chevron, nothing to click.
    it(`stays out of the way of an ordinary message`, () => {
        expect(mount({ id: 5, role: `user`, text: `fix the bug` }).textContent).not.toContain(`Sent with your message`);
    });
});
