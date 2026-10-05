// Pins that the dark-mode color flip actually applies: the `--shiki-dark` every coloured span carries inline and the
// code.css rule keying off it are two halves of one contract, tested together since either alone fails silently.
import "@intentic/testing/dom";
import { repoRoot } from "@intentic/constants/node";
import type { ProgramAsk } from "@intentic/sandbox-contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type App, createApp, h } from "vue";
import ChatCommandBlock from "./ChatCommandBlock.vue";
import { IconStub } from "@intentic/ui/testing";

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
    // Registered app-wide in the real app; reached only via the show-all toggle, absent on a short program.
    app.component(`Icon`, IconStub);
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`flips those tokens to their dark value in dark mode, over the inline light one`, () => {
    // The kit's one rule for every place Shiki's dual theme is drawn, keyed to the `--shiki-dark` each token carries
    // inline (pinned below). Requires `!important`, since without it the inline light `color` would win.
    const css = readFileSync(join(repoRoot(import.meta.url), `_editor/ui/src/styles/code.css`), `utf8`);
    expect(css).toMatch(/\[data-mode="dark"\]\s*\[style\*="--shiki-dark"\]\s*\{[^{}]*color:\s*var\(--shiki-dark\)\s*!important/);
});

// The dark var only exists once Shiki's grammar loads for this language; an unsupported language renders
// plain, which isn't a failure.
it(`carries a dark value on every coloured span`, async () => {
    const element = mount(PROGRAM);
    // Grammar loads via dynamic import, bounded by contention under a busy suite; deadline stays well inside
    // testTimeout.
    const until = performance.now() + 10_000;
    const coloured = (): HTMLElement[] => [...element.querySelectorAll<HTMLElement>(`pre span`)].filter((span) => span.style.color !== ``);
    while (coloured().length === 0 && performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const spans = coloured();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((span) => span.style.getPropertyValue(`--shiki-dark`) !== ``)).toBe(true);
});
