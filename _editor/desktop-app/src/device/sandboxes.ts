import { type DeviceSandboxGroup, type ResourcesForm, type SandboxVerb, sandboxVerbPrompt, type SandboxVerbPrompt, VERB_LABEL } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ref } from "vue";
import { track } from "../analytics";
import { sandboxLogs, sandboxPower, sandboxRecreate, sandboxRemove, sandboxResize, takePendingRecreate } from "../desktop";
import { linesOf, running, runOutcome, start } from "./runs";

// WHAT THIS DEVICE DOES TO ITS SANDBOXES: the verbs the kit draws on each row (SandboxVerbs), done here by the app's own
// scripts through `ic`, where the workspace's Devices tab sends the same verbs to the machine agent over its socket.
// Start, stop, restart, update, rollback, resources, logs and remove, each one run reported like every other (runs.ts).

// Tail length asked of docker; matches what the machine agent uses for the same button.
const LOG_TAIL_LINES = 200;

// Which run id each verb reports under; kept as legacy ids since analytics and `intentic://recreate` depend on them. A
// resize is a recreate (same image, different share), so it runs under the recreate id.
const RUN_OF = {
    start: (slug: string) => `power:${slug}`,
    stop: (slug: string) => `power:${slug}`,
    restart: (slug: string) => `power:${slug}`,
    update: (slug: string) => `recreate:${slug}`,
    rollback: (slug: string) => `recreate:${slug}`,
    resources: (slug: string) => `recreate:${slug}`,
    remove: (slug: string) => `remove:${slug}`,
} satisfies Readonly<Record<Exclude<SandboxVerb, `logs`>, (slug: string) => string>>;

/** The row working now, and which of its verbs. */
export const busy = ref<{ readonly slug: string; readonly verb: SandboxVerb } | undefined>(undefined);
// A log tail is remembered by slug, not by whichever row is busy, since it outlives its own run.
const openLog = ref<string | undefined>(undefined);
const logLines = ref<Record<string, string[]>>({});
/** A row's own failure message, kept beside that row rather than at the foot of the page. */
export const rowFailure = ref<{ readonly slug: string; readonly message: string } | undefined>(undefined);
/** The row whose Resources form is open, until Apply, Save or Cancel answers it. */
export const resizing = ref<DeviceSandboxGroup | undefined>(undefined);

// The docker row behind a view group, which every verb below needs.
const slugOf = (group: DeviceSandboxGroup): string | undefined => group.sandbox?.slug;

// A run on a row, and its failure beside that row.
const onRow = async (slug: string, verb: SandboxVerb, run: string, action: () => Promise<void>): Promise<string | undefined> => {
    busy.value = { slug, verb };
    const failure = await start(run, action);
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
    return failure;
};

// `source` distinguishes a click here from the workspace's Update or Environment card handing it over.
const recreate = async (slug: string, hash: string | undefined, rollback: boolean, source: `manager` | `link`): Promise<void> => {
    const startedAt = Date.now();
    // Mode mirrors the script's argument shape: a hash means the approved overlay, rollback the pre-update image.
    const mode = rollback ? `rollback` : hash === undefined ? `update` : `rebuild`;
    track(`desktop_recreate_started`, { mode, source });
    const failure = await onRow(slug, rollback ? `rollback` : `update`, `recreate:${slug}`, () => sandboxRecreate(slug, hash, rollback));
    track(`desktop_recreate_finished`, { mode, source, ...runOutcome(`recreate:${slug}`, failure === undefined, startedAt) });
};

// The form's whole share through `ic sandbox shape`: applied now (the same recreate, a different share; reported as
// `mode: "reshape"` so restart-counting funnels include it), or saved for the next restart through ic, or forgotten
// (`save` with none), neither of which restarts anything.
const resize = async (slug: string, form: ResourcesForm | undefined, when: `now` | `nextRestart`): Promise<void> => {
    const startedAt = Date.now();
    const mode = when === `now` ? `reshape` : `save-shape`;
    track(`desktop_recreate_started`, { mode, source: `manager` });
    const failure = await onRow(slug, `resources`, RUN_OF.resources(slug), () => sandboxResize(slug, form, when));
    track(`desktop_recreate_finished`, { mode, source: `manager`, ...runOutcome(RUN_OF.resources(slug), failure === undefined, startedAt) });
};

