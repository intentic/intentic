// The card that offers the registry's update, and the one shape where that offer is wrong: a sandbox whose base was
// compiled from a checkout. Pulling there REPLACES what the checkout built instead of refreshing it, so the offer is
// the rebuild from that checkout, and the trade is spelled out rather than made by a click. Beside the offer, what the
// machine last did about this sandbox's version, a withdrawn release and a skipped one, each with the action that
// applies to it.
import "@intentic/testing/dom";
import type { Environment, Info, StagedUpdate, UpdateOutcome } from "@intentic/sandbox-contract";
import { useOsPreference } from "@intentic/ui";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const LATEST = `1.54.0`;
const info = ref<Info>({ version: `1.53.0`, latest: LATEST, updateAvailable: true, channel: `stable` });
const localImage = ref<Environment[`localImage`]>(undefined);
const stagedPlan = ref<StagedUpdate[`plan`]>(undefined);
const skipServed = ref(true);
const skipVersion = jest.fn(async (_version: string | null): Promise<void> => undefined);
jest.mock(`./useSandboxVersion`, () => ({
    useSandboxVersion: () => ({
        info,
        installed: computed(() => info.value.version),
        latest: computed(() => info.value.latest),
        updateAvailable: computed(() => info.value.updateAvailable === true),
        updateNotes: ref([]),
        moreUpdateNotes: ref(0),
        breakingNotes: ref([]),
        updateStaged: computed(() => stagedPlan.value !== undefined),
        stagedBehind: ref(undefined),
        stagedPlan,
        serverManaged: ref(false),
        slug: ref(`demo`),
        skipServed,
        skipVersion,
        localImage,
    }),
}));
jest.mock(`../../../agents/fleet/useAgents`, () => ({ useAgents: () => ({ fleet: ref([]) }) }));
type ActiveRow = { id: string; role: string; hosted?: { region: string; warm: boolean; canRollBack?: boolean } };
const active = ref<ActiveRow>({ id: `sb1`, role: `owner` });
jest.mock(`../../client/useSandbox`, () => ({ useSandbox: () => ({ active }) }));
jest.mock(`../../../../lib/useApi`, () => ({ apiClient: { sandbox: { hostedRestart: async () => undefined } } }));
// Marked, not mounted: which executor the card chose is the whole subject, and each reaches a device on its own.
jest.mock(`../../../capabilities/connect/hosts/HostRecreate.vue`, () => ({
    default: defineComponent({
        props: { action: { type: String, default: `` }, label: { type: String, default: undefined } },
        render(): ReturnType<typeof h> {
            return h(`div`, { "data-recreate": this.action, "data-label": this.label });
        },
    }),
}));
jest.mock(`../../environment/rebuild/DevRebuild.vue`, () => ({ default: defineComponent({ render: () => h(`div`, { "data-executor": `checkout` }) }) }));
// The platform's question, marked by whom it would ask about; the dialog's own behaviour is its own suite's.
jest.mock(`./HostedRollbackDialog.vue`, () => ({
    default: defineComponent({
        // SAFETY: the card hands this its own platform row or nothing, and the row's id is all the mark reads.
        props: { sandbox: { type: Object as () => ActiveRow | undefined, default: undefined } },
        render(): ReturnType<typeof h> | null {
            return this.sandbox === undefined ? null : h(`div`, { "data-hosted-rollback": this.sandbox.id });
        },
    }),
}));

const { default: SandboxUpdateCard } = await import("./SandboxUpdateCard.vue");

const HOUR = 60 * 60_000;
const outcome = (over: Partial<UpdateOutcome> & Pick<UpdateOutcome, `result`>): UpdateOutcome => ({
    verb: `update`,
    at: Date.now() - HOUR,
    from: `1.53.0`,
    to: LATEST,
    ...over,
});

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxUpdateCard) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

