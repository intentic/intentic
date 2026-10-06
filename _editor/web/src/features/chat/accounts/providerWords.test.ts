/* WHAT A PROVIDER NEEDS AND RUNS, IN THE READER'S LANGUAGE. */
import { PROVIDER_SPECS, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { setLocale } from "@intentic/ui/i18n";
import { endpointProviders, providerDisplayLabel } from "./providerCatalog";
import { type RequirementForm, requirementWords, runsWords } from "./providerWords";

// The contract's phrases that are a vendor's own name, and so have no words of their own.
const PROPER_REQUIREMENTS = new Set([`Z.ai GLM Coding Plan`]);
const PROPER_RUNS = new Set([`Claude Code`, `Codex`, `Grok`, `Kimi Code`, `Cursor Agent`]);

const FORMS: readonly RequirementForm[] = [`name`, `needed`, `object`];

test(`in English every requirement and every runtime reads exactly as the contract spells it`, () => {
    const drifted = PROVIDER_SPECS.flatMap((spec) => [
        ...FORMS.map((form) => [spec.access.requirement, requirementWords(spec.access, form)] as const),
        [spec.access.runs, runsWords(spec.access)] as const,
    ]).filter(([phrase, shown]) => phrase !== shown);

    expect(drifted).toEqual([]);
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    // A phrase the contract renamed, or a provider it gained, would otherwise stay English with nothing saying so.
    test(`every requirement and runtime that is not a proper name has words`, () => {
        const untranslated = PROVIDER_SPECS.flatMap((spec) => [
            ...(PROPER_REQUIREMENTS.has(spec.access.requirement)
                ? []
                : FORMS.filter((form) => requirementWords(spec.access, form) === spec.access.requirement).map((form) => `${spec.id} ${form}`)),
            ...(PROPER_RUNS.has(spec.access.runs) || runsWords(spec.access) !== spec.access.runs ? [] : [`${spec.id} runs`]),
        ]);

        expect(untranslated).toEqual([]);
    });

    test(`each form fits the sentence it goes into, and a proper name stays`, () => {
        const claude = { requirement: `Claude subscription`, runs: `Claude Code` };

        expect(FORMS.map((form) => requirementWords(claude, form))).toEqual([`Subskrypcja Claude`, `subskrypcji Claude`, `subskrypcję Claude`]);
        expect(runsWords(claude)).toBe(`Claude Code`);
        expect(requirementWords({ requirement: `Z.ai GLM Coding Plan` }, `object`)).toBe(`Z.ai GLM Coding Plan`);
        expect(runsWords({ runs: `GLM under Claude Code` })).toBe(`GLM w Claude Code`);
    });

    test(`the free trial is named in Polish, an endpoint the owner named keeps its name`, () => {
        endpointProviders.value = [
            { id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` },
            { id: `endpoint/ollama`, label: `ollama`, kind: `endpoint` },
        ];

        expect([providerDisplayLabel(TRIAL_PROVIDER), providerDisplayLabel(`endpoint/ollama`)]).toEqual([`Darmowa wersja próbna`, `ollama`]);
        endpointProviders.value = [];
    });
});