// Apply restarts onto the form's share now; Save has ic keep it for the next restart (none: forget what is saved). The
// listing is ic's, so a saved share is what the form opens on.
const resizeWith = async (form: ResourcesForm | undefined, when: `now` | `nextRestart`): Promise<void> => {
    const slug = resizing.value === undefined ? undefined : slugOf(resizing.value);
    resizing.value = undefined;
    if (slug === undefined || busy.value !== undefined || running.value) {
        return;
    }
    // A log pane for a row that's about to change is now stale.
    openLog.value = undefined;
    rowFailure.value = undefined;
    await resize(slug, form, when);
};
export const applyResources = (form: ResourcesForm): Promise<void> => resizeWith(form, `now`);
export const saveResources = (form: ResourcesForm | undefined): Promise<void> => resizeWith(form, `nextRestart`);
export const cancelResources = (): void => {
    resizing.value = undefined;
};

/** The workspace's copy-paste cards arriving as a click: taken, not read, so coming back here doesn't re-run one. */
export const drainRecreate = async (): Promise<void> => {
    const requested = await takePendingRecreate();
    if (requested === null || running.value) {
        return;
    }
    await recreate(requested.slug, requested.hash, requested.rollback, `link`);
};

// A log tail is a toggle, not a run: opened before its lines arrive, so an empty pane reads as "reading", not ignored.
const toggleLogs = async (slug: string): Promise<void> => {
    if (openLog.value === slug) {
        openLog.value = undefined;
        return;
    }
    openLog.value = slug;
    logLines.value = { ...logLines.value, [slug]: [] };
    busy.value = { slug, verb: `logs` };
    const text = await sandboxLogs(slug, LOG_TAIL_LINES).catch(String);
    logLines.value = { ...logLines.value, [slug]: text.split(/\r?\n/).filter(Boolean) };
    busy.value = undefined;
};

// The kit's removal prompt is worded for the web, about "that device". Here the machine is this one and the slug is
// known, so the body names the exact command that brings the sandbox back out of ic's trash within the week.
const promptFor = (verb: SandboxVerb, name: string, slug: string): SandboxVerbPrompt | undefined => {
    const asked = sandboxVerbPrompt(verb, name);
    return verb === `remove` && asked !== undefined ? { header: asked.header, body: t(`desktop.app.removesSandboxKeepsFiles`, { slug }) } : asked;
};

// A verb that changes a row, the ones a press can ask about first.
type RowChange = Exclude<SandboxVerb, `logs` | `resources`>;

// A verb that asks first (stop, remove, rollback…) asks in the system's own dialog, worded as the web tab's.
const agreed = async (verb: RowChange, group: DeviceSandboxGroup, slug: string): Promise<boolean> => {
    const asked = promptFor(verb, group.title, slug);
    return asked === undefined || (await confirm(asked.body, { title: asked.header, kind: `warning`, okLabel: VERB_LABEL[verb] }));
};

// A verb that changes the row, once it is agreed to.
const change = async (slug: string, verb: RowChange): Promise<void> => {
    // A log pane for a row that's about to change is now stale.
    openLog.value = undefined;
    rowFailure.value = undefined;
    if (verb === `update` || verb === `rollback`) {
        await recreate(slug, undefined, verb === `rollback`, `manager`);
        return;
    }
    await onRow(slug, verb, RUN_OF[verb](slug), verb === `remove` ? () => sandboxRemove(slug) : () => sandboxPower(slug, verb));
};

/** One click on one row: the kit decides which buttons exist and what they ask; this decides what each does here. */
export const act = async (group: DeviceSandboxGroup, verb: SandboxVerb): Promise<void> => {
    const slug = slugOf(group);
    if (slug === undefined || busy.value !== undefined || running.value) {
        return;
    }
    if (verb === `logs`) {
        await toggleLogs(slug);
        return;
    }
    if (verb === `resources`) {
        // A container docker did not describe (its inspect failed) has nothing to open the form on, and says so where
        // every other refusal on this row lands.
        if (group.sandbox?.resources === undefined) {
            rowFailure.value = { slug, message: t(`desktop.app.dockerDidntDescribeSandboxs`) };
            return;
        }
        resizing.value = group;
        return;
    }
    if (await agreed(verb, group, slug)) {
        await change(slug, verb);
    }
};

/** Which of this row's buttons is spinning: a row has one thing to say. */
export const busyVerb = (group: DeviceSandboxGroup): SandboxVerb | undefined => {
    const inFlight = busy.value;
    return inFlight !== undefined && inFlight.slug === slugOf(group) ? inFlight.verb : undefined;
};
export const logOpen = (group: DeviceSandboxGroup): boolean => openLog.value !== undefined && openLog.value === slugOf(group);
/** The machine's own output under a row: its run while it works, its log tail while that is open. */
export const paneLines = (group: DeviceSandboxGroup): string[] => {
    const slug = slugOf(group);
    const verb = busyVerb(group);
    if (slug === undefined) {
        return [];
    }
    if (verb !== undefined && verb !== `logs`) {
        return linesOf(RUN_OF[verb](slug));
    }
    return logLines.value[slug] ?? [];
};
