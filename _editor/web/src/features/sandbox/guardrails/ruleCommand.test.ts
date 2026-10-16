import "@intentic/testing/dom";
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

it(`renders the rule command as code`, () => {
    const host = mount(`node _tools/oxlint/lint-edit.mjs {file}`);
    expect(host.querySelector(`code`)?.textContent).toBe(`node _tools/oxlint/lint-edit.mjs {file}`);
});

// Each coloured span carries Shiki's dark value inline, which is what code.css's one dark-mode rule keys off.
it(`tokenizes command into syntax-colored spans, each with its dark value`, async () => {
    const host = mount(`node _tools/oxlint/lint-edit.mjs {file}`);
    const until = performance.now() + 10_000;
    const coloured = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`code span`)].filter((span) => span.style.color !== ``);
    while (coloured().length === 0 && performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const spans = coloured();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((span) => span.style.getPropertyValue(`--shiki-dark`) !== ``)).toBe(true);
});