const recreates = (el: HTMLElement): (string | null)[] => [...el.querySelectorAll(`[data-recreate]`)].map((node) => node.getAttribute(`data-recreate`));
const press = async (el: HTMLElement, label: string): Promise<void> => {
    const button = [...el.querySelectorAll(`button`)].find((node) => node.textContent?.trim() === label);
    if (button === undefined) {
        throw new Error(`no "${label}" button; there are: ${[...el.querySelectorAll(`button`)].map((node) => node.textContent?.trim()).join(` | `)}`);
    }
    button.click();
    await nextTick();
};

afterEach(() => {
    info.value = { version: `1.53.0`, latest: LATEST, updateAvailable: true, channel: `stable` };
    localImage.value = undefined;
    stagedPlan.value = undefined;
    skipServed.value = true;
    skipVersion.mockClear();
    active.value = { id: `sb1`, role: `owner` };
    useOsPreference().cmdOs.value = `unix`;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers the published update on a sandbox that follows the registry`, () => {
    const el = mount();
    expect(recreates(el)).toEqual([`Update`, `Download`]);
    expect(el.querySelector(`[data-executor="checkout"]`)).toBeNull();
});

it(`offers the checkout's rebuild instead of the pull on a sandbox built from one`, () => {
    localImage.value = { base: `intentic-sandbox:dev`, root: `/home/ada/intentic` };
    const el = mount();
    expect(el.querySelector(`[data-executor="checkout"]`)).not.toBeNull();
    // The two buttons that would have traded the checkout's image for a published one, gone rather than restyled.
    expect(el.querySelectorAll(`[data-recreate]`)).toHaveLength(0);
    expect(el.textContent).toContain(`Built from your checkout`);
    // The way out is still stated, as a command someone has to mean: the published build is named, so is the cost.
    expect(el.textContent).toContain(`discards the image built from your checkout`);
    expect(el.textContent).toContain(`ic sandbox update demo --force`);
});

it(`names each stored file the downloaded build converts, before anyone takes the update`, () => {
    stagedPlan.value = {
        ok: true,
        steps: [
            { document: `settings.json`, change: `drops 2 retired settings` },
            { document: `automations.json`, change: `renames model to modelRef` },
        ],
    };
    const el = mount();
    expect(el.textContent).toContain(`this update converts 2 stored files`);
    expect(el.textContent).toContain(`drops 2 retired settings`);
    expect(el.textContent).toContain(`renames model to modelRef`);
    // Said, not asked: the update is still offered, applied from the download.
    expect(recreates(el)).toEqual([`Update`]);
});

it(`holds an update back when its own pre-flight refuses this sandbox's files, and says why`, async () => {
    stagedPlan.value = {
        ok: false,
        steps: [{ document: `settings.json`, change: `drops 2 retired settings` }],
        failures: [{ document: `automations.json`, detail: `entry 3 is not an object` }],
    };
    const el = mount();
    expect(el.textContent).toContain(`would stop before touching anything`);
    expect(el.textContent).toContain(`entry 3 is not an object`);
    expect(el.textContent).not.toContain(`drops 2 retired settings`);
    expect(el.textContent).toContain(`Update held back`);
    // Nothing to press that would only be refused; skipping it is what is left to decide.
    expect(recreates(el)).toEqual([]);
    await press(el, `Skip this version`);
    expect(skipVersion).toHaveBeenCalledWith(LATEST);
});

it(`says what an update keeps beside the button, and that the version before stays ready for a day`, () => {
    const el = mount();
    expect(el.textContent).toContain(`Your files and conversations stay.`);
    expect(el.textContent).toContain(`The previous version stays ready on this machine for 24 hours afterwards, so going back takes seconds.`);
    expect(el.textContent).not.toContain(`by itself`);
});

it(`offers going back on Windows too, where the command spells it -Rollback`, async () => {
    useOsPreference().cmdOs.value = `windows`;
    info.value = { version: `1.54.0`, latest: LATEST, updateAvailable: false, channel: `stable`, previousImage: `ghcr.io/intentic/sandbox@sha256:abc123` };
    const el = mount();
    await press(el, `Having trouble?`);
    expect(recreates(el)).toEqual([`Roll back`]);
});

