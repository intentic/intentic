import type { Automation, AutomationTemplate } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { computed, nextTick } from "vue";
import type { AvailableSource } from "./catalog";
import { useAutomationForm } from "./useAutomationForm";

// The form's prompt must always match its trigger: a starter or template's text may be rewritten when the trigger
// changes, but the owner's own text never is.

const DISCORD: AvailableSource = {
    provider: `discord`,
    label: `Discord`,
    logo: `discord`,
    enabled: true,
    available: true,
    requires: [],
    events: [{ value: `message`, label: `Messages` }],
    mentionLabel: `Only mentions`,
    channel: { label: `Channel`, placeholder: `all channels` },
    starterPrompt: `Handle Discord messages.`,
};
const CI: AvailableSource = {
    provider: `ci`,
    label: `CI/CD`,
    icon: `bolt`,
    enabled: true,
    available: true,
    requires: [],
    events: [{ value: `pipeline_failed`, label: `Pipeline failed` }],
    channel: { label: `Repository`, placeholder: `all repos` },
    starterPrompt: `Handle CI results.`,
};

// Stand-ins for the daemon's template catalogue: one listener trigger, one workspace trigger with a guard.
const FIX_CI: AutomationTemplate = {
    id: `fix-failing-ci`,
    title: `Fix failing CI`,
    requires: [`github`],
    trigger: { kind: `listener`, provider: `ci`, eventType: `pipeline_broken` },
    prompt: `A pipeline that was green just went red — fix it.`,
};
const REVIEW: AutomationTemplate = {
    id: `review-agent-work`,
    title: `Review agent work`,
    requires: [],
    trigger: { kind: `workspace`, event: `turn.settled` },
    guard: `test "$(git diff --numstat | wc -l)" -gt 0`,
    prompt: `An agent just finished a turn. Review its diff.`,
    chore: true,
};

// Every automation needs a model ladder; round-trip tests check it survives an edit untouched.
const LADDER = [{ provider: `claude`, model: `claude-sonnet-4-6` }, { provider: `codex`, model: `gpt-5.3-codex` }] satisfies Automation["models"];

const SOURCES = computed<readonly AvailableSource[]>(() => [DISCORD, CI]);
const TEMPLATES = computed<readonly AutomationTemplate[]>(() => [FIX_CI, REVIEW]);
const formState = () => useAutomationForm(SOURCES, TEMPLATES);

describe(`the prompt follows the trigger`, () => {
    it(`arrives with the picked source's starter`, async () => {
        const { form } = formState();
        form.kind = `listener`;
        await nextTick();
        expect(form.prompt).toBe(DISCORD.starterPrompt);
    });

    it(`re-writes the starter when the source changes under it`, async () => {
        const { form } = formState();
        form.kind = `listener`;
        await nextTick();
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(CI.starterPrompt);
    });

    it(`clears the starter when the trigger stops being a live one`, async () => {
        const { form } = formState();
        form.kind = `listener`;
        await nextTick();
        form.kind = `event`;
        await nextTick();
        expect(form.prompt).toBe(``);
    });

    it(`never touches text the user typed`, async () => {
        const { form, staleStarter } = formState();
        form.kind = `listener`;
        await nextTick();
        form.prompt = `Only tell me about deploys to main.`;
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(`Only tell me about deploys to main.`);
        // staleStarter tracks only a lingering starter, not text the owner typed.
        expect(staleStarter.value).toBeUndefined();
    });
});

describe(`a template's own text`, () => {
    it(`survives the trigger it set itself`, async () => {
        const fixCi = FIX_CI;
        const { form, loadTemplate } = formState();
        loadTemplate(fixCi);
        await nextTick();
        // Trigger and prompt load together; the trigger change must not overwrite the template's prompt.
        expect(form.prompt).toBe(fixCi.prompt);
        expect(form.prompt).not.toBe(CI.starterPrompt);
    });

    it(`goes, with its guard, when the trigger moves off it`, async () => {
        const review = REVIEW;
        const { form, loadTemplate } = formState();
        loadTemplate(review);
        await nextTick();
        expect(form.guard).toBe(review.guard);
        form.kind = `listener`;
        await nextTick();
        expect(form.prompt).toBe(DISCORD.starterPrompt);
        // A diff-size jq left on a Discord listener is a row that never fires and never says why.
        expect(form.guard).toBe(``);
    });
});

describe(`editing a stored automation`, () => {
    it(`keeps the owner's prompt when its source is changed`, async () => {
        const { form, load } = formState();
        load({ id: `inbox`, trigger: { kind: `listener`, provider: `discord` }, prompt: `Mine, hand-written.`, models: LADDER, enabled: true });
        await nextTick();
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(`Mine, hand-written.`);
    });

    it(`names a starter that belongs to another source, and swaps it on request`, () => {
        const { form, load, staleStarter, applyStarter } = formState();
        // Stored prompt: CI trigger, Discord's starter text; an edit must not overwrite it, only offer a swap.
        load({
            id: `on-failed-ci`,
            trigger: { kind: `listener`, provider: `ci`, eventType: `pipeline_failed` },
            prompt: DISCORD.starterPrompt ?? ``,
            models: LADDER,
            enabled: true,
        });
        expect(staleStarter.value?.label).toBe(DISCORD.label);
        applyStarter();
        expect(form.prompt).toBe(CI.starterPrompt);
        expect(staleStarter.value).toBeUndefined();
    });
});

