import type { AgentHarness, AgentProvider, Automation, AutomationSummary, WorkspaceEventKind } from "@intentic/sandbox-contract";
import { WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import { Cron } from "croner";
import { computed, reactive } from "vue";
import { cronOf, defaultSchedule, parseCron } from "./cronSchedule";
import { host } from "./host";
import { type ListenerEventType, LISTENER_SOURCES } from "./listenerSources";
import type { AutomationRecipe } from "./recipes";

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

// What a Doorbell may do while a stranger drives it. Deliberately read-only: an automation turn runs
// bypassPermissions, so without an allowlist a support question is a shell on the sandbox. Widening it is a
// deliberate edit of the automation, not a default.
export const DOORBELL_TOOLS = [`Read`, `Grep`, `Glob`, `WebFetch`] as const;

export type TriggerKind = `schedule` | `event` | `listener` | `workspace`;

export function useAutomationForm() {
    const capabilities = computed(() => host().workspace.capabilities());

    const form = reactive({
        kind: `schedule` as TriggerKind,
        id: ``,
        guard: ``,
        prompt: ``,
        agent: `claude` as AgentProvider,
        harness: `native` as AgentHarness,
        model: ``,
        requireApproval: false,
        provider: `discord` as keyof typeof LISTENER_SOURCES,
        channelId: ``,
        eventType: undefined as ListenerEventType | undefined,
        mentioned: false,
        // The CI trigger's second axis (LISTENER_SOURCES.ci.branchField); ignored by every other source.
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

    // The picked source's second narrowing axis, when it has one (only CI does). Drives both the extra input
    // and whether `build` writes the field at all — switching source must not leave a branch on a Discord
    // trigger, where the daemon would match it against a message that has no branch and never fire.
    const branchField = computed(() => (form.kind === `listener` ? LISTENER_SOURCES[form.provider].branchField : undefined));

    const liveSources = computed(() => {
        const connected = new Set(capabilities.value.map((capability) => capability.config[`provider`]));
        return (Object.keys(LISTENER_SOURCES) as (keyof typeof LISTENER_SOURCES)[])
            .filter(
                (provider) =>
                    // A core source has nothing to connect (the Doorbell's "connection" is a script tag on the
                    // customer's site), so it is always offered; the rest wait for their capability.
                    LISTENER_SOURCES[provider].core === true ||
                    (LISTENER_SOURCES[provider].providers ?? [provider]).some((capability) => connected.has(capability)),
            )
            .map((provider) => Object.assign({ provider }, LISTENER_SOURCES[provider]));
    });

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

    // Only codex/grok have both a native runtime and a routed one to switch between. Claude IS the Claude Code
    // loop, and kimi/gemini only ever run on it — so none of the three has a harness to choose.
    const harnessChoosable = computed(() => form.agent === `codex` || form.agent === `grok`);

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
        Object.assign(form, {
            kind: `schedule`,
            id: ``,
            guard: ``,
            prompt: ``,
            agent: `claude`,
            harness: `native`,
            model: ``,
            requireApproval: false,
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
    };

    // Put the user in front of the form that produced this record. The inverse of `build` — see the note at the
    // top: a save that changes nothing must round-trip to an identical automation.
    const load = (automation: AutomationSummary | Automation): void => {
        reset();
        const trigger = automation.trigger;
        form.kind = trigger.kind;
        form.id = automation.id;
        form.guard = automation.guard ?? ``;
        form.prompt = automation.prompt;
        form.agent = automation.agent ?? `claude`;
        form.harness = automation.harness ?? `native`;
        form.model = automation.model ?? ``;
        form.requireApproval = automation.requireApproval === true;
        form.chore = automation.chore === true;
        if (trigger.kind === `schedule`) {
            Object.assign(schedule, parseCron(trigger.cron));
        }
        if (trigger.kind === `workspace`) {
            form.workspaceEvent = trigger.event;
            form.repo = trigger.repo ?? ``;
        }
        if (trigger.kind === `listener`) {
            form.provider = trigger.provider as keyof typeof LISTENER_SOURCES;
            form.eventType = trigger.eventType as ListenerEventType | undefined;
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
    };

    // The record to upsert. Fields carrying a default stay ABSENT rather than being written explicitly, so an
    // automation's stored shape doesn't drift as the defaults move.
    const build = (): Automation => ({
        id: form.id.trim(),
        trigger:
            form.kind === `schedule`
                ? { kind: `schedule`, cron: effectiveCron.value as string }
                : form.kind === `event`
                  ? { kind: `event` }
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
                      },
        ...(form.guard.trim() !== `` ? { guard: form.guard.trim() } : {}),
        prompt: form.prompt,
        // Defaults stay absent (schema: absent agent = claude, absent harness = native); claude never carries a
        // harness — the two loops are identical for it.
        ...(form.agent !== `claude` ? { agent: form.agent } : {}),
        ...(form.agent !== `claude` && form.harness !== `native` ? { harness: form.harness } : {}),
        ...(form.model !== `` ? { model: form.model } : {}),
        ...(form.requireApproval ? { requireApproval: true } : {}),
        // A workspace trigger is a chore by definition (nothing but this codebase can fire it); anything else
        // carries the flag it was created with.
        ...(form.kind === `workspace` || form.chore ? { chore: true } : {}),
        ...(isDoorbell.value
            ? {
                  webchat: {
                      access: form.access,
                      ...(form.antiBot === `off` ? {} : { antiBot: form.antiBot }),
                      ...(form.googleClientId.trim() !== `` ? { googleClientId: form.googleClientId.trim() } : {}),
                      ...(form.turnstileSiteKey.trim() !== `` ? { turnstileSiteKey: form.turnstileSiteKey.trim() } : {}),
                      ...(form.turnstileSecret.trim() !== `` ? { turnstileSecret: form.turnstileSecret.trim() } : {}),
                      ...(form.greeting.trim() !== `` ? { greeting: form.greeting.trim() } : {}),
                      // Omitted when blank so the automation keeps tracking the default rather than freezing
                      // today's number into its record.
                      ...(dailyMessageMax.value === undefined ? {} : { dailyMessageMax: dailyMessageMax.value }),
                  },
                  allowedTools: [...DOORBELL_TOOLS],
              }
            : {}),
        enabled: true,
    });

    return {
        form,
        schedule,
        // derived
        isDoorbell,
        branchField,
        liveSources,
        originList,
        effectiveCron,
        cronPreview,
        harnessChoosable,
        dailyMessageMaxDefault: WEBCHAT_DAILY_MAX_DEFAULT,
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
