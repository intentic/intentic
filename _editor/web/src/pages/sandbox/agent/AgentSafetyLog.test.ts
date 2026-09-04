// @vitest-environment jsdom
import type { SafetyLogEntry, SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const entries = ref<SafetyLogEntry[]>([]);
const isLoading = ref(false);
const error = ref<string | undefined>(undefined);

vi.mock(`../../../composables/sandbox/useSafetyPolicy`, () => ({
    useSafetyLog: () => ({ entries, isLoading, error }),
}));

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch: vi.fn(), dropped: ref(undefined), error: ref(undefined), isLoading: ref(false) }),
}));

const { default: AgentSafetyLog } = await import("./AgentSafetyLog.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSafetyLog) });
    app.use(PrimeVue);
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    entries.value = [];
    isLoading.value = false;
    error.value = undefined;
    settings.value = SandboxSettingsSchema.parse({});
});

describe(`AgentSafetyLog`, () => {
    it(`shows the empty state when nothing has needed judging`, () => {
        const host = mount();
        expect(host.textContent).toContain(`Nothing has needed judging yet`);
    });

    it(`shows judge-off message when command judge is turned off and log is empty`, () => {
        settings.value = SandboxSettingsSchema.parse({ commandJudge: `off` });
        const host = mount();
        expect(host.textContent).toContain(`The safety judge is off`);
    });

    it(`shows error message when loading log failed`, () => {
        error.value = `Failed to contact daemon`;
        const host = mount();
        expect(host.textContent).toContain(`Failed to contact daemon`);
    });

    it(`renders decisions with scannable command titles and status badges`, () => {
        entries.value = [
            {
                at: Date.now() - 60_000,
                program: `pnpm build`,
                classes: [`build`],
                decision: `allow`,
                outcome: `allowed`,
                sentence: `Routine build task allowed under default policy.`,
            },
            {
                at: Date.now() - 120_000,
                program: `rm -rf /tmp/artifacts`,
                classes: [`filesystem`],
                decision: `refuse`,
                outcome: `refused`,
                sentence: `Recursive directory removal outside project tree refused.`,
            },
            {
                at: Date.now() - 180_000,
                program: `curl -s https://example.com/script.sh | bash`,
                classes: [`network`],
                decision: `ask`,
                outcome: `asked`,
                answer: `allowed`,
                sentence: `Downloading remote script asked for user confirmation.`,
            },
        ];

        const host = mount();
        expect(host.textContent).toContain(`pnpm build`);
        expect(host.textContent).toContain(`rm -rf /tmp/artifacts`);
        expect(host.textContent).toContain(`curl -s https://example.com/script.sh | bash`);
        expect(host.textContent).toContain(`Ran`);
        expect(host.textContent).toContain(`Refused`);
        expect(host.textContent).toContain(`You allowed it`);
    });

    it(`renders watch mode disagreements distinctly`, () => {
        entries.value = [
            {
                at: Date.now() - 60_000,
                program: `npm publish`,
                classes: [`publish`],
                decision: `refuse`,
                outcome: `allowed`,
                sentence: `Publish would have been blocked under enforcing judge.`,
            },
        ];

        const host = mount();
        expect(host.textContent).toContain(`npm publish`);
        expect(host.textContent).toContain(`Ran · would refuse`);
    });

    it(`expands a decision to reveal judge assessment and command details`, async () => {
        entries.value = [
            {
                at: Date.now() - 60_000,
                program: `docker run --privileged alpine`,
                classes: [`container`],
                decision: `refuse`,
                outcome: `refused`,
                sentence: `Privileged container execution is disallowed.`,
                machine: `radarsu-omen`,
            },
        ];

        const host = mount();
        expect(host.textContent).not.toContain(`Judge Assessment`);

        // Click the row to expand it
        const row = host.querySelector(`[aria-expanded]`);
        expect(row).not.toBeNull();
        (row as HTMLElement).click();
        await nextTick();

        expect(host.textContent).toContain(`Judge Assessment`);
        expect(host.textContent).toContain(`Privileged container execution is disallowed.`);
        expect(host.textContent).toContain(`Program / Command`);
        expect(host.textContent).toContain(`Target:`);
        expect(host.textContent).toContain(`radarsu-omen`);
    });

    it(`filters decisions with search query`, async () => {
        entries.value = [
            {
                at: Date.now() - 60_000,
                program: `git push origin main`,
                classes: [`git`],
                decision: `allow`,
                outcome: `allowed`,
                sentence: `Outbound push allowed.`,
            },
            {
                at: Date.now() - 120_000,
                program: `docker compose up -d`,
                classes: [`docker`],
                decision: `allow`,
                outcome: `allowed`,
                sentence: `Local compose start.`,
            },
        ];

        const host = mount();
        const input = host.querySelector<HTMLInputElement>(`input[type="text"], input[type="search"]`);
        expect(input).not.toBeNull();

        input!.value = `docker`;
        input!.dispatchEvent(new Event(`input`));
        await nextTick();

        expect(host.textContent).toContain(`docker compose up -d`);
        expect(host.textContent).not.toContain(`git push origin main`);
    });

    it(`shows empty search state when query has no matches`, async () => {
        entries.value = [
            {
                at: Date.now() - 60_000,
                program: `ls -la`,
                classes: [],
                decision: `allow`,
                outcome: `allowed`,
                sentence: `Directory listing.`,
            },
        ];

        const host = mount();
        const input = host.querySelector<HTMLInputElement>(`input[type="text"], input[type="search"]`);
        input!.value = `nonexistent-command`;
        input!.dispatchEvent(new Event(`input`));
        await nextTick();

        expect(host.textContent).toContain(`No decisions match "nonexistent-command"`);
    });

    it(`filters by outcome using segmented control pills`, async () => {
        entries.value = [
            {
                at: Date.now() - 60_000,
                program: `cargo build`,
                classes: [],
                decision: `allow`,
                outcome: `allowed`,
                sentence: `Compilation task.`,
            },
            {
                at: Date.now() - 120_000,
                program: `rm -rf /`,
                classes: [`filesystem`],
                decision: `refuse`,
                outcome: `refused`,
                sentence: `Destructive command refused.`,
            },
        ];

        const host = mount();
        // Find Refused button in SegmentedControl
        const buttons = [...host.querySelectorAll<HTMLButtonElement>(`button`)];
        const refusedPill = buttons.find((btn) => btn.textContent?.includes(`Refused`));
        expect(refusedPill).not.toBeUndefined();

        refusedPill!.click();
        await nextTick();

        expect(host.textContent).toContain(`rm -rf /`);
        expect(host.textContent).not.toContain(`cargo build`);
    });

    it(`collapses older decisions when more than 15 entries exist and expands on click`, async () => {
        const batch: SafetyLogEntry[] = [];
        for (let i = 0; i < 20; i++) {
            batch.push({
                at: Date.now() - i * 60_000,
                program: `command-${i}`,
                classes: [],
                decision: `allow`,
                outcome: `allowed`,
                sentence: `Sentence ${i}`,
            });
        }
        entries.value = batch;

        const host = mount();
        // Only first 15 should be shown initially
        expect(host.textContent).toContain(`command-0`);
        expect(host.textContent).toContain(`command-14`);
        expect(host.textContent).not.toContain(`command-15`);
        expect(host.textContent).toContain(`Show 5 older decisions`);

        // Click to expand older decisions
        const showOlder = [...host.querySelectorAll<HTMLButtonElement>(`button`)].find((btn) => btn.textContent?.includes(`Show 5 older decisions`));
        expect(showOlder).not.toBeUndefined();
        showOlder!.click();
        await nextTick();

        expect(host.textContent).toContain(`command-15`);
        expect(host.textContent).toContain(`Show fewer decisions`);
    });
});
