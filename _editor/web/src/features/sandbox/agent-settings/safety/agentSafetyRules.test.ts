// @vitest-environment jsdom
// AgentSafetyRules renders every COMMAND_RULE_CATALOG entry once, generated from the contract with no controls,
// since the un-waivable half of it can't be edited.
import { COMMAND_RULE_CATALOG } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test } from "vitest";
import { type App, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";

const { default: AgentSafetyRules } = await import("./AgentSafetyRules.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSafetyRules) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {
        mounted: (el: HTMLElement, binding: { value?: string }) => {
            if (binding.value !== undefined) {
                el.dataset[`tooltip`] = binding.value;
            }
        },
    });
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const text = (host: HTMLElement): string => host.textContent ?? ``;

// Row titles capitalize the contract label; gate copy keeps it lowercase.
const rowTitle = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

test("lists every class from the contract, with nothing to open first", () => {
    const host = mount();
    // Heading text is the panel's own wording, not from the contract, so it's spelled out here rather than read off
    // the component.
    expect(text(host)).toContain(`What gets stopped`);
    // No tally beside the heading: the rows are the answer, and "7 kinds" only competed with the label for the eye.
    expect(text(host)).not.toContain(`${COMMAND_RULE_CATALOG.length} kinds`);
    for (const rule of COMMAND_RULE_CATALOG) {
        expect(text(host), rule.commandClass).toContain(rowTitle(rule.label));
    }
});

// Counts occurrences rather than toContain, since a duplicated row would still pass a plain containment check.
test("names each class exactly once", () => {
    const host = mount();
    for (const rule of COMMAND_RULE_CATALOG) {
        expect(occurrences(text(host), rowTitle(rule.label)), rule.commandClass).toBe(1);
    }
});

// Each cell renders twice in the DOM (an aligned column for wide layouts, an inline line for narrow), so counts
// are doubled against the catalog.
test("says where each class stands on each machine, at both widths", () => {
    const host = mount();
    const cells = COMMAND_RULE_CATALOG.flatMap((rule) => [rule.tiers.sandbox, rule.tiers.device]);
    expect(occurrences(text(host), `Always asks`)).toBe(2 * cells.filter((tier) => tier === `hard`).length);
    expect(occurrences(text(host), `Judged`)).toBe(2 * cells.filter((tier) => tier === `judged`).length);
    expect(cells).toContain(`hard`);
    expect(cells).toContain(`judged`);
});

test("names both machines, at the head and again on every row", () => {
    const host = mount();
    // perMachine counts two places a machine name appears: the column head and each row's narrow line.
    const perMachine = 1 + COMMAND_RULE_CATALOG.length;
    expect(occurrences(text(host), `This sandbox`)).toBe(perMachine);
    expect(occurrences(text(host), `My devices`)).toBe(perMachine);
    expect(text(host)).toContain(`This sandbox — Always asks`);
    expect(text(host)).toContain(`My devices — Always asks`);
    expect(text(host)).toContain(`This sandbox — Judged`);
});

test("draws every pattern fragment; qualifiers live on the chip tooltip, not inline", () => {
    const host = mount();
    for (const rule of COMMAND_RULE_CATALOG) {
        for (const pattern of rule.patterns) {
            expect(text(host), `${rule.commandClass}: ${pattern.code}`).toContain(pattern.code);
            if (pattern.qualifier !== undefined) {
                expect(text(host), `${rule.commandClass}: ${pattern.qualifier}`).not.toContain(pattern.qualifier);
                // Typed to the element the selector already names: `closest` with an attribute selector falls back
                // to its generic overload and hands back a bare `Element`, which carries no `dataset`.
                const chip = [...host.querySelectorAll(`code`)]
                    .find((el) => el.textContent?.includes(pattern.code))
                    ?.closest<HTMLSpanElement>(`span[data-tooltip]`);
                expect(chip?.dataset[`tooltip`], `${rule.commandClass}: ${pattern.code}`).toBe(pattern.qualifier);
            }
        }
    }
    // Fragments render inside <code> (RuleCommand's output), which the chip around them is sized for.
    expect(host.querySelectorAll(`code`).length).toBeGreaterThanOrEqual(
        COMMAND_RULE_CATALOG.reduce((total, rule) => total + rule.patterns.length, 0),
    );
});

test("offers nothing to edit", () => {
    const host = mount();
    expect(host.querySelectorAll(`input, textarea, select, [role="switch"], [role="radio"]`)).toHaveLength(0);
    expect(host.querySelectorAll(`button`)).toHaveLength(0);
});
