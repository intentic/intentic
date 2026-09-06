// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import RuleCommand from "./RuleCommand.vue";

let app: App | undefined;

const mount = (command: string): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(RuleCommand, { command }) });
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`renders the rule command with the syntax highlighting hook`, () => {
    const host = mount(`node .intentic/config/hooks/lint-edit.mjs {file}`);
    const code = host.querySelector(`code`);
    expect(code).not.toBeNull();
    expect(code?.className).toContain(`rule-command-code`);
});

it(`tokenizes command into syntax-colored spans`, async () => {
    const host = mount(`node .intentic/config/hooks/lint-edit.mjs {file}`);
    const until = performance.now() + 10_000;
    const coloured = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`code span`)].filter((span) => span.style.color !== ``);
    while (coloured().length === 0 && performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const spans = coloured();
    expect(spans.length).toBeGreaterThan(0);
});