it(`says an update the machine gave up on, and turns Update into Try again with Skip beside it`, async () => {
    info.value = { ...info.value, lastUpdate: outcome({ result: `rolled-back`, reason: `It restarted 5 times in 10 minutes.` }) };
    const el = mount();
    expect(el.textContent).toContain(`1.54.0 kept failing, so this machine went back to 1.53.0 by itself.`);
    expect(el.textContent).toContain(`It restarted 5 times in 10 minutes.`);
    expect(el.querySelector(`[data-recreate="Update"]`)?.getAttribute(`data-label`)).toBe(`Try again`);
    await press(el, `Skip this version`);
    expect(skipVersion).toHaveBeenCalledWith(LATEST);
});

it(`says a fresh update worked without pitching the way back, which waits behind "Having trouble?"`, async () => {
    const keepUntil = Date.now() + 20 * HOUR;
    info.value = {
        version: LATEST,
        latest: LATEST,
        updateAvailable: false,
        channel: `stable`,
        previousImage: `intentic-sandbox:rollback-demo`,
        lastUpdate: outcome({ result: `updated`, keepUntil }),
    };
    const el = mount();
    expect(el.textContent).toContain(`Updated from 1.53.0 to 1.54.0.`);
    // Nothing on the card names going back until the owner goes looking for it.
    expect(el.textContent).not.toMatch(/roll back|stays ready/i);
    expect(recreates(el)).toEqual([]);
    await press(el, `Having trouble?`);
    expect(el.textContent).toContain(`That version stays ready on this machine until`);
    expect(recreates(el)).toEqual([`Roll back`]);
});

it(`says a withdrawn release up front with the way back, and never calls it up to date`, async () => {
    info.value = {
        version: LATEST,
        latest: LATEST,
        updateAvailable: false,
        channel: `stable`,
        previousImage: `intentic-sandbox:rollback-demo`,
        withdrawn: { version: LATEST, reason: `It loses chat history on Windows.` },
    };
    const el = mount();
    expect(el.textContent).toContain(`Version 1.54.0 was withdrawn: It loses chat history on Windows.`);
    expect(el.textContent).not.toContain(`Up to date`);
    await press(el, `Roll back`);
    expect(recreates(el)).toEqual([`Roll back`]);
});

it(`says a skipped release is skipped, and offers it again`, async () => {
    info.value = { version: `1.53.0`, latest: LATEST, updateAvailable: false, channel: `stable`, skippedVersion: LATEST };
    const el = mount();
    expect(el.textContent).toContain(`You skipped 1.54.0, so it isn't offered.`);
    await press(el, `Show it again`);
    expect(skipVersion).toHaveBeenCalledWith(null);
});

it(`offers a hosted sandbox the platform's way back once it kept an image, through its own question`, async () => {
    active.value = { id: `sb1`, role: `owner`, hosted: { region: `ams`, warm: true, canRollBack: true } };
    info.value = { version: LATEST, latest: LATEST, updateAvailable: false, channel: `stable` };
    const el = mount();
    // No host keeps a version ready for a day on the platform's machines, so that line is not said there.
    expect(el.textContent).not.toContain(`24 hours`);
    await press(el, `Having trouble?`);
    expect(el.querySelector(`[data-hosted-rollback]`)).toBeNull();
    await press(el, `Roll back to the previous version`);
    expect(el.querySelector(`[data-hosted-rollback]`)?.getAttribute(`data-hosted-rollback`)).toBe(`sb1`);
    expect(recreates(el)).toEqual([]);
});

// The machine's own word that the version before is parked is a way back by itself, even from a daemon that never
// named the image it replaced.
it(`offers going back while the version before is parked, even with no previous image named`, async () => {
    info.value = {
        version: LATEST,
        latest: LATEST,
        updateAvailable: false,
        channel: `stable`,
        lastUpdate: outcome({ result: `updated`, keepUntil: Date.now() + 20 * HOUR }),
    };
    const el = mount();
    await press(el, `Having trouble?`);
    expect(recreates(el)).toEqual([`Roll back`]);
    expect(el.textContent).not.toContain(`Rolls back to`);
});
