// @vitest-environment jsdom
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import { resetAgents } from "../fleet/useAgents";
import { setAgents } from "../fleet/useAgents-registry";
import { router } from "../../../router";
import AgentsView from "./AgentsView.vue";
import { IconStub } from "@intentic/ui/testing";

interface RecordedAnimation {
    element: Element;
    keyframes: Keyframe[];
    options: KeyframeAnimationOptions;
}

const animations: RecordedAnimation[] = [];

let app: App | undefined;
const mountBoard = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(AgentsView) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

const NO_ATTENTION: AgentSummary["attention"] = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

const agent = (id: string, status: AgentSummary["status"], attention = NO_ATTENTION): AgentSummary => ({
    id,
    title: `agent ${id}`,
    status,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention,
});

beforeEach(() => {
    animations.length = 0;
    resetAgents();

    globalThis.Element.prototype.animate = function (
        this: Element,
        keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
    ): Animation {
        animations.push({
            element: this,
            keyframes: Array.isArray(keyframes) ? keyframes : [],
            options: typeof options === `object` ? (options ?? {}) : { duration: options },
        });
        return {
            onfinish: null,
            cancel: vi.fn(),
            play: vi.fn(),
            pause: vi.fn(),
            finish: vi.fn(),
        } as unknown as Animation;
    };
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.restoreAllMocks();
});

it(`animates cross-lane flight with elevation and fast-deceleration easing when an agent changes lanes`, async () => {
    setAgents([agent(`a1`, `running`)], 1);
    await mountBoard();

    // Stubs distinct lane coordinates for the cross-lane vector probe.
    let laneCalls = 0;
    vi.spyOn(Element.prototype, `getBoundingClientRect`).mockImplementation(function (this: Element) {
        const lane = this.closest<HTMLElement>(`section[data-lane]`)?.dataset[`lane`];
        laneCalls += 1;
        if (lane === `active`) {
            return { left: 400, top: 100, right: 600, bottom: 200, width: 200, height: 100, x: 400, y: 100, toJSON: () => ({}) };
        }
        if (lane === `finished`) {
            return { left: 800, top: 150, right: 1000, bottom: 250, width: 200, height: 100, x: 800, y: 150, toJSON: () => ({}) };
        }
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });

    // Move agent from active to finished.
    setAgents([agent(`a1`, `landed`)], 2);
    await settle();

    expect(laneCalls).toBeGreaterThan(0);
    const flight = animations.find((anim) => anim.options.duration === 260);
    expect(flight?.options).toMatchObject({
        duration: 260,
        easing: `cubic-bezier(0.2, 0, 0, 1)`,
    });
    expect(flight?.keyframes[0]).toMatchObject({
        transform: `translate3d(-400px, -50px, 0) scale(1.02)`,
        zIndex: 40,
    });
    expect(flight?.keyframes[1]).toMatchObject({
        transform: `translate3d(0, 0, 0) scale(1)`,
    });
});

it(`skips translation physics when reduced motion is requested`, async () => {
    vi.spyOn(window, `matchMedia`).mockImplementation((query: string) => ({
        matches: query === `(prefers-reduced-motion: reduce)`,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));

    setAgents([agent(`a1`, `running`)], 1);
    await mountBoard();

    vi.spyOn(Element.prototype, `getBoundingClientRect`).mockImplementation(function (this: Element) {
        const lane = this.closest<HTMLElement>(`section[data-lane]`)?.dataset[`lane`];
        if (lane === `active`) {
            return { left: 400, top: 100, right: 600, bottom: 200, width: 200, height: 100, x: 400, y: 100, toJSON: () => ({}) };
        }
        if (lane === `finished`) {
            return { left: 800, top: 150, right: 1000, bottom: 250, width: 200, height: 100, x: 800, y: 150, toJSON: () => ({}) };
        }
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });

    setAgents([agent(`a1`, `landed`)], 2);
    await settle();

    expect(animations).toHaveLength(0);
});

it(`animates sibling reflow within the same lane when a neighboring card leaves`, async () => {
    setAgents([agent(`a1`, `running`), agent(`a2`, `running`)], 1);
    await mountBoard();

    // Sibling a2 starts at top: 220, then shifts up to top: 100 once a1 finishes.
    vi.spyOn(Element.prototype, `getBoundingClientRect`).mockImplementation(function (this: Element) {
        const lane = this.closest<HTMLElement>(`section[data-lane]`)?.dataset[`lane`];
        const label = this.getAttribute(`aria-label`) ?? ``;
        if (lane === `active`) {
            if (label.includes(`agent a1`)) {
                return { left: 400, top: 100, right: 600, bottom: 200, width: 200, height: 100, x: 400, y: 100, toJSON: () => ({}) };
            }
            if (label.includes(`agent a2`)) {
                // If a1 is still running, a2 is below it at top 220; after a1 leaves, a2 is at top 100.
                const top = document.querySelector(`[aria-label="Focus agent: agent a1"]`)?.closest(`section[data-lane="active"]`) ? 220 : 100;
                return { left: 400, top, right: 600, bottom: top + 100, width: 200, height: 100, x: 400, y: top, toJSON: () => ({}) };
            }
        }
        if (lane === `finished`) {
            return { left: 800, top: 100, right: 1000, bottom: 200, width: 200, height: 100, x: 800, y: 100, toJSON: () => ({}) };
        }
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });

    // Move a1 to finished, leaving a2 in active
    setAgents([agent(`a1`, `landed`), agent(`a2`, `running`)], 2);
    await settle();

    const reflow = animations.find((anim) => anim.options.duration === 220);
    expect(reflow?.options).toMatchObject({
        duration: 220,
        easing: `cubic-bezier(0.2, 0, 0, 1)`,
    });
    expect(reflow?.keyframes[0]).toMatchObject({
        transform: `translate3d(0, 120px, 0)`,
    });
    expect(reflow?.keyframes[1]).toMatchObject({
        transform: `translate3d(0, 0, 0)`,
    });
});
