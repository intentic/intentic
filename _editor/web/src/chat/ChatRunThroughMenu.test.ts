// @vitest-environment jsdom
//
// jsdom because this picker's whole job is what it SAYS before the message goes: which of two very different
// machines the next send is handed to, what stops the one that spends money round after round, and — the thing
// the two menus it replaced could never say — that choosing either of them is choosing INSTEAD of the other.
import type { LoopDesign, Workflow } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

// The kit's barrel reaches for matchMedia at import time (its device tracker), which jsdom does not have.

const loops = ref<LoopDesign[]>([]);
const workflows = ref<Workflow[]>([]);

vi.mock(`../composables/agents/useLoopDesigns`, () => ({ useLoopDesigns: () => ({ designs: loops }) }));
vi.mock(`../composables/agents/useWorkflowRuns`, () => ({ useWorkflowRuns: () => ({ designs: workflows }) }));

const { default: ChatRunThroughMenu } = await import("./ChatRunThroughMenu.vue");

let app: App | undefined;
const picked: { loop: (string | undefined)[]; workflow: (string | undefined)[]; manage: number } = { loop: [], workflow: [], manage: 0 };

const mount = (armed: { loop?: string; workflow?: string } = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatRunThroughMenu, {
                ...armed,
                onLoop: (design: LoopDesign | undefined) => picked.loop.push(design?.id),
                onWorkflow: (design: Workflow | undefined) => picked.workflow.push(design?.id),
                onManage: () => (picked.manage += 1),
            }),
    });
    // Icon is registered app-wide in the real app.
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
    app.mount(element);
    return element;
};

const text = (element: HTMLElement): string => element.textContent ?? ``;
const rowLabelled = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));

const aLoop = (over: Partial<LoopDesign> = {}): LoopDesign => ({
    id: `green`,
    name: `Until green`,
    context: `fresh`,
    output: { kind: `none` },
    checks: [{ kind: `command`, command: `pnpm test` }],
    maxIterations: 8,
    maxSpendUsd: 5,
    stallLimit: 2,
    ...over,
});
const aWorkflow = (over: Partial<Workflow> = {}): Workflow =>
    ({ id: `duel`, name: `Two models`, steps: [{ id: `a`, needs: [], agent: `claude` }], ...over }) as Workflow;

beforeEach(() => {
    loops.value = [];
    workflows.value = [];
    picked.loop.length = 0;
    picked.workflow.length = 0;
    picked.manage = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* THE MERGE ITSELF: both kinds in one list, under headings that say what separates them. This is the whole
 * reason the control stopped being two pills — "where is the shape I saved" had two places to look before it
 * had an answer, and two bare glyphs told nobody which was which. */
it(`lists loops and workflows together, each under a heading that says what it does`, () => {
    loops.value = [aLoop()];
    workflows.value = [aWorkflow()];
    const body = text(mount());

    expect(body).toContain(`Repeat it here, until it's done`);
    expect(body).toContain(`Until green`);
    expect(body).toContain(`Hand it to other sessions`);
    expect(body).toContain(`Two models`);
});

// A heading with nothing under it is a half-empty pair, which reads as something being broken. A workspace
// with loops and no workflows should simply look like a loop picker.
it(`hides the heading of a kind this workspace has none of`, () => {
    loops.value = [aLoop()];
    const body = text(mount());

    expect(body).toContain(`Repeat it here, until it's done`);
    expect(body).not.toContain(`Hand it to other sessions`);
});

/* THE STOP CONDITION AND THE CEILINGS, on the row, computed from the loop. A control that starts paid work in
 * a loop has to say what ends it at the moment of choosing — not behind a hover no touch device will show. */
it(`says what ends a loop and how far it may go, on the row`, () => {
    loops.value = [aLoop()];
    const row = rowLabelled(mount(), `Until green`)!;

    expect(text(row)).toContain(`pnpm test`);
    expect(text(row)).toContain(`8`);
    row.click();
    expect(picked.loop).toEqual([`green`]);
});

// Why anyone keeps a workflow at all: its shape and the models it pins, neither of which survives in a name.
it(`says a workflow's shape and the models it pins`, () => {
    workflows.value = [aWorkflow({ steps: [{ id: `a`, needs: [], agent: `claude` } as never, { id: `b`, needs: [`a`], agent: `codex` } as never] })];
    const row = rowLabelled(mount(), `Two models`)!;

    expect(text(row)).toContain(`2 steps in a line`);
    expect(text(row)).toContain(`on claude · codex`);
    row.click();
    expect(picked.workflow).toEqual([`duel`]);
});

/* ONE WAY BACK, not two. "No loop" and "no workflow" were never two states a person could be in at once, and
 * the single row has to clear BOTH — otherwise unpicking depends on remembering which kind you armed. */
it(`offers one way back to an ordinary message, and it clears both kinds`, () => {
    loops.value = [aLoop()];
    workflows.value = [aWorkflow()];
    const element = mount({ workflow: `duel` });

    const off = rowLabelled(element, `Just this chat`)!;
    expect(text(off)).toContain(`Send once, as an ordinary message`);
    off.click();
    expect(picked.loop).toEqual([undefined]);
    expect(picked.workflow).toEqual([undefined]);
});

// Nothing armed is the ordinary state, and the row would then be an offer to un-pick nothing.
it(`keeps the way back out of the list while nothing is armed`, () => {
    loops.value = [aLoop()];
    expect(text(mount())).not.toContain(`Just this chat`);
});

/* Nothing saved anywhere is the ordinary state of a new workspace, and the reason this control looked like
 * decoration: the empty picker has to say what the two things ARE and offer the way to the page that makes
 * them — one door, because one page owns both. */
it(`explains the empty workspace and offers a single way in`, () => {
    const element = mount();

    expect(text(element)).toContain(`Nothing saved yet`);
    rowLabelled(element, `Set one up`)!.click();
    expect(picked.manage).toBe(1);
});
