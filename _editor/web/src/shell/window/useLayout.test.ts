import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { nextTick, ref } from "vue";
import { describe, it, expect, beforeEach, mock } from "bun:test";

const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const activeSandboxId = ref<string | undefined>(`sb1`);

mock.module("../../features/sandbox/overview/activeSandbox", () => ({ activeSandboxId }));

const { useLayout } = await import("./useLayout");

beforeEach(() => {
    local.clear();
    session.clear();
    activeSandboxId.value = `sb1`;
    resetSandboxScope();
});

describe(`sandbox-scoped terminal open state`, () => {
    it(`starts closed for a sandbox with no stored state`, () => {
        const layout = useLayout();
        expect(layout.terminalOpen.value).toBe(false);
    });

    it(`persists open state under the active sandbox's key`, () => {
        const layout = useLayout();
        layout.setTerminalOpen(true);
        expect(layout.terminalOpen.value).toBe(true);
        expect(session.get(`intentic.terminalOpen.sb1`)).toBe(`1`);
        expect(local.get(`intentic.terminalOpen.sb1`)).toBe(`1`);
    });

    it(`keeps each sandbox's terminal state isolated across switches`, async () => {
        const layout = useLayout();
        layout.setTerminalOpen(true);
        expect(layout.terminalOpen.value).toBe(true);

        // Switch to sb2
        activeSandboxId.value = `sb2`;
        await nextTick();
        resetSandboxScope();

        // sb2 should have terminal closed
        expect(layout.terminalOpen.value).toBe(false);

        // Switch back to sb1
        activeSandboxId.value = `sb1`;
        await nextTick();
        resetSandboxScope();

        // sb1 should have terminal open restored
        expect(layout.terminalOpen.value).toBe(true);
    });

    it(`writes a toggle to the sandbox on screen, not to the one the app started on`, async () => {
        const layout = useLayout();

        // The switch has landed, and something toggles the terminal before the reset watch has run.
        activeSandboxId.value = `sb2`;
        await nextTick();
        layout.setTerminalOpen(true);

        expect(session.get(`intentic.terminalOpen.sb2`)).toBe(`1`);
        expect(session.get(`intentic.terminalOpen.sb1`)).toBeUndefined();
    });

    it(`restores terminal open state when seeded in localStorage`, () => {
        local.set(`intentic.terminalOpen.sb1`, `1`);
        resetSandboxScope();
        const layout = useLayout();
        expect(layout.terminalOpen.value).toBe(true);
    });
});

// What the guest profile's first boot lands on: the profile seeds the audience and nothing else, and the technical
// filter follows it until a press records an override — so a maker who arrives by link, cookie or installer opens on a
// tree with the tooling out of the way, and one who later says "I write code" gets it back without a second switch.
describe(`technical files follow the audience until a press says otherwise`, () => {
    it(`hides them for a maker with nothing pressed, and shows them for a developer`, async () => {
        const { useAudience } = await import("../../app/useAudience");
        useAudience().setAudience(`maker`);
        expect(useLayout().hideTechnical.value).toBe(true);
        useAudience().setAudience(`developer`);
        expect(useLayout().hideTechnical.value).toBe(false);
    });

    it(`keeps a press over the audience changing under it`, async () => {
        const { useAudience } = await import("../../app/useAudience");
        useAudience().setAudience(`maker`);
        const layout = useLayout();
        layout.toggleHideTechnical();
        expect(layout.hideTechnical.value).toBe(false);
        useAudience().setAudience(`developer`);
        expect(layout.hideTechnical.value).toBe(false);
        layout.toggleHideTechnical();
        expect(layout.hideTechnical.value).toBe(true);
    });
});
