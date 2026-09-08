import type { Automation, AutomationSummary, AutomationTemplate, ModelPin, WebchatConfig, WorkspaceEventKind } from "@intentic/sandbox-contract";
import { AutomationSchema, FRONT_DESK_PERSONA, WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import { Cron } from "croner";
import { computed, type ComputedRef, reactive, watch } from "vue";
import { type AvailableSource, listenerSourceOf } from "./catalog";
import { cronOf, defaultSchedule, parseCron } from "./cronSchedule";

// One automation form for the create dialog and the edit dialog. `load` and `build` are inverse: `build` omits fields
// at their default, `load` reconstructs the same form so an unchanged save round-trips to an identical automation.

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export type TriggerKind = `schedule` | `event` | `listener` | `workspace`;

// What a prompt was written for: kind, plus source for a listener since payload shape differs per source (Discord's
// mentioned+channelId vs CI's branch/sha/failedJobs). Exported for the create dialog's template comparison.
export const triggerKey = (trigger: { readonly kind: TriggerKind; readonly provider?: string }): string =>
    trigger.kind === `listener` ? `listener:${trigger.provider}` : trigger.kind;

// The form's own text (starters and templates) now comes from the daemon's catalogue, so it's computed per call rather
// than a module constant; a just-installed pack's template must count as form-owned text too.
export function useAutomationForm(sources: ComputedRef<readonly AvailableSource[]>, templates: ComputedRef<readonly AutomationTemplate[]>) {
    // Text the form put in the box (starter or template prompt); compared verbatim to detect a user edit.
    const templatePrompts = computed(() => new Set<string>(templates.value.map((template) => template.prompt)));
    const formGuards = computed(
        () => new Set<string>([``, ...templates.value.flatMap((template) => (template.guard === undefined ? [] : [template.guard]))]),
    );
    let original: Automation | undefined;
    const form = reactive({
        kind: `schedule` as TriggerKind,
        id: ``,
        // No UI for this: kept only so gallery chores (e.g. knip-based guards) still reach `build` intact.
        guard: ``,
        prompt: ``,
        // Replaces provider/harness/model; each rung is a full ModelPin, and the list must never be empty.
        models: [] as ModelPin[],
        // Pinned account by its daemon-minted id; blank ⇒ absent ⇒ the provider's first account.
        account: ``,
        // Persona this wake runs as; blank means no logged-in account but the full toolbox.
        actsAs: ``,
        // Comma-separated tool names narrowing the persona; held as typed string, not array, split only at save.
        allowedTools: ``,
        requireApproval: false,
        // 0 = fire instantly; positive = each fire is held, visibly and cancellably, for this many seconds.
        holdForSeconds: 0,
        // Schedule's session bar: 0 fires every occurrence; positive skips until that many new sessions have run.
        afterSessions: 0,
        provider: `discord`,
        channelId: ``,
        eventType: undefined as string | undefined,
        mentioned: false,
        // The CI trigger's second axis; ignored by every other source.
        branch: ``,
        workspaceEvent: `turn.settled` as WorkspaceEventKind,
        repo: ``,
        // Edited as one line per site, split into a list on save.
        origins: ``,
        access: `public` as `public` | `google`,
        googleClientId: ``,
        antiBot: `pow` as `off` | `pow` | `turnstile`,
        turnstileSiteKey: ``,
        turnstileSecret: ``,
        greeting: ``,
        // Blank ⇒ daemon's WEBCHAT_DAILY_MAX_DEFAULT; held as a string so an empty box differs from a typed 0.
        dailyMessageMax: ``,
        // Round-tripped, not re-derived: a clock-based chore looks identical to an external poll trigger-wise.
        chore: false,
    });
    const schedule = reactive(defaultSchedule());

    /* ---- derived ---- */

    const isFrontDesk = computed(() => form.kind === `listener` && form.provider === `webchat`);
    const listenerSource = computed(() => listenerSourceOf(sources.value, form.provider, form.eventType));

    // Drives the branch input and whether `build` writes it; undefined when the source has no branch axis.
    const branchField = computed(() => (form.kind === `listener` ? listenerSource.value.branchField : undefined));
    const liveSources = computed(() => sources.value.filter((source) => source.available));
    const visibleSources = computed(() =>
        listenerSource.value.available
            ? liveSources.value
            : [listenerSource.value, ...liveSources.value.filter((source) => source.provider !== form.provider)],
    );

    // Typed ceiling, or undefined to leave the default; anything not a positive integer reads as blank.
    const dailyMessageMax = computed<number | undefined>(() => {
        const typed = Number(form.dailyMessageMax.trim());
        return form.dailyMessageMax.trim() !== `` && Number.isInteger(typed) && typed > 0 ? typed : undefined;
    });

    const originList = computed(() =>
        form.origins
            .split(/[\n,]/)
            .map((origin) => origin.trim().replace(/\/$/, ``))
            .filter((origin) => origin !== ``),
    );

    const effectiveCron = computed(() => cronOf(schedule));
    // Schedule trigger's two halves (clock, bar) read into the form and written back by one function each way.
    const loadSchedule = (trigger: { readonly cron: string; readonly afterSessions?: number }): void => {
        Object.assign(schedule, parseCron(trigger.cron));
        form.afterSessions = trigger.afterSessions ?? 0;
    };
    const scheduleTrigger = (): Automation[`trigger`] => ({
        kind: `schedule`,
        cron: effectiveCron.value as string,
        ...(form.afterSessions > 0 ? { afterSessions: form.afterSessions } : {}),
    });

    // A callback-less Cron is only a queryable pattern; preview uses the browser's timezone, not the sandbox's.
    const cronPreview = computed<{ runs: number[] } | { error: string } | undefined>(() => {
        const cron = effectiveCron.value;
        if (form.kind !== `schedule` || cron === undefined) {
            return undefined;
        }
        try {
            const runs = new Cron(cron).nextRuns(3).map((date) => date.getTime());
            return runs.length > 0 ? { runs } : { error: `This schedule never fires.` };
        } catch {
            return { error: `Invalid cron expression.` };
        }
    });

    /* ---- the prompt follows the trigger ---- */

    // Only a live source has a starter; other triggers' payloads come from the sender, not a template.
    const starterPrompt = computed<string | undefined>(() => (form.kind === `listener` ? listenerSource.value.starterPrompt : undefined));
    const formPrompts = computed(
        () =>
            new Set<string>([
                ...sources.value.flatMap((source) => (source.starterPrompt === undefined ? [] : [source.starterPrompt])),
                ...templatePrompts.value,
            ]),
    );

    // Stamped together with the trigger; otherwise the assignment itself reads as a trigger change.
    let promptFor = triggerKey(form);

    // A starter follows the trigger only while it stays true; nothing validates the prompt itself.
    watch(
        () => triggerKey(form),
        (key) => {
            if (key === promptFor || (form.prompt !== `` && !formPrompts.value.has(form.prompt))) {
                return;
            }
            form.prompt = starterPrompt.value ?? ``;
            // A guard leaves with its prompt; a stale guard on another trigger silently blocks every firing.
            if (formGuards.value.has(form.guard)) {
                form.guard = ``;
            }
            promptFor = key;
        },
    );

    // True when the prompt is verbatim another source's starter (pre-existing or after a source change); offers a swap
    // instead of silently rewriting.
    const staleStarter = computed<AvailableSource | undefined>(() => {
        if (form.kind !== `listener` || form.prompt === starterPrompt.value) {
            return undefined;
        }
        return sources.value.find((source) => source.starterPrompt === form.prompt);
    });

    // Applies the current source's starter and re-stamps promptFor so it keeps following.
    const applyStarter = (): void => {
        form.prompt = starterPrompt.value ?? ``;
        promptFor = triggerKey(form);
    };

    /* ---- validation ---- */

    const touched = reactive(new Set<string>());
    const markTouched = (key: string): void => void touched.add(key);
    const touchAll = (): void => {
        touched.add(`name`);
        touched.add(`prompt`);
        touched.add(`origins`);
        // Required like the other touched fields, so an empty ladder's refusal has a visible reason.
        touched.add(`models`);
    };

    const nameError = computed<string | undefined>(() => {
        const trimmed = form.id.trim();
        if (trimmed.length === 0) {
            return `Name is required.`;
        }
        if (!NAME_RE.test(trimmed)) {
            return `Use letters, digits, hyphens and underscores; must start with a letter or digit.`;
        }
        return undefined;
    });
    const promptError = computed<string | undefined>(() => (form.prompt.trim() === `` ? `Prompt is required.` : undefined));
    // Must match exactly what a browser sends in the Origin header: scheme + host, no path, since that's what the
    // daemon compares.
    const originsError = computed<string | undefined>(() => {
        if (!isFrontDesk.value) {
            return undefined;
        }
        if (originList.value.length === 0) {
            return `Add at least one site: a Front Desk with no allowed sites admits nobody.`;
        }
        const bad = originList.value.find((origin) => !/^https?:\/\/[^/]+$/.test(origin));
        return bad === undefined ? undefined : `"${bad}" isn't an origin, use scheme + host only, e.g. https://example.com`;
    });

    // The one error about spending rather than syntax: no sandbox-wide tier to fall back on, so an empty ladder must
    // refuse. Enforced here too, not just in the schema, so the refusal happens at save with an actionable message.
    const modelsError = computed<string | undefined>(() =>
        form.models.length === 0 ? `Pick at least one model: an automation runs while nobody is watching, so nothing is chosen for it.` : undefined,
    );

    const valid = computed(
        () =>
            nameError.value === undefined &&
            promptError.value === undefined &&
            originsError.value === undefined &&
            modelsError.value === undefined &&
            (form.kind !== `schedule` || (cronPreview.value !== undefined && `runs` in cronPreview.value)),
    );

    /* ---- the two directions ---- */

    const reset = (): void => {
        original = undefined;
        Object.assign(form, {
            kind: `schedule`,
            id: ``,
            guard: ``,
            prompt: ``,
            // Empty: a template can't know which providers this sandbox has connected, so it never fills this.
            models: [],
            account: ``,
            actsAs: ``,
            allowedTools: ``,
            requireApproval: false,
            holdForSeconds: 0,
            afterSessions: 0,
            provider: `discord`,
            channelId: ``,
            eventType: undefined,
            mentioned: false,
            branch: ``,
            workspaceEvent: `turn.settled`,
            repo: ``,
            origins: ``,
            access: `public`,
            googleClientId: ``,
            antiBot: `pow`,
            turnstileSiteKey: ``,
            turnstileSecret: ``,
            greeting: ``,
            dailyMessageMax: ``,
            chore: false,
        });
        Object.assign(schedule, defaultSchedule());
        touched.clear();
    };

    // Prefills only the fields a template carries; everything else resets first, so picking twice can't accumulate
    // state. `chore` is carried, not inferred: a schedule trigger alone can't tell a dependency sweep from an external
    // poll.
    const loadTemplate = (template: AutomationTemplate): void => {
        reset();
        form.kind = template.trigger.kind;
        form.id = template.id;
        form.guard = template.guard ?? ``;
        form.holdForSeconds = template.holdForSeconds ?? 0;
        form.prompt = template.prompt;
        form.chore = template.chore === true;
        if (template.trigger.kind === `schedule`) {
            loadSchedule(template.trigger);
        }
        if (template.trigger.kind === `listener`) {
            form.provider = template.trigger.provider;
            form.eventType = template.trigger.eventType;
        }
        if (template.trigger.kind === `workspace`) {
            form.workspaceEvent = template.trigger.event;
        }
        // The template's prompt was written for the trigger it just set, so this isn't a trigger change.
        promptFor = triggerKey(form);
    };

    // Puts the user back in front of the form that produced this record, the inverse of `build`: a save that changes
    // nothing must round-trip identically.
    const load = (automation: AutomationSummary | Automation): void => {
        reset();
        original = AutomationSchema.parse(automation);
        const trigger = automation.trigger;
        form.kind = trigger.kind;
        form.id = automation.id;
        form.guard = automation.guard ?? ``;
        form.prompt = automation.prompt;
        // Copied, not aliased: the picker edits in place, and a cancelled edit must not touch the stored record.
        form.models = automation.models.map((pin) => ({ ...pin }));
        form.account = automation.account ?? ``;
        form.actsAs = automation.actsAs ?? ``;
        form.allowedTools = (automation.allowedTools ?? []).join(`, `);
        form.requireApproval = automation.requireApproval === true;
        form.holdForSeconds = automation.holdForSeconds ?? 0;
        form.chore = automation.chore === true;
        if (trigger.kind === `schedule`) {
            loadSchedule(trigger);
        }
        if (trigger.kind === `workspace`) {
            form.workspaceEvent = trigger.event;
            form.repo = trigger.repo ?? ``;
        }
        if (trigger.kind === `listener`) {
            form.provider = trigger.provider;
            form.eventType = trigger.eventType;
            form.mentioned = trigger.mentioned === true;
            form.channelId = trigger.channelId ?? ``;
            form.branch = trigger.branch ?? ``;
            // One per line, matching how the textarea presents and how they were typed.
            form.origins = (trigger.allowedOrigins ?? []).join(`\n`);
        }
        const webchat = automation.webchat;
        if (webchat !== undefined) {
            form.access = webchat.access ?? `public`;
            form.googleClientId = webchat.googleClientId ?? ``;
            form.antiBot = webchat.antiBot ?? `off`;
            form.turnstileSiteKey = webchat.turnstileSiteKey ?? ``;
            // A stored secret never comes back readable, so an empty box here means unchanged, not cleared.
            form.turnstileSecret = webchat.turnstileSecret ?? ``;
            form.greeting = webchat.greeting ?? ``;
            form.dailyMessageMax = webchat.dailyMessageMax === undefined ? `` : String(webchat.dailyMessageMax);
        }
        // This prompt is the owner's, stored with this trigger, so opening the editor isn't a trigger change either.
        promptFor = triggerKey(form);
    };

    const webchatOf = (): WebchatConfig => {
        const webchat: WebchatConfig = { ...original?.webchat, access: form.access };
        if (form.antiBot === `off`) {
            delete webchat.antiBot;
        } else {
            webchat.antiBot = form.antiBot;
        }
        if (form.googleClientId.trim() === ``) {
            delete webchat.googleClientId;
        } else {
            webchat.googleClientId = form.googleClientId.trim();
        }
        if (form.turnstileSiteKey.trim() === ``) {
            delete webchat.turnstileSiteKey;
        } else {
            webchat.turnstileSiteKey = form.turnstileSiteKey.trim();
        }
        // A stripped secret is an empty input meaning "unchanged". A supplied one replaces it.
        if (form.turnstileSecret.trim() !== ``) {
            webchat.turnstileSecret = form.turnstileSecret.trim();
        }
        if (form.greeting.trim() === ``) {
            delete webchat.greeting;
        } else {
            webchat.greeting = form.greeting.trim();
        }
        if (dailyMessageMax.value === undefined) {
            delete webchat.dailyMessageMax;
        } else {
            webchat.dailyMessageMax = dailyMessageMax.value;
        }
        return webchat;
    };

    // Record to upsert: keeps every opaque field from the loaded record, overwriting only what the editor exposes.
    // Enabled never changes as a side effect; the webhook token stays at the daemon's door, never here.
    const build = (): Automation => {
        const trigger: Automation["trigger"] =
            form.kind === `schedule`
                ? scheduleTrigger()
                : form.kind === `event`
                  ? {
                        kind: `event`,
                        ...(original?.trigger.kind === `event` && original.trigger.dailyMax !== undefined ? { dailyMax: original.trigger.dailyMax } : {}),
                    }
                  : form.kind === `workspace`
                    ? { kind: `workspace`, event: form.workspaceEvent, ...(form.repo.trim() !== `` ? { repo: form.repo.trim() } : {}) }
                    : {
                          kind: `listener`,
                          provider: form.provider,
                          ...(form.eventType !== undefined ? { eventType: form.eventType } : {}),
                          ...(form.eventType === `message` && form.mentioned ? { mentioned: true } : {}),
                          ...(form.channelId.trim() !== `` ? { channelId: form.channelId.trim() } : {}),
                          ...(branchField.value !== undefined && form.branch.trim() !== `` ? { branch: form.branch.trim() } : {}),
                          // The Front Desk's admission list lives on the trigger, beside the provider it gates.
                          ...(isFrontDesk.value ? { allowedOrigins: originList.value } : {}),
                      };
        // Starts from the stored record, so a newly added contract field survives until explicitly owned.
        const automation: Automation = {
            ...original,
            id: form.id.trim(),
            trigger,
            prompt: form.prompt,
            // Copied, not aliased, so a later form edit can't reach a record already handed to the caller.
            models: form.models.map((pin) => ({ ...pin })),
            enabled: original?.enabled ?? true,
        };
        if (form.guard.trim() === ``) {
            delete automation.guard;
        } else {
            automation.guard = form.guard.trim();
        }
        // Blank ⇒ absent ⇒ the account with the most headroom. An account id only makes sense for a single provider, so
        // a ladder spanning providers clears the pin instead of naming an account the wrong provider has never heard
        // of.
        const oneProvider = new Set(form.models.map((pin) => pin.provider)).size <= 1;
        if (form.account === `` || !oneProvider) {
            delete automation.account;
        } else {
            automation.account = form.account;
        }
        // Blank ⇒ absent ⇒ no outward accounts at all; the one field here whose default takes something away.
        if (form.actsAs === ``) {
            delete automation.actsAs;
        } else {
            automation.actsAs = form.actsAs;
        }
        // Empty ⇒ absent ⇒ whatever the persona allows; a list here only narrows, never widens, the toolbox.
        const narrowed = form.allowedTools
            .split(`,`)
            .map((name) => name.trim())
            .filter((name) => name !== ``);
        if (narrowed.length > 0) {
            automation.allowedTools = narrowed;
        } else {
            delete automation.allowedTools;
        }
        if (form.requireApproval) {
            automation.requireApproval = true;
        } else {
            delete automation.requireApproval;
        }
        if (form.holdForSeconds > 0) {
            automation.holdForSeconds = form.holdForSeconds;
        } else {
            delete automation.holdForSeconds;
        }
        // A workspace trigger is a chore by definition; clock-based chores carry the stored form flag.
        if (form.kind === `workspace` || form.chore) {
            automation.chore = true;
        } else {
            delete automation.chore;
        }
        if (isFrontDesk.value) {
            automation.webchat = webchatOf();
            // A Front Desk with no persona gets FRONT_DESK_PERSONA, written by the daemon on save if the workspace
            // lacks one yet. Only fills a blank: an owner's own choice of a stronger persona stands.
            if (automation.actsAs === undefined) {
                automation.actsAs = FRONT_DESK_PERSONA;
            }
        } else {
            delete automation.webchat;
        }
        return automation;
    };

    return {
        form,
        schedule,
        // derived
        isFrontDesk,
        listenerSource,
        branchField,
        liveSources,
        visibleSources,
        originList,
        effectiveCron,
        cronPreview,
        dailyMessageMaxDefault: WEBCHAT_DAILY_MAX_DEFAULT,
        // the prompt's relationship to the trigger
        triggerKey: computed(() => triggerKey(form)),
        starterPrompt,
        staleStarter,
        applyStarter,
        // validation
        touched,
        markTouched,
        touchAll,
        nameError,
        promptError,
        originsError,
        modelsError,
        valid,
        // directions
        reset,
        load,
        loadTemplate,
        build,
    };
}

export type AutomationFormState = ReturnType<typeof useAutomationForm>;
