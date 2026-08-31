// @vitest-environment jsdom
//
// THE ONE THING ON THIS ROW THAT IS READ OFF THE SCREEN AND TYPED SOMEWHERE ELSE: WhatsApp's link-a-device
// code, transcribed into a phone standing next to the reader. It is pinned here because it went missing in the
// least visible way possible: the daemon knew the code, the card was on screen, and the row simply had nowhere
// to put it, so an owner who added WhatsApp was shown a connection badge and never a code at all.
import PrimeVue from "primevue/config";
import { expect, it, vi } from "vitest";
import { createApp, h } from "vue";
import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import type { ConnectionState } from "../pages/capabilities/connections";

// The row reaches for a router only through the rebuild hand-off, which none of these cases takes.
vi.mock(`vue-router`, () => ({ useRouter: () => ({ push: () => undefined }), RouterLink: { template: `<a><slot /></a>` } }));

const { default: CapabilityInstanceRow } = await import("./CapabilityInstanceRow.vue");

const ENTRY = { id: `whatsapp`, kind: `cli`, name: `WhatsApp`, logo: `whatsapp` } as unknown as CapabilityCatalogEntry;
const STATE: ConnectionState = { label: `needs setup`, tone: `warning`, rank: 1 };

const render = (status: CapabilitySummary[`status`], state: ConnectionState = STATE): string => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const instance = { id: `whatsapp`, kind: `cli`, status, config: {} } as unknown as CapabilitySummary;
    const app = createApp({
        render: () => h(CapabilityInstanceRow, { entry: ENTRY, instance, state, facts: `+49 151 12345678` }),
    });
    app.use(PrimeVue);
    // Globally registered in the real app; a bare span is all these assertions need of it.
    app.component(`Icon`, { props: [`name`], template: `<span />` });
    app.mount(el);
    const html = el.innerHTML;
    app.unmount();
    el.remove();
    return html;
};

it("sets the pairing code out where it can be read and copied, with the phone's own steps under it", () => {
    const detail = `Type this code on the phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.`;
    const html = render({
        state: `pending`,
        detail,
        code: `ABCDEFGH`,
    });
    expect(html).toContain(`ABCDEFGH`);
    expect(html).toContain(detail);
    // The wide tracking IS the feature: it is what makes a run of eight characters transcribable by hand, so
    // it is asserted rather than left to a class list nobody would notice going quiet.
    expect(html).toContain(`tracking-[0.3em]`);
});

it("says what it is waiting for before any code exists: the seconds that used to read as connected", () => {
    const waiting = `waiting for WhatsApp to issue a pairing code…`;
    const withCode = render({
        state: `pending`,
        detail: `Type this code on the phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.`,
        code: `ABCDEFGH`,
    });
    const html = render({ state: `pending`, detail: waiting });
    expect(html).toContain(waiting);
    expect(html).not.toContain(`ABCDEFGH`);
    expect(html).not.toBe(withCode);
});

it("carries WhatsApp's own refusal rather than a green badge", () => {
    const refusal = `WhatsApp refused that number: Not a WhatsApp account`;
    const html = render({ state: `pending`, detail: refusal });
    expect(html).toContain(refusal);
    expect(html).not.toContain(`tracking-[0.3em]`);
});

it("a connected row keeps its one line: nothing outstanding, nothing to show", () => {
    const html = render({ state: `active` }, { label: `ready`, tone: `success`, rank: 3 });
    expect(html).not.toContain(`tracking-[0.3em]`);
    expect(html).toContain(`+49 151 12345678`);
});
