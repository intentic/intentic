// @vitest-environment jsdom
//
/* THE CHIP AS A PERSON MEETS IT: what each state says, and that the press is the whole chip. The decision behind
 * it (whether there is a reading, which mode) is personaRoute's and has its own suite; this only checks that
 * what it decided is legible without a hover. */
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h } from "vue";
import type { PersonaRoutePreview } from "../personas/personaRoute";
import { IconStub } from "@intentic/ui/testing";

const { default: ComposerPersonaChip } = await import("./ComposerPersonaChip.vue");

const backend = { id: `backend`, label: `Backend`, capabilities: [] };
const press = vi.fn();

let app: App | undefined;
const mount = (preview: PersonaRoutePreview | undefined): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(ComposerPersonaChip, { preview, onPress: press }) });
    app.component(`Icon`, IconStub);
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    press.mockClear();
});

test("no reading draws nothing", () => {
    expect(mount(undefined).textContent).toBe(``);
});

test("an offer asks in words and says on the button what a press does", () => {
    const host = mount({ kind: `suggest`, persona: backend, reason: `The message reads like Backend's work.` });
    const button = host.querySelector(`button`)!;
    expect(button.textContent).toContain(`Act as Backend?`);
    expect(button.getAttribute(`aria-label`)).toBe(
        `This message looks like Backend's work. The message reads like Backend's work. Press to act as Backend: only its accounts and repositories in reach, on its model.`,
    );
    button.click();
    expect(press).toHaveBeenCalledTimes(1);
});

test("a card about to go on names itself, and the held state names its undo", () => {
    expect(mount({ kind: `route`, persona: backend, reason: `` }).querySelector(`button`)!.getAttribute(`aria-label`)).toBe(
        `When you send, this chat will act as Backend. Press to keep it as everyone.`,
    );
    app?.unmount();
    document.body.innerHTML = ``;
    const held = mount({ kind: `held`, persona: backend, reason: `` }).querySelector(`button`)!;
    expect(held.textContent).toContain(`Everyone`);
    expect(held.textContent).toContain(`Undo`);
    expect(held.getAttribute(`aria-label`)).toBe(`Kept as everyone rather than Backend. Press to let it act as Backend after all.`);
});
