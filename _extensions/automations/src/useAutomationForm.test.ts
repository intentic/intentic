import type { Automation, AutomationTemplate } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { computed, nextTick } from "vue";
import type { AvailableSource } from "./catalog";
import { useAutomationForm } from "./useAutomationForm";

/* THE PROMPT HAS TO AGREE WITH THE TRIGGER, and nothing downstream can tell when it doesn't: the daemon fires
 * whatever prompt it stores, and the woken turn reads a payload it was never told about. The bug these tests
 * exist for shipped: a starter was seeded when the trigger CARD was clicked, so picking Listen (live) and then
 * switching the source to CI/CD left the row telling the agent to answer Discord messages.
 *
 * Every case below is the same question — whose text is in the box. The form's own (a starter, a template) may be
 * rewritten for whatever fires now; the user's may not, ever. */

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

/* The templates arrive from the daemon's catalogue now, so the fixtures below stand in for it rather than
 * being imported from a table in this package. Shaped on the two the form actually has to tell apart: one that
 * sets a listener trigger, and one that sets a workspace trigger AND a guard. */
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
        const fixCi = FIX_CI;
        const { form, loadTemplate } = formState();
        loadTemplate(fixCi);
        await nextTick();
        // Filling the form from a template moves the trigger AND the prompt in one go — without that being told
        // apart from a trigger change, the template's own words are the first thing overwritten.
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
            // Deliberately narrower than its persona: editing must not widen a security boundary.
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

    /* A Doorbell is driven by a stranger with nobody watching, so it is the one automation that must never end
     * up unbounded. Naming no persona means the full toolbox everywhere else in the product — here it is filled
     * in with the front desk, the read-only card the daemon writes on save. */
    it(`gives a Doorbell that names no persona the front desk`, () => {
        const { form, build } = formState();
        form.kind = `listener`;
        form.provider = `webchat`;
        form.id = `support`;
        form.prompt = `Answer support questions.`;
        form.origins = `https://example.com`;
        expect(build().actsAs).toBe(`front-desk`);
    });

    // ...and the owner's own choice stands. A Doorbell deliberately pointed at a card with more powers is a
    // decision they made on a visible field, not something to quietly overwrite on every save.
    it(`leaves a Doorbell's chosen persona alone`, () => {
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
