// The card that offers the registry's update, and the one shape where that offer is wrong: a sandbox whose base was
// compiled from a checkout. Pulling there REPLACES what the checkout built instead of refreshing it, so the offer is
// the rebuild from that checkout, and the trade is spelled out rather than made by a click. Beside the offer, what the
// machine last did about this sandbox's version, a withdrawn release and a skipped one, each with the action that
// applies to it.
import "@intentic/testing/dom";
import type { Environment, Info, PreparingUpdate, StagedUpdate, UpdateOutcome } from "@intentic/sandbox-contract";
import { useOsPreference } from "@intentic/ui";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { DownloadWanted } from "./useBackgroundDownload";

const LATEST = `1.54.0`;
const info = ref<Info>({ version: `1.53.0`, latest: LATEST, updateAvailable: true, channel: `stable` });
const localImage = ref<Environment[`localImage`]>(undefined);
const stagedPlan = ref<StagedUpdate[`plan`]>(undefined);
const breakingNotes = ref<string[]>([]);
const updateNotes = ref<string[]>([]);
const moreUpdateNotes = ref(0);
const preparing = ref<PreparingUpdate | undefined>(undefined);
const skipServed = ref(true);
const skipVersion = jest.fn(async (_version: string | null): Promise<void> => undefined);
jest.mock(`./useSandboxVersion`, () => ({
    useSandboxVersion: () => ({
        info,
        installed: computed(() => info.value.version),
        latest: computed(() => info.value.latest),
        updateAvailable: computed(() => info.value.updateAvailable === true),
        updateNotes,
        moreUpdateNotes,
        breakingNotes,
        updateStaged: computed(() => stagedPlan.value !== undefined),
        stagedBehind: ref(undefined),
        stagedPlan,
        preparing,
        serverManaged: ref(false),
        slug: ref(`demo`),
        skipServed,
        skipVersion,
        localImage,
    }),
}));
// The card's ask to the machine, stood in for: what it asks for is read back through `asked`, and whether its request is
// still out is set through `starting`. The ask itself (which machine, which agent, how often) is its own suite's.
const starting = ref(false);
let wantedByCard: () => DownloadWanted | undefined = () => undefined;
const asked = (): DownloadWanted | undefined => wantedByCard();
jest.mock(`./useBackgroundDownload`, () => ({
    useBackgroundDownload: (wanted: () => DownloadWanted | undefined) => {
        wantedByCard = wanted;
        return { starting };
    },
}));
jest.mock(`../../../agents/fleet/useAgents`, () => ({ useAgents: () => ({ fleet: ref([]) }) }));
type ActiveRow = { id: string; role: string; hosted?: { region: string; warm: boolean; canRollBack?: boolean } };
const active = ref<ActiveRow>({ id: `sb1`, role: `owner` });
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active }) }));
jest.mock(`../../../../lib/useApi`, () => ({ apiClient: { sandbox: { hostedRestart: async () => undefined } } }));
// Marked, not mounted: which executor the card chose is the whole subject, and each reaches a device on its own. It
// draws what the card lays in its row (`beside`), and a press on its own fold stands in for the command it would open.
jest.mock(`../../../capabilities/connect/hosts/HostRecreate.vue`, () => ({
    default: defineComponent({
        props: {
            action: { type: String, default: `` },
            label: { type: String, default: undefined },
            gilded: { type: Boolean, default: false },
            ready: { type: Boolean, default: false },
            open: { type: Boolean, default: false },
        },
        emits: [`update:open`],
        render(): ReturnType<typeof h> {
            const marks = { "data-label": this.label, "data-gilded": String(this.gilded), "data-ready": String(this.ready), "data-open": String(this.open) };
            return h(`div`, { "data-recreate": this.action, ...marks }, [
                h(`button`, { type: `button`, onClick: () => this.$emit(`update:open`, !this.open) }, `${this.action} command`),
                this.$slots[`beside`]?.(),
            ]);
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
    app.use(PrimeVue);
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
    breakingNotes.value = [];
    updateNotes.value = [];
    moreUpdateNotes.value = 0;
    preparing.value = undefined;
    starting.value = false;
    skipServed.value = true;
    skipVersion.mockClear();
    active.value = { id: `sb1`, role: `owner` };
    useOsPreference().cmdOs.value = `unix`;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers the published update on a sandbox that follows the registry, in gold, with nothing beside it to download first`, () => {
    const el = mount();
    expect(recreates(el)).toEqual([`Update`]);
    expect(el.querySelector(`[data-recreate="Update"]`)?.getAttribute(`data-gilded`)).toBe(`true`);
    expect(el.querySelector(`[data-recreate="Update"]`)?.getAttribute(`data-ready`)).toBe(`false`);
    expect(el.querySelector(`[data-executor="checkout"]`)).toBeNull();
    // The download is the machine's to do by itself; there is no button for it.
    expect(el.textContent).not.toContain(`Download first`);
});

it(`draws a download the machine is running in place of the buttons, and turns to the restart by itself once it is in`, async () => {
    preparing.value = { channel: `stable`, startedAt: Date.now() - 60_000, at: Date.now(), phase: `download`, percent: 41.6 };
    const el = mount();
    expect(recreates(el)).toEqual([]);
    const status = el.querySelector(`[role="status"]`)!;
    expect([...status.querySelectorAll(`span, p`)].map((part) => part.textContent?.trim())).toEqual([
        `Downloading 1.54.0 in the background`,
        `42%`,
        `Your sandbox keeps working. Once it's in, updating takes about 30 seconds.`,
    ]);
    expect(el.querySelector(`header`)?.textContent).toContain(`Downloading update`);
    // In: the marker gone and the build staged, so the gold button is the half-minute restart.
    preparing.value = undefined;
    stagedPlan.value = { ok: true, steps: [] };
    await nextTick();
    expect(recreates(el)).toEqual([`Update`]);
    expect(el.querySelector(`[data-recreate="Update"]`)?.getAttribute(`data-ready`)).toBe(`true`);
    expect(el.querySelector(`header`)?.textContent).toContain(`Update ready to apply`);
    expect(el.querySelector(`[role="status"]`)).toBeNull();
});

it(`names the step a download is on, with a bar that has no end where there is nothing to measure`, () => {
    preparing.value = { channel: `stable`, startedAt: Date.now() - 60_000, at: Date.now(), phase: `build` };
    const el = mount();
    const status = el.querySelector(`[role="status"]`)!;
    expect(status.textContent).toContain(`Building your environment on 1.54.0`);
    expect(status.textContent).not.toContain(`%`);
    expect(status.querySelector(`.p-progressbar-indeterminate`)).not.toBeNull();
});

it(`draws its own request for the download as one starting, until the machine says how far it got`, () => {
    starting.value = true;
    const el = mount();
    expect(recreates(el)).toEqual([]);
    expect(el.querySelector(`[role="status"]`)?.textContent).toContain(`Starting to download 1.54.0 in the background`);
});

it(`asks the machine for the download only while an update on offer is neither downloaded nor downloading`, async () => {
    mount();
    expect(asked()).toEqual({ slug: `demo`, version: LATEST });
    preparing.value = { channel: `stable`, startedAt: Date.now(), at: Date.now(), phase: `download` };
    expect(asked()).toBeUndefined();
    preparing.value = undefined;
    stagedPlan.value = { ok: true, steps: [] };
    expect(asked()).toBeUndefined();
    stagedPlan.value = undefined;
    // The platform restarts a hosted sandbox onto its image; there is no machine of the owner's to download on.
    active.value = { id: `sb1`, role: `owner`, hosted: { region: `ams`, warm: true } };
    expect(asked()).toBeUndefined();
    active.value = { id: `sb1`, role: `owner` };
    info.value = { ...info.value, updateAvailable: false };
    expect(asked()).toBeUndefined();
});

it(`leads with the version it takes you to and how much is in it, then what is new, the rest a link away`, () => {
    updateNotes.value = [
        `Approve a waiting plan from the bar above the composer; those buttons no longer appear on the plan card.`,
        `Desktop sign-in completes again instead of showing an incomplete link.`,
    ];
    moreUpdateNotes.value = 5;
    const el = mount();
    expect(el.querySelector(`h2`)?.textContent).toBe(`Intentic 1.54.0 is here`);
    expect(el.textContent).toContain(`7 improvements`);
    const heading = [...el.querySelectorAll(`h3`)].find((node) => node.textContent === `What's new`)!;
    // Each change as its own line, what it replaced a line of its own under it.
    const items = [...heading.nextElementSibling!.querySelectorAll(`li`)];
    expect(items.map((item) => [...item.lastElementChild!.children].map((line) => line.textContent))).toEqual([
        [`Approve a waiting plan from the bar above the composer`, `Those buttons no longer appear on the plan card.`],
        [`Desktop sign-in completes again instead of showing an incomplete link`],
    ]);
    const changelog = el.querySelector<HTMLAnchorElement>(`a[href="https://intentic.dev/changelog/"]`);
    expect(changelog?.textContent?.trim()).toBe(`5 more in the changelog`);
    // What is new sits under the button, never in the way of it.
    expect(el.querySelector(`[data-recreate="Update"]`)!.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it(`offers an update before developer notes, and names and folds those notes rather than calling the update a danger`, () => {
    breakingNotes.value = [`A migration detail for developers.`];
    const el = mount();
    const action = el.querySelector(`[data-recreate="Update"]`)!;
    const notes = el.querySelector(`details`)!;
    expect(recreates(el)).toEqual([`Update`]);
    expect(notes.open).toBe(false);
    expect(notes.querySelector(`summary`)?.textContent?.trim()).toBe(`One change for developers and integrations`);
    expect(notes.textContent).toContain(`A migration detail for developers.`);
    expect(action.compareDocumentPosition(notes)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(el.textContent).not.toContain(`changes how things work`);
    expect(el.querySelector(`.text-danger`)).toBeNull();
    expect([...el.querySelectorAll(`button`)].map((button) => button.textContent).join(` `)).not.toContain(`I've read what changes`);
});

it(`offers a hosted sandbox its update as the platform's restart, in the same gold`, async () => {
    active.value = { id: `sb1`, role: `owner`, hosted: { region: `ams`, warm: true } };
    const el = mount();
    const button = [...el.querySelectorAll(`button`)].find((node) => node.textContent?.trim() === `Restart and update`);
    expect(button?.classList.contains(`ui-button-gilded`)).toBe(true);
    expect(recreates(el)).toEqual([]);
    // No host keeps the version before parked for a day on the platform's machines, so that fact is not claimed.
    expect(el.textContent).toContain(`About 30 seconds of downtime`);
    expect(el.textContent).not.toContain(`Undo within 24 hours`);
});

// The platform restarts a machine it runs for the sandbox's owner alone; a maintainer's press came back "sandbox not
// found". They read the offer and whose press it is, with no button to refuse them.
it(`tells a maintainer of a hosted sandbox that its owner restarts it onto the update, with no button`, () => {
    active.value = { id: `sb1`, role: `maintainer`, hosted: { region: `ams`, warm: true } };
    const el = mount();
    expect([...el.querySelectorAll(`button`)].map((node) => node.textContent?.trim())).not.toContain(`Restart and update`);
    expect(el.textContent).toContain(`Only this sandbox's owner can restart it onto the new version: we run its machine on their account.`);
    expect(recreates(el)).toEqual([]);
});

it(`offers a maintainer the update of a sandbox on somebody's own machine, which they reach through it`, () => {
    active.value = { id: `sb1`, role: `maintainer` };
    const el = mount();
    expect(recreates(el)).toEqual([`Update`]);
    expect(el.textContent).not.toContain(`Only this sandbox's owner`);
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
    expect(el.querySelector(`details summary`)?.textContent?.trim()).toBe(`On its first boot, this update converts 2 stored files`);
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
    expect(el.textContent).toContain(`About 30 seconds of downtime`);
    expect(el.textContent).toContain(`Files and conversations stay`);
    expect(el.textContent).toContain(`Undo within 24 hours`);
    // The sentence each fact stands for, there for a reader who never hovers.
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

it(`keeps the platform's way back from a maintainer, whose rollback it would refuse`, () => {
    active.value = { id: `sb1`, role: `maintainer`, hosted: { region: `ams`, warm: true, canRollBack: true } };
    info.value = { version: LATEST, latest: LATEST, updateAvailable: false, channel: `stable` };
    const el = mount();
    expect([...el.querySelectorAll(`button`)].map((node) => node.textContent?.trim())).not.toContain(`Having trouble?`);
    expect(el.querySelector(`[data-hosted-rollback]`)).toBeNull();
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
