// The correction a quiet wait in the app earns. An app from before it reported anything (v1.331.0) did nothing at all
// when "Set it up now" was pressed on a PC that still needed its own setup, and this said only "Check the Intentic
// window" (2026-10-12): it now names the window's own button, and an app that says it is setting the PC up is told as such.
import "@intentic/testing/dom";
import { createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { NudgeVariant } from "../flow/commandHandoff";

const { default: SetupNudge } = await import(`../SetupNudge.vue`);

const render = (variant: NudgeVariant): string => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SetupNudge, { variant }) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    const text = el.textContent ?? ``;
    app.unmount();
    el.remove();
    return text;
};

it(`points a reader the app has said nothing to at the window's "Set up this PC", then back to this page's button`, () => {
    const text = render(`app`);
    expect(text).toContain(`Still nothing.`);
    expect(text).toContain(`If it offers "Set up this PC", do that first, then press "Set it up now" here again.`);
});

it(`tells a reader whose app is setting up the PC first that this is the wait, not a stuck one`, () => {
    const text = render(`pcSetup`);
    expect(text).not.toContain(`Still nothing.`);
    expect(text).toContain(`This PC is being set up first.`);
    expect(text).toContain(`your workspace setup continues by itself after.`);
});
