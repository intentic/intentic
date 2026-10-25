import type { AutomationTemplate } from "@intentic/sandbox-contract/schemas/automations";
import { ZoneSchema } from "@intentic/sandbox-contract/time";
import { computed, nextTick } from "vue";
import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages } from "../i18n";
import { manifest } from "../manifest";
import { useAutomationForm } from "../useAutomationForm";
import { usePersonaDefault } from "./usePersonaDefault";

await registerExtensionMessages(extensionIdOf(manifest), messages);

// A new automation's persona follows its trigger until a person picks one, and never after. Driven through the real
// form, as the composer drives it.

const NIGHTLY: AutomationTemplate = {
    id: `nightly-audit`,
    title: `Nightly audit`,
    requires: [],
    trigger: { kind: `schedule`, cron: `0 3 * * *` },
    prompt: `Audit the dependencies.`,
};

const composer = () => {
    const state = useAutomationForm(
        computed(() => []),
        computed(() => [NIGHTLY]),
        computed(() => ZoneSchema.parse(`Europe/Warsaw`)),
    );
    usePersonaDefault(state.form, state.touched);
    return state;
};

it(`starts a plain schedule on Full access, and moves to No accounts when outside words come in`, async () => {
    const { form } = composer();
    expect(form.actsAs).toBe(`full-access`);
    form.kind = `listener`;
    await nextTick();
    expect(form.actsAs).toBe(``);
    form.kind = `once`;
    await nextTick();
    expect(form.actsAs).toBe(`full-access`);
    form.condition = `url`;
    await nextTick();
    expect(form.actsAs).toBe(``);
});

it(`puts the default back when a template resets the form`, async () => {
    const { form, loadTemplate } = composer();
    form.kind = `listener`;
    await nextTick();
    loadTemplate(NIGHTLY);
    await nextTick();
    expect(form.actsAs).toBe(`full-access`);
});

it(`never moves a persona somebody picked by hand`, async () => {
    const { form, markTouched } = composer();
    form.actsAs = ``;
    markTouched(`actsAs`);
    await nextTick();
    form.kind = `once`;
    await nextTick();
    expect(form.actsAs).toBe(``);
});
