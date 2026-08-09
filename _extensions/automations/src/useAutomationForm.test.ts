import type { Automation } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { computed, nextTick } from "vue";
import type { ListenerSource } from "./listenerSources";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";
import { useAutomationForm } from "./useAutomationForm";

/* THE PROMPT HAS TO AGREE WITH THE TRIGGER, and nothing downstream can tell when it doesn't: the daemon fires
 * whatever prompt it stores, and the woken turn reads a payload it was never told about. The bug these tests
 * exist for shipped: a starter was seeded when the trigger CARD was clicked, so picking Listen (live) and then
 * switching the source to CI/CD left the row telling the agent to answer Discord messages.
 *
 * Every case below is the same question — whose text is in the box. The form's own (a starter, a template) may be
 * rewritten for whatever fires now; the user's may not, ever. */

const DISCORD: ListenerSource = {
    provider: `discord`,
    label: `Discord`,
    logo: `discord`,
    available: true,
    events: [{ value: `message`, label: `Messages` }],
    mentionLabel: `Only mentions`,
    channel: { label: `Channel`, placeholder: `all channels` },
    starterPrompt: `Handle Discord messages.`,
};
const CI: ListenerSource = {
    provider: `ci`,
    label: `CI/CD`,
    icon: `bolt`,
    available: true,
    events: [{ value: `pipeline_failed`, label: `Pipeline failed` }],
    channel: { label: `Repository`, placeholder: `all repos` },
    starterPrompt: `Handle CI results.`,
};
const SOURCES = computed<readonly ListenerSource[]>(() => [DISCORD, CI]);
const formState = () => useAutomationForm(SOURCES);

const recipe = (id: string): AutomationRecipe => {
    const found = AUTOMATION_RECIPES.find((entry) => entry.id === id);
    if (found === undefined) {
        throw new Error(`no recipe ${id}`);
    }
    return found;
};

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
        // A webhook's payload is whatever its sender POSTs, so there is no starter to describe it.
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
        // Nothing to name: it is the owner's sentence, not a starter left behind.
        expect(staleStarter.value).toBeUndefined();
    });
});

describe(`a template's own text`, () => {
    it(`survives the trigger it set itself`, async () => {
        const fixCi = recipe(`fix-failing-ci`);
        const { form, loadRecipe } = formState();
        loadRecipe(fixCi);
        await nextTick();
        // Filling the form from a template moves the trigger AND the prompt in one go — without that being told
        // apart from a trigger change, the template's own words are the first thing overwritten.
        expect(form.prompt).toBe(fixCi.prompt);
        expect(form.prompt).not.toBe(CI.starterPrompt);
    });

    it(`goes, with its guard, when the trigger moves off it`, async () => {
        const review = recipe(`review-agent-work`);
        const { form, loadRecipe } = formState();
        loadRecipe(review);
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
        load({ id: `inbox`, trigger: { kind: `listener`, provider: `discord` }, prompt: `Mine, hand-written.`, enabled: true });
        await nextTick();
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(`Mine, hand-written.`);
    });

    it(`names a starter that belongs to another source, and swaps it on request`, () => {
        const { form, load, staleStarter, applyStarter } = formState();
        // Exactly what the shipped bug saved: a CI trigger carrying Discord's briefing. Nothing may rewrite it
        // now — it is a stored prompt — so the form names the mismatch and offers the swap.
        load({
            id: `on-failed-ci`,
            trigger: { kind: `listener`, provider: `ci`, eventType: `pipeline_failed` },
            prompt: DISCORD.starterPrompt ?? ``,
            enabled: true,
        });
        expect(staleStarter.value?.label).toBe(DISCORD.label);
        applyStarter();
        expect(form.prompt).toBe(CI.starterPrompt);
        expect(staleStarter.value).toBeUndefined();
    });
});

describe(`editing preserves fields outside the changed control`, () => {
    it(`keeps a webhook's token and disabled state`, () => {
        const automation: Automation = {
            id: `deploy-hook`,
            trigger: { kind: `event`, token: `stable-secret` },
            prompt: `Handle the deploy.`,
            enabled: false,
        };
        const { form, load, build } = formState();
        load(automation);
        form.prompt = `Handle the deploy carefully.`;
        expect(build()).toEqual({ ...automation, prompt: `Handle the deploy carefully.` });
    });

    it(`round-trips a secured Doorbell including settings the form does not render`, () => {
        const automation: Automation = {
            id: `support`,
            trigger: { kind: `listener`, provider: `webchat`, eventType: `message`, allowedOrigins: [`https://example.com`] },
            prompt: `Answer support questions.`,
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
            // Deliberately narrower than the new-Doorbell default: editing must not widen a security boundary.
            allowedTools: [`Read`],
            account: `reliable-account`,
            holdForSeconds: 20,
            enabled: false,
        };
        const { load, build } = formState();
        load(automation);
        expect(build()).toEqual(automation);
    });
});
