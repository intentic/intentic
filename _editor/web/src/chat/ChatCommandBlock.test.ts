// @vitest-environment jsdom
//
/* THE CARD'S COMMAND HAS TO BE READABLE IN THE SCHEME IT IS BEING READ IN, and that is a contract split across
 * two files — which is exactly how it broke.
 *
 * Shiki colours every token twice: an inline `color` carrying the LIGHT theme's value, and a `--shiki-dark`
 * custom property beside it carrying the dark one. Nothing switches between them on its own. A stylesheet rule
 * has to say, for this surface, "in dark mode take the other one" — and because the light value arrives as an
 * inline style, that rule needs `!important` to be heard at all.
 *
 * This block shipped without one. In dark mode it painted light-plus on a near-black ground: #000000 pipes and
 * redirections at 1.07:1 against their own background (invisible), #a31515 paths at 1.95:1, #0000ff flags at
 * 1.76:1 — a card asking someone to approve a destructive command, rendered in colours picked to be read on
 * white. Nothing failed; there is no test a component can fail by being unreadable.
 *
 * So the halves are pinned together here, in one file, because neither is worth anything alone: the class the
 * <pre> renders, and the rule in chat.css that keys off it. Rename one and this fails; delete the other and
 * this fails. */
import type { ProgramAsk } from "@intentic/sandbox-contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";
import ChatCommandBlock from "./ChatCommandBlock.vue";

// The hook the two halves meet on. Spelled once, asserted on both sides.
const HOOK = `chat-command-block`;

const PROGRAM: ProgramAsk = {
    text: `rm -rf /tmp/film-ws && node /tmp/film-ws.mjs 60 2>&1 | tail -25`,
    language: `bash`,
    truncated: false,
    spans: [{ start: 0, end: 19 }],
};

let app: App | undefined;
const mount = (program: ProgramAsk): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatCommandBlock, { program }) });
    // Registered app-wide in the real app; only reached by the show-all toggle, which a short program has none of.
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`renders the command under the class dark mode's colour flip keys off`, () => {
    const pre = mount(PROGRAM).querySelector(`pre`);
    expect(pre?.className).toContain(HOOK);
});

it(`flips those tokens to their dark value in dark mode, over the inline light one`, () => {
    const css = readFileSync(join(import.meta.dirname, `chat.css`), `utf8`);
    // The rule, in one piece: dark mode, this block's spans, the dark var, and the `!important` without which
    // an inline `color` beats it and the whole thing is decoration.
    const rule = new RegExp(String.raw`\[data-mode="dark"\][^{}]*\.${HOOK}[^{}]*\{[^{}]*var\(--shiki-dark\)\s*!important`);
    expect(css).toMatch(rule);
});

/* AND THE COLOURS HAVE TO ACTUALLY ARRIVE. The rule above can only flip a variable that is there: it is Shiki
 * that puts `--shiki-dark` on each span, and only for a language a grammar was loaded for. A program in a
 * language we ship none for renders plain — legible, just uncoloured — so the failure this catches is the
 * silent one where the grammar never lands and the flip has nothing to read. */
it(`carries a dark value on every coloured span`, async () => {
    const element = mount(PROGRAM);
    // The grammar is a dynamic import, and under a busy suite it is bounded by contention rather than by work
    // (see vitest.config.ts) — hence a deadline well inside `testTimeout` rather than a fixed sleep.
    const until = performance.now() + 10_000;
    const coloured = (): HTMLElement[] => [...element.querySelectorAll<HTMLElement>(`pre span`)].filter((span) => span.style.color !== ``);
    while (coloured().length === 0 && performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const spans = coloured();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((span) => span.style.getPropertyValue(`--shiki-dark`) !== ``)).toBe(true);
});