describe(`editing preserves fields outside the changed control`, () => {
    it(`carries a schedule's sessions bar both ways, and drops it at zero`, () => {
        const nightly: Automation = {
            id: `dream`,
            trigger: { kind: `schedule`, cron: `0 5 * * *`, afterSessions: 30 },
            prompt: `Dream.`,
            models: LADDER,
            enabled: true,
        };
        const { form, load, build } = formState();
        load(nightly);
        expect(form.afterSessions).toBe(30);
        expect(build()).toEqual(nightly);
        // Zero means unlimited: the record represents it by omitting afterSessions, not by storing zero.
        form.afterSessions = 0;
        expect(build().trigger).toEqual({ kind: `schedule`, cron: `0 5 * * *` });
    });

    it(`keeps a webhook's daily ceiling and disabled state`, () => {
        // Token lives at the door, not the record; only dailyMax and enabled must survive the edit untouched.
        const automation: Automation = {
            id: `deploy-hook`,
            trigger: { kind: `event`, dailyMax: 40 },
            prompt: `Handle the deploy.`,
            models: LADDER,
            enabled: false,
        };
        const { form, load, build } = formState();
        load(automation);
        form.prompt = `Handle the deploy carefully.`;
        expect(build()).toEqual({ ...automation, prompt: `Handle the deploy carefully.` });
    });

    it(`round-trips a secured Front Desk including settings the form does not render`, () => {
        const automation: Automation = {
            id: `support`,
            trigger: { kind: `listener`, provider: `webchat`, eventType: `message`, allowedOrigins: [`https://example.com`] },
            prompt: `Answer support questions.`,
            // Single provider throughout, so the account pin (that provider's store key) survives the round trip.
            models: [
                { provider: `claude`, model: `claude-opus-4-6` },
                { provider: `claude`, model: `claude-sonnet-4-6` },
            ],
            webchat: {
                access: `google`,
                requireName: true,
                antiBot: `turnstile`,
                turnstileSiteKey: `site-key`,
                turnstileSecret: `secret-key`,
                googleClientId: `client-id`,
                title: `Support`,
                greeting: `Hello`,
                accent: `#123456`,
                position: `bottom-left`,
                dailyMessageMax: 40,
                conversationMessageMax: 8,
                sessionTtlMinutes: 30,
            },
            // Narrower than its persona; editing must not widen a security boundary.
            allowedTools: [`Read`],
            actsAs: `front-desk`,
            account: `reliable-account`,
            holdForSeconds: 20,
            enabled: false,
        };
        const { load, build } = formState();
        load(automation);
        expect(build()).toEqual(automation);
    });

    it(`gives a Front Desk that names no persona the front desk`, () => {
        const { form, build } = formState();
        form.kind = `listener`;
        form.provider = `webchat`;
        form.id = `support`;
        form.prompt = `Answer support questions.`;
        form.origins = `https://example.com`;
        expect(build().actsAs).toBe(`front-desk`);
    });

    it(`leaves a Front Desk's chosen persona alone`, () => {
        const { form, build } = formState();
        form.kind = `listener`;
        form.provider = `webchat`;
        form.id = `support`;
        form.prompt = `Answer support questions.`;
        form.origins = `https://example.com`;
        form.actsAs = `support-desk`;
        expect(build().actsAs).toBe(`support-desk`);
    });
});

// Pins that a saveable automation must always name its own models; there is no sandbox-wide default to fall back on.
describe(`the model ladder`, () => {
    const filled = () => {
        const state = formState();
        state.form.id = `nightly`;
        state.form.prompt = `Sweep the dependencies.`;
        return state;
    };

    it(`refuses to save until a model is named`, () => {
        const { form, modelsError, valid } = filled();
        expect(modelsError.value).toMatch(/at least one model/i);
        expect(valid.value).toBe(false);
        form.models = [...LADDER];
        expect(modelsError.value).toBeUndefined();
        expect(valid.value).toBe(true);
    });

    // Templates are authored before this sandbox exists and cannot know which providers are connected.
    it(`is not filled in by a template`, () => {
        const { form, loadTemplate } = formState();
        loadTemplate(REVIEW);
        expect(form.models).toEqual([]);
    });

    it(`round-trips in the owner's order, since order is what the daemon walks`, () => {
        const { form, load, build } = formState();
        const automation: Automation = {
            id: `nightly`,
            trigger: { kind: `schedule`, cron: `0 5 * * *` },
            prompt: `Sweep.`,
            models: LADDER,
            enabled: true,
        };
        load(automation);
        expect(form.models).toEqual(LADDER);
        expect(build()).toEqual(automation);
    });

    // An account id is one provider's store key; pinning one only makes sense while the ladder stays on that provider,
    // so crossing providers clears it.
    it(`clears a pinned account once the ladder crosses providers`, () => {
        const { form, build } = filled();
        form.models = [{ provider: `claude`, model: `claude-sonnet-4-6` }];
        form.account = `reliable-account`;
        expect(build().account).toBe(`reliable-account`);
        form.models = [...LADDER];
        expect(build().account).toBeUndefined();
    });
});
