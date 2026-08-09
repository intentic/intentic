import type { AgentHarness, AgentProvider, Automation, AutomationSummary, WebchatConfig, WorkspaceEventKind } from "@intentic/sandbox-contract";
import { AutomationSchema, WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import { Cron } from "croner";
import { computed, type ComputedRef, reactive, watch } from "vue";
import { cronOf, defaultSchedule, parseCron } from "./cronSchedule";
import { listenerSourceOf, type ListenerSource } from "./listenerSources";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";

/* ONE automation form, for both the thing that creates automations and the thing that edits them.
 *
 * It lives here rather than inside the create dialog because there are now two callers and the fields are the
 * expensive part to keep honest: a Doorbell's origins are validated against what the daemon actually compares,
 * a cron is previewed against the same parser that will fire it, and the Advanced block knows which providers
 * have a harness to choose. A second copy of that for editing would be a second place to get it wrong, and the
 * one that got it wrong would be the one nobody re-read.
 *
 * `load` and `build` are deliberately inverse: `build` decides which fields are omitted when they carry a
 * default (an absent `agent` MEANS claude), and `load` has to put the user back in front of the same form that
 * produced the record — so a save that changes nothing must round-trip to an identical automation. */

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/* The persona a Doorbell starts on — the stock read-only card the sandbox seeds (default-personas.ts).
 *
 * A Doorbell is driven by a stranger and runs with nobody watching, so it is the one automation whose bounds
 * cannot be left to the prompt's wording. It used to carry a hidden four-tool allowlist for exactly that
 * reason; naming a persona instead does the same job in a place the owner can SEE, edit, and reuse for
 * everything else a stranger drives. Changing this row's persona is a deliberate edit, as widening the old
 * allowlist was. */
export const DOORBELL_PERSONA = `visitor`;

export type TriggerKind = `schedule` | `event` | `listener` | `workspace`;

/* WHAT A PROMPT WAS WRITTEN FOR. The kind, plus — for a listener — the source, because that is the granularity
 * at which the payload changes: Discord delivers `mentioned` and a channelId, CI delivers a branch, a sha and
 * failedJobs, and a briefing written for one describes nothing that arrives from the other. Exported because the
 * create dialog compares its picked template against it. */
export const triggerKey = (trigger: { readonly kind: TriggerKind; readonly provider?: string }): string =>
    trigger.kind === `listener` ? `listener:${trigger.provider}` : trigger.kind;

/* TEXT THE FORM PUT IN THE BOX, rather than the user — a live source's starter, a template's prompt, or nothing
 * typed yet. Compared verbatim, and that is the whole test: one keystroke makes the prompt the user's and
 * nothing here rewrites it again. */
const RECIPE_PROMPTS = new Set<string>(AUTOMATION_RECIPES.map((recipe) => recipe.prompt));
const FORM_GUARDS = new Set<string>([``, ...AUTOMATION_RECIPES.flatMap((recipe) => (recipe.guard === undefined ? [] : [recipe.guard]))]);

export function useAutomationForm(sources: ComputedRef<readonly ListenerSource[]>) {
    let original: Automation | undefined;
    const form = reactive({
        kind: `schedule` as TriggerKind,
        id: ``,
        guard: ``,
        prompt: ``,
        agent: `claude` as AgentProvider,
        // The pinned provider account, by its daemon-minted id. Blank ⇒ absent ⇒ the provider's first account,
        // which is what every automation made before this field existed keeps doing.
        account: ``,
        /* Which of the sandbox's named personas this wake RUNS AS — its accounts, its toolbox, and where in the
         * workspace it works, in one choice. Blank is strict about accounts and permissive about tools: the
         * daemon reads an unpinned unattended wake as reaching no logged-in account at all, and as keeping the
         * full toolbox. See the picker's own note for why those two defaults point opposite ways. */
        actsAs: ``,
        /* NARROW THIS ONE JOB below its persona — raw tool names, comma-separated, and empty in the ordinary
         * case. Held as the typed string rather than an array because it is an <input>: splitting on save is one
         * place, where splitting on every keystroke would fight the person typing a comma. */
        allowedTools: ``,
        harness: `native` as AgentHarness,
        model: ``,
        requireApproval: false,
        // 0 = fire instantly; positive = each fire is held, visibly and cancellably, for this many seconds.
        holdForSeconds: 0,
        provider: `discord`,
        channelId: ``,
        eventType: undefined as string | undefined,
        mentioned: false,
        // The CI trigger's second axis; ignored by every other source.
        branch: ``,
        workspaceEvent: `turn.settled` as WorkspaceEventKind,
        repo: ``,
        // Doorbell — `origins` is edited as one line per site because that is how people hold a short allowlist
        // in their head; it is split on save.
        origins: ``,
        access: `public` as `public` | `google`,
        googleClientId: ``,
        antiBot: `pow` as `off` | `pow` | `turnstile`,
        turnstileSiteKey: ``,
        turnstileSecret: ``,
        greeting: ``,
        // Blank ⇒ the daemon's WEBCHAT_DAILY_MAX_DEFAULT. Held as a string because it is an <input>: an empty
        // box has to stay distinguishable from a typed 0, which the schema rejects anyway.
        dailyMessageMax: ``,
        // Round-tripped rather than re-derived: a chore on a clock is indistinguishable from an external poll by
        // its trigger, so losing this on edit would move the row to the other shelf.
        chore: false,
    });
    const schedule = reactive(defaultSchedule());

    /* ---- derived ---- */

    const isDoorbell = computed(() => form.kind === `listener` && form.provider === `webchat`);
    const listenerSource = computed(() => listenerSourceOf(sources.value, form.provider, form.eventType));

    // The picked source's second narrowing axis, when it has one (only CI does). Drives both the extra input
    // and whether `build` writes the field at all — switching source must not leave a branch on a Discord
    // trigger, where the daemon would match it against a message that has no branch and never fire.
    const branchField = computed(() => (form.kind === `listener` ? listenerSource.value.branchField : undefined));
    const liveSources = computed(() => sources.value.filter((source) => source.available));
    const visibleSources = computed(() =>
        listenerSource.value.available
            ? liveSources.value
            : [listenerSource.value, ...liveSources.value.filter((source) => source.provider !== form.provider)],
    );

    // The typed ceiling, or undefined for "leave it to the default". Anything not a positive integer reads as
    // blank — the schema would reject it, and a silently-dropped field beats a save that fails on a keystroke.
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

    // A croner instance without a callback never schedules — it's just a queryable pattern here.
    // ponytail: preview uses the browser's timezone while the daemon fires in the sandbox's — same as the row's `next`.
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

    // The starting point for whatever is picked right now. Only a live source has one: every other trigger's
    // payload is whatever its sender POSTs, and no starter can describe that.
    const starterPrompt = computed<string | undefined>(() => (form.kind === `listener` ? listenerSource.value.starterPrompt : undefined));
    const formPrompts = computed(
        () =>
            new Set<string>([
                ...sources.value.flatMap((source) => (source.starterPrompt === undefined ? [] : [source.starterPrompt])),
                ...RECIPE_PROMPTS,
            ]),
    );

    /* Which trigger the prompt now in the box was written for. Both directions below stamp it, because filling
     * the form from a template — or from a stored automation — sets the trigger and the prompt in one go, and
     * without the stamp that reads as a trigger change and the template's own text is the first thing rewritten. */
    let promptFor = triggerKey(form);

    /* A starter is only true for the trigger it was written for, so it FOLLOWS the trigger while it is still the
     * form's to write. Seeding it once (which is what this used to do, on the trigger cards alone) is how a CI
     * automation ends up briefed on Discord messages: every other field re-renders for the new source — events,
     * channel, branch — and the prompt, the one field nothing validates, keeps the old source's text. */
    watch(
        () => triggerKey(form),
        (key) => {
            if (key === promptFor || (form.prompt !== `` && !formPrompts.value.has(form.prompt))) {
                return;
            }
            form.prompt = starterPrompt.value ?? ``;
            // A template's GUARD came with its prompt and goes with it: a jq over .intentic/drafts/ left behind on
            // a Discord listener is a row that never fires and never says why.
            if (FORM_GUARDS.has(form.guard)) {
                form.guard = ``;
            }
            promptFor = key;
        },
    );

    /* The prompt is verbatim ANOTHER source's starter: an automation made before the prompt followed the trigger,
     * or one whose prompt was edited and whose source then changed. Nothing may rewrite it — it is not the form's
     * — but it is the one mismatch that can be named, so the form offers the swap instead of leaving a Discord
     * briefing on a CI trigger to be discovered from a confused run at 3 a.m. */
    const staleStarter = computed<ListenerSource | undefined>(() => {
        if (form.kind !== `listener` || form.prompt === starterPrompt.value) {
            return undefined;
        }
        return sources.value.find((source) => source.starterPrompt === form.prompt);
    });

    // Take the picked source's starter by hand — and hand the prompt back to the form, so it keeps following.
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
    };

    const nameError = computed<string | undefined>(() => {
        const trimmed = form.id.trim();
        if (trimmed.length === 0) return `Name is required.`;
        if (!NAME_RE.test(trimmed)) return `Use letters, digits, hyphens and underscores; must start with a letter or digit.`;
        return undefined;
    });
    const promptError = computed<string | undefined>(() => (form.prompt.trim() === `` ? `Prompt is required.` : undefined));
    // An origin must be exactly what a browser puts in the Origin header — scheme + host, no path — because that
    // is what the daemon compares against. Saying so at the point of typing beats a 403 the visitor sees.
    const originsError = computed<string | undefined>(() => {
        if (!isDoorbell.value) {
            return undefined;
        }
        if (originList.value.length === 0) {
            return `Add at least one site — a Doorbell with no allowed sites admits nobody.`;
        }
        const bad = originList.value.find((origin) => !/^https?:\/\/[^/]+$/.test(origin));
        return bad === undefined ? undefined : `"${bad}" isn't an origin — use scheme + host only, e.g. https://example.com`;
    });

    const valid = computed(
        () =>
            nameError.value === undefined &&
            promptError.value === undefined &&
            originsError.value === undefined &&
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
            agent: `claude`,
            account: ``,
            actsAs: ``,
            allowedTools: ``,
            harness: `native`,
            model: ``,
            requireApproval: false,
            holdForSeconds: 0,
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

    // Prefill from a template. Only the fields a recipe actually carries — everything else keeps its default,
    // so picking a template twice can't accumulate state from the first pick.
    const loadRecipe = (recipe: AutomationRecipe): void => {
        reset();
        form.kind = recipe.trigger.kind;
        form.id = recipe.id;
        form.guard = recipe.guard ?? ``;
        form.holdForSeconds = recipe.holdForSeconds ?? 0;
        form.prompt = recipe.prompt;
        form.chore = recipe.chore === true;
        if (recipe.trigger.kind === `schedule`) {
            Object.assign(schedule, parseCron(recipe.trigger.cron));
        }
        if (recipe.trigger.kind === `listener`) {
            form.provider = recipe.trigger.provider;
            form.eventType = recipe.trigger.eventType;
        }
        if (recipe.trigger.kind === `workspace`) {
            form.workspaceEvent = recipe.trigger.event;
        }
        // The template's prompt WAS written for the trigger it just set, so this is not a trigger change.
        promptFor = triggerKey(form);
    };

    // Put the user in front of the form that produced this record. The inverse of `build` — see the note at the
    // top: a save that changes nothing must round-trip to an identical automation.
    const load = (automation: AutomationSummary | Automation): void => {
        reset();
        original = AutomationSchema.parse(automation);
        const trigger = automation.trigger;
        form.kind = trigger.kind;
        form.id = automation.id;
        form.guard = automation.guard ?? ``;
        form.prompt = automation.prompt;
        form.agent = automation.agent ?? `claude`;
        form.account = automation.account ?? ``;
        form.actsAs = automation.actsAs ?? ``;
        form.allowedTools = (automation.allowedTools ?? []).join(`, `);
        form.harness = automation.harness ?? `native`;
        form.model = automation.model ?? ``;
        form.requireApproval = automation.requireApproval === true;
        form.holdForSeconds = automation.holdForSeconds ?? 0;
        form.chore = automation.chore === true;
        if (trigger.kind === `schedule`) {
            Object.assign(schedule, parseCron(trigger.cron));
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
            // One per line, which is how the textarea presents them and how they were typed in the first place.
            form.origins = (trigger.allowedOrigins ?? []).join(`\n`);
        }
        const webchat = automation.webchat;
        if (webchat !== undefined) {
            form.access = webchat.access ?? `public`;
            form.googleClientId = webchat.googleClientId ?? ``;
            form.antiBot = webchat.antiBot ?? `off`;
            form.turnstileSiteKey = webchat.turnstileSiteKey ?? ``;
            // A stored secret never comes back from the daemon in readable form, so an empty box here means
            // "unchanged", not "cleared" — see `build`.
            form.turnstileSecret = webchat.turnstileSecret ?? ``;
            form.greeting = webchat.greeting ?? ``;
            form.dailyMessageMax = webchat.dailyMessageMax === undefined ? `` : String(webchat.dailyMessageMax);
        }
        // This prompt is the OWNER's, written for the trigger it is stored with — so opening the editor is not a
        // trigger change either. Changing the source from in here still re-writes a prompt nobody has touched
        // since a template wrote it, and never one that was typed.
        promptFor = triggerKey(form);
    };

    const webchatOf = (): WebchatConfig => {
        const webchat: WebchatConfig = { ...original?.webchat, access: form.access };
        if (form.antiBot === `off`) {
            delete webchat.antiBot;
        } else {
            webchat.antiBot = form.antiBot;
        }
        if (form.googleClientId.trim() === ``) delete webchat.googleClientId;
        else webchat.googleClientId = form.googleClientId.trim();
        if (form.turnstileSiteKey.trim() === ``) delete webchat.turnstileSiteKey;
        else webchat.turnstileSiteKey = form.turnstileSiteKey.trim();
        // A stripped secret is an empty input meaning "unchanged". A supplied one replaces it.
        if (form.turnstileSecret.trim() !== ``) webchat.turnstileSecret = form.turnstileSecret.trim();
        if (form.greeting.trim() === ``) delete webchat.greeting;
        else webchat.greeting = form.greeting.trim();
        if (dailyMessageMax.value === undefined) delete webchat.dailyMessageMax;
        else webchat.dailyMessageMax = dailyMessageMax.value;
        return webchat;
    };

    // The record to upsert. The editor owns the fields it exposes and carries every opaque field from the loaded
    // record through untouched. Identity-bearing values (the webhook token and enabled state) never change as a
    // side effect of editing some other field.
    const build = (): Automation => {
        const trigger: Automation["trigger"] =
            form.kind === `schedule`
                ? { kind: `schedule`, cron: effectiveCron.value as string }
                : form.kind === `event`
                  ? {
                        kind: `event`,
                        ...(original?.trigger.kind === `event` && original.trigger.token !== undefined ? { token: original.trigger.token } : {}),
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
                          // The Doorbell's admission list lives on the trigger, beside the provider it gates.
                          ...(isDoorbell.value ? { allowedOrigins: originList.value } : {}),
                      };
        // Start with the stored record so a field added to the contract is preserved until the editor explicitly
        // owns it. The assignments below are the complete set this form does own, including clearing defaults.
        const automation: Automation = {
            ...original,
            id: form.id.trim(),
            trigger,
            prompt: form.prompt,
            enabled: original?.enabled ?? true,
        };
        if (form.guard.trim() === ``) delete automation.guard;
        else automation.guard = form.guard.trim();
        if (form.agent === `claude`) {
            delete automation.agent;
            delete automation.harness;
        } else {
            automation.agent = form.agent;
            if (form.harness === `native`) delete automation.harness;
            else automation.harness = form.harness;
        }
        // Blank ⇒ absent ⇒ the provider's first account, independent of which provider is selected.
        if (form.account === ``) delete automation.account;
        else automation.account = form.account;
        // Blank ⇒ absent ⇒ no outward accounts at all (see the form state's note) — the one field here whose
        // default is to take something away rather than to leave it unspecified.
        if (form.actsAs === ``) delete automation.actsAs;
        else automation.actsAs = form.actsAs;
        // Empty ⇒ absent ⇒ whatever the persona allows. A list here is applied ON TOP of the card, so it can
        // only ever narrow — which is why the field is offered at all and why it needs no validation against it.
        const narrowed = form.allowedTools
            .split(`,`)
            .map((name) => name.trim())
            .filter((name) => name !== ``);
        if (narrowed.length > 0) automation.allowedTools = narrowed;
        else delete automation.allowedTools;
        if (form.model === ``) delete automation.model;
        else automation.model = form.model;
        if (form.requireApproval) automation.requireApproval = true;
        else delete automation.requireApproval;
        if (form.holdForSeconds > 0) automation.holdForSeconds = form.holdForSeconds;
        else delete automation.holdForSeconds;
        // A workspace trigger is a chore by definition; clock-based chores carry the stored form flag.
        if (form.kind === `workspace` || form.chore) automation.chore = true;
        else delete automation.chore;
        if (isDoorbell.value) {
            automation.webchat = webchatOf();
            /* A Doorbell that named no persona gets the read-only one. The owner's own choice always stands —
             * a Doorbell deliberately pointed at a card with more powers is a decision they made on a visible
             * field — so this fills a blank rather than overriding an answer. */
            if (automation.actsAs === undefined) {
                automation.actsAs = DOORBELL_PERSONA;
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
        isDoorbell,
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
        valid,
        // directions
        reset,
        load,
        loadRecipe,
        build,
    };
}

export type AutomationFormState = ReturnType<typeof useAutomationForm>;
