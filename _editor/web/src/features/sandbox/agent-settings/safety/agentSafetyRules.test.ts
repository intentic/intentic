// @vitest-environment jsdom
//
// WHAT GETS STOPPED, LISTED ON THE PAGE. The group exists because a permission card names a class and the page
// named nothing: an owner interrupted by `docker volume rm` could read a switch, a prose policy and a log of
// decisions already taken, and still not find out what else was going to interrupt them or which half of it
// their policy could reach.
//
// TWO CLAIMS, AND BOTH ARE ABOUT NOT LYING. The panel must be generated from the contract, so it cannot come
// to disagree with the gate the way a hand-written list of the same facts would; and it must not offer a
// control, because the un-waivable half is un-waivable and a field next to it would say otherwise.
import { COMMAND_RULE_CATALOG } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

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

// Both disclosures start closed, so a test that reads their contents has to open them first — the same two
// presses a reader makes.
const openAll = async (host: HTMLElement): Promise<void> => {
    for (const button of host.querySelectorAll<HTMLElement>(`button`)) {
        button.click();
    }
    await nextTick();
};

test("names both tiers without being opened", () => {
    const host = mount();
    expect(host.textContent).toContain(`Never judged`);
    expect(host.textContent).toContain(`Gets a second look`);
});

/* THE CATALOG IS THE SOURCE, so the expected values are read from it rather than transcribed. A rule added to
 * the contract and not to the page fails here, which is the whole reason the constant exists. */
test("lists every hard-ruled class for both machines, from the contract", async () => {
    const host = mount();
    await openAll(host);
    for (const locus of [`sandbox`, `device`] as const) {
        for (const rule of COMMAND_RULE_CATALOG[locus].filter((entry) => entry.tier === `hard`)) {
            expect(host.textContent, `${locus}/${rule.commandClass}`).toContain(rule.label);
        }
    }
});

test("lists every judged class, from the contract", async () => {
    const host = mount();
    await openAll(host);
    for (const rule of COMMAND_RULE_CATALOG.sandbox.filter((entry) => entry.tier === `judged`)) {
        expect(host.textContent, rule.commandClass).toContain(rule.label);
    }
});

/* THE DIFFERENCE BETWEEN THE MACHINES IS THE SUBSTANCE, not a footnote: the same command is judged in a
 * disposable container and held on somebody's laptop, and a panel that showed one set would be telling half
 * the truth to whichever reader it did not belong to. */
test("shows that the two machines have different floors", async () => {
    const host = mount();
    await openAll(host);
    expect(host.textContent).toContain(`This sandbox`);
    expect(host.textContent).toContain(`My devices`);
    // Held on a device, judged here — the concrete case that produced this whole change.
    const deviceOnly = COMMAND_RULE_CATALOG.device.filter(
        (rule) => rule.tier === `hard` && COMMAND_RULE_CATALOG.sandbox.find((entry) => entry.commandClass === rule.commandClass)?.tier === `judged`,
    );
    expect(deviceOnly.map((rule) => rule.commandClass)).toContain(`container.state`);
});

/* THE CLASSES THAT APPEAR IN BOTH LISTS MUST SAY WHY. Two of them are judged here and un-waivable on a laptop,
 * and a reader who finds the same words under "Never judged" and under "Gets a second look" with nothing
 * joining them concludes the page is confused rather than that the machines differ. */
test("says which of the judged classes a device holds instead", async () => {
    const host = mount();
    await openAll(host);
    const bothTiers = COMMAND_RULE_CATALOG.sandbox.filter(
        (rule) => rule.tier === `judged` && COMMAND_RULE_CATALOG.device.find((entry) => entry.commandClass === rule.commandClass)?.tier === `hard`,
    );
    expect(bothTiers.length).toBeGreaterThan(0);
    expect(host.textContent).toContain(`On your own computers`);
    for (const rule of bothTiers) {
        expect(host.textContent, rule.commandClass).toContain(rule.label);
    }
});

/* READ-ONLY, and this is the claim worth holding: the un-waivable half cannot be edited, so the panel must not
 * grow anything that implies it can. The disclosure toggles are the only presses here; a field, a switch or a
 * remove button appearing in this group is the failure. */
test("offers nothing to edit", async () => {
    const host = mount();
    await openAll(host);
    expect(host.querySelectorAll(`input, textarea, select, [role="switch"], [role="radio"]`)).toHaveLength(0);
    // Every button is a disclosure toggle: one per tier, and nothing else.
    expect(host.querySelectorAll(`button`)).toHaveLength(2);
});
