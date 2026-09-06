// @vitest-environment jsdom
//
// WHAT GETS STOPPED, LISTED ON THE PAGE. The group exists because a permission card names a class and the page
// named nothing: an owner interrupted by `docker volume rm` could read a switch, a prose policy and a log of
// decisions already taken, and still not find out what else was going to interrupt them or which half of it
// their policy could reach.
//
// THREE CLAIMS, AND THEY ARE ABOUT NOT LYING AND NOT BURYING. The panel must be generated from the contract, so
// it cannot come to disagree with the gate the way a hand-written list of the same facts would; it must not
// offer a control, because the un-waivable half is un-waivable and a field next to it would say otherwise; and
// it must say each class ONCE, because the shape this replaced printed three of the seven twice — once per tier
// — and then spent a paragraph explaining to the reader that it had not contradicted itself.
import { COMMAND_RULE_CATALOG } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";

const { default: AgentSafetyRules } = await import("./AgentSafetyRules.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSafetyRules) });
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
});

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const text = (host: HTMLElement): string => host.textContent ?? ``;

/* NOTHING TO PRESS FIRST. The list this replaced opened behind two disclosures, so everything below was one
 * or two clicks from being read; the whole point of cutting it to seven rows is that it now fits on the page
 * as it stands. A test that had to open something would be the regression. */
test("lists every class from the contract, with nothing to open first", () => {
    const host = mount();
    for (const rule of COMMAND_RULE_CATALOG) {
        expect(text(host), rule.commandClass).toContain(rule.label);
    }
});

/* THE CLAIM THE RESHAPE WAS FOR. `files.destructive`, `container.state` and `system.destructive` each used to
 * appear twice — hard on a laptop, judged in the container, so once under each tier heading with identical
 * patterns under it. Counting is the only way to catch that coming back, since a duplicated row still
 * `toContain` its own label. */
test("names each class exactly once", () => {
    const host = mount();
    for (const rule of COMMAND_RULE_CATALOG) {
        expect(occurrences(text(host), rule.label), rule.commandClass).toBe(1);
    }
});

/* BOTH MACHINES' ANSWERS, FOR EVERY CLASS, which is what the table is for: the same command is judged in a
 * disposable container and held on somebody's laptop, and a panel showing one set would be telling half the
 * truth to whichever reader it did not belong to.
 *
 * Counted as TWICE the cells in the catalog because each cell is spelled twice in the DOM — an aligned column
 * for a wide panel, an inline line for a narrow one, with CSS choosing. Both come off the same lookup, and
 * this is what pins them to each other: a spelling that drifted, or one that stopped being rendered, lands
 * here rather than on whichever width nobody was looking at. */
test("says where each class stands on each machine, at both widths", () => {
    const host = mount();
    const cells = COMMAND_RULE_CATALOG.flatMap((rule) => [rule.tiers.sandbox, rule.tiers.device]);
    expect(occurrences(text(host), `Always asks`)).toBe(2 * cells.filter((tier) => tier === `hard`).length);
    expect(occurrences(text(host), `Judged`)).toBe(2 * cells.filter((tier) => tier === `judged`).length);
    // Not a table with one answer in it: the machines really do differ, so both words are on the page.
    expect(cells).toContain(`hard`);
    expect(cells).toContain(`judged`);
});

/* THE FRAGMENT IS THE SCANNABLE PART and it was the least visible thing on the panel — grey prose joined by
 * dots, lighter than the label above it. Every one of them is rendered, and the qualifier beside it too, so a
 * contract entry cannot go unlisted because the component only reached for half of it. */
test("draws every pattern fragment and its qualifier", () => {
    const host = mount();
    for (const rule of COMMAND_RULE_CATALOG) {
        for (const pattern of rule.patterns) {
            expect(text(host), `${rule.commandClass}: ${pattern.code}`).toContain(pattern.code);
            if (pattern.qualifier !== undefined) {
                expect(text(host), `${rule.commandClass}: ${pattern.qualifier}`).toContain(pattern.qualifier);
            }
        }
    }
    // Monospaced and highlightable rather than prose: the fragment goes in a <code>, which is what RuleCommand
    // renders and what the chip around it is sized for.
    expect(host.querySelectorAll(`code`).length).toBeGreaterThanOrEqual(
        COMMAND_RULE_CATALOG.reduce((total, rule) => total + rule.patterns.length, 0),
    );
});

/* WHERE THE LOCUS CHANGES WHAT A CLASS MEANS, both answers are given. "Delete a whole root directory" is a
 * fact about a machine rather than about a string — two paths here, an entire OS layout there — and printing
 * one of them would mislead whichever reader it did not belong to. */
test("says what a root is on each machine", () => {
    const host = mount();
    const noted = COMMAND_RULE_CATALOG.filter((rule) => rule.notes !== undefined);
    expect(noted.length).toBeGreaterThan(0);
    for (const rule of noted) {
        for (const note of Object.values(rule.notes ?? {})) {
            expect(text(host), rule.commandClass).toContain(note);
        }
    }
});

/* READ-ONLY, and this is the claim worth holding: the un-waivable half cannot be edited, so the panel must not
 * grow anything that implies it can. With the disclosures gone there is nothing to press at all, so any button
 * appearing here is the failure. */
test("offers nothing to edit", () => {
    const host = mount();
    expect(host.querySelectorAll(`input, textarea, select, [role="switch"], [role="radio"]`)).toHaveLength(0);
    expect(host.querySelectorAll(`button`)).toHaveLength(0);
});
