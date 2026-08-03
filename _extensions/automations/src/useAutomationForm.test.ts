import type { IntenticApi } from "@intentic/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { bindHost } from "./host";
import { LISTENER_SOURCES } from "./listenerSources";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";
import { useAutomationForm } from "./useAutomationForm";

/* THE PROMPT HAS TO AGREE WITH THE TRIGGER, and nothing downstream can tell when it doesn't: the daemon fires
 * whatever prompt it stores, and the woken turn reads a payload it was never told about. The bug these tests
 * exist for shipped: a starter was seeded when the trigger CARD was clicked, so picking Listen (live) and then
 * switching the source to CI/CD left the row telling the agent to answer Discord messages.
 *
 * Every case below is the same question — whose text is in the box. The form's own (a starter, a template) may be
 * rewritten for whatever fires now; the user's may not, ever. */

// Only `liveSources` reads the host, and nothing here does — bound anyway so a future read fails as a bad
// expectation rather than as "host() called before activate()".
beforeAll(() => bindHost({ workspace: { capabilities: () => [] } } as unknown as IntenticApi));

const recipe = (id: string): AutomationRecipe => {
    const found = AUTOMATION_RECIPES.find((entry) => entry.id === id);
    if (found === undefined) {
        throw new Error(`no recipe ${id}`);
    }
    return found;
};

describe(`the prompt follows the trigger`, () => {
    it(`arrives with the picked source's starter`, async () => {
        const { form } = useAutomationForm();
        form.kind = `listener`;
        await nextTick();
        expect(form.prompt).toBe(LISTENER_SOURCES.discord.starterPrompt);
    });

    it(`re-writes the starter when the source changes under it`, async () => {
        const { form } = useAutomationForm();
        form.kind = `listener`;
        await nextTick();
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(LISTENER_SOURCES.ci.starterPrompt);
    });

    it(`clears the starter when the trigger stops being a live one`, async () => {
        const { form } = useAutomationForm();
        form.kind = `listener`;
        await nextTick();
        form.kind = `event`;
        await nextTick();
        // A webhook's payload is whatever its sender POSTs, so there is no starter to describe it.
        expect(form.prompt).toBe(``);
    });

    it(`never touches text the user typed`, async () => {
        const { form, staleStarter } = useAutomationForm();
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
        const { form, loadRecipe } = useAutomationForm();
        loadRecipe(fixCi);
        await nextTick();
        // Filling the form from a template moves the trigger AND the prompt in one go — without that being told
        // apart from a trigger change, the template's own words are the first thing overwritten.
        expect(form.prompt).toBe(fixCi.prompt);
        expect(form.prompt).not.toBe(LISTENER_SOURCES.ci.starterPrompt);
    });

    it(`goes, with its guard, when the trigger moves off it`, async () => {
        const drafts = recipe(`publish-drafts`);
        const { form, loadRecipe } = useAutomationForm();
        loadRecipe(drafts);
        await nextTick();
        expect(form.guard).toBe(drafts.guard);
        form.kind = `listener`;
        await nextTick();
        expect(form.prompt).toBe(LISTENER_SOURCES.discord.starterPrompt);
        // A jq over .intentic/drafts/ left on a Discord listener is a row that never fires and never says why.
        expect(form.guard).toBe(``);
    });
});

describe(`editing a stored automation`, () => {
    it(`keeps the owner's prompt when its source is changed`, async () => {
        const { form, load } = useAutomationForm();
        load({ id: `inbox`, trigger: { kind: `listener`, provider: `discord` }, prompt: `Mine, hand-written.`, enabled: true });
        await nextTick();
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(`Mine, hand-written.`);
    });

    it(`names a starter that belongs to another source, and swaps it on request`, () => {
        const { form, load, staleStarter, applyStarter } = useAutomationForm();
        // Exactly what the shipped bug saved: a CI trigger carrying Discord's briefing. Nothing may rewrite it
        // now — it is a stored prompt — so the form names the mismatch and offers the swap.
        load({
            id: `on-failed-ci`,
            trigger: { kind: `listener`, provider: `ci`, eventType: `pipeline_failed` },
            prompt: LISTENER_SOURCES.discord.starterPrompt,
            enabled: true,
        });
        expect(staleStarter.value?.label).toBe(LISTENER_SOURCES.discord.label);
        applyStarter();
        expect(form.prompt).toBe(LISTENER_SOURCES.ci.starterPrompt);
        expect(staleStarter.value).toBeUndefined();
    });
});
