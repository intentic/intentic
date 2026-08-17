/**
 * @vitest-environment jsdom
 */
import { nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("./sandbox/activeSandbox", () => ({ activeSandboxId }));

const { resetTerminalOpen, useLayout } = await import("./useLayout");

beforeEach(() => {
    local.clear();
    session.clear();
    activeSandboxId.value = `sb1`;
    resetTerminalOpen();
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
        resetTerminalOpen();

        // sb2 should have terminal closed
        expect(layout.terminalOpen.value).toBe(false);

        // Switch back to sb1
        activeSandboxId.value = `sb1`;
        await nextTick();
        resetTerminalOpen();

        // sb1 should have terminal open restored
        expect(layout.terminalOpen.value).toBe(true);
    });

    it(`restores terminal open state when seeded in localStorage`, () => {
        local.set(`intentic.terminalOpen.sb1`, `1`);
        resetTerminalOpen();
        const layout = useLayout();
        expect(layout.terminalOpen.value).toBe(true);
    });
});
