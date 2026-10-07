import type {
    Automation,
    AutomationSummary,
    AutomationTarget,
    AutomationTemplate,
    FireOn,
    ModelPin,
    SenderRule,
    Senders,
    WatchSource,
    WebchatConfig,
    WorkspaceEventKind,
} from "@intentic/sandbox-contract";
import { AutomationSchema, VISITOR_CHAT_PERSONA, WEBCHAT_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import { asZone, cronOptions, type Zone } from "@intentic/sandbox-contract/time";
import { Cron } from "croner";
import { computed, type ComputedRef, reactive, watch } from "vue";
import { type AvailableSource, listenerSourceOf } from "./catalog";
import { cronOf, defaultSchedule, instantOf, localInputOf, parseCron } from "./cronSchedule";
import { t } from "./i18n";

// One automation form for the create dialog and the edit dialog. `load` and `build` are inverse: `build` omits fields
// at their default, `load` reconstructs the same form so an unchanged save round-trips to an identical automation.

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export type TriggerKind = `schedule` | `once` | `event` | `listener` | `workspace`;

// What decides, without a model, whether a fire goes ahead: nothing, the owner's own command, or one of the daemon's
// ready-made sources. One choice, since the daemon refuses a guard beside a source.
export type ConditionKind = `none` | `guard` | WatchSource[`kind`];
// What a passing check sets off; `agent` is what every automation did before it had a choice.
export type TargetKind = AutomationTarget[`kind`];

// The repository shape the daemon's schema accepts, said here so the refusal points at the box.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// Why a typed pattern does not compile, the one thing the daemon refuses a page's `select` for; undefined when it does.
const patternProblem = (pattern: string): string | undefined => {
    try {
        // Compiled only to learn whether it can be; the daemon compiles its own each check.
        void new RegExp(pattern);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
};

// One row of who may talk to a listener, as typed: ids and groups as comma-separated text split only at save, like
// `allowedTools`; a blank `actsAs` is no persona, the full toolbox reaching no account, exactly as the automation's own.
export interface SenderRuleDraft {
    label: string;
    ids: string;
    groups: string;
    actsAs: string;
    requireApproval: boolean;
}

const emptySenderRule = (): SenderRuleDraft => ({ label: ``, ids: ``, groups: ``, actsAs: ``, requireApproval: false });

// Comma- or newline-separated ids as a list; the same split `allowedTools` uses. Exported so the picker that adds a
// person to a rule reads the row exactly as the save will.
export const splitIds = (typed: string): string[] =>
    typed
        .split(/[\n,]/)
        .map((id) => id.trim())
        .filter((id) => id !== ``);

const ruleDraftOf = (rule: SenderRule): SenderRuleDraft => ({
    label: rule.label ?? ``,
    ids: (rule.ids ?? []).join(`, `),
    groups: (rule.groups ?? []).join(`, `),
    actsAs: rule.actsAs ?? ``,
    requireApproval: rule.requireApproval === true,
});

// The stored rule: every blank field absent rather than empty, so an unchanged edit round-trips to the same record.
const ruleOf = (draft: SenderRuleDraft): SenderRule => {
    const ids = splitIds(draft.ids);
    const groups = splitIds(draft.groups);
    return {
        ...(draft.label.trim() !== `` ? { label: draft.label.trim() } : {}),
        ...(ids.length > 0 ? { ids } : {}),
        ...(groups.length > 0 ? { groups } : {}),
        ...(draft.actsAs !== `` ? { actsAs: draft.actsAs } : {}),
        ...(draft.requireApproval ? { requireApproval: true } : {}),
    };
};

// What a prompt was written for: kind, plus source for a listener since payload shape differs per source (Discord's
// mentioned+channelId vs CI's branch/sha/failedJobs). Exported for the create dialog's template comparison.
export const triggerKey = (trigger: { readonly kind: TriggerKind; readonly provider?: string }): string =>
    trigger.kind === `listener` ? `listener:${trigger.provider}` : trigger.kind;

// The form's own text (starters and templates) now comes from the daemon's catalogue, so it's computed per call rather
// than a module constant; a just-installed pack's template must count as form-owned text too.
// `sandboxZone` is the clock a schedule with no override of its own runs on. Passed in rather than read from
// `Intl.DateTimeFormat()` here: the browser's zone is the reader's, and the reader is not necessarily where the
// sandbox's chores are meant to happen.
export function useAutomationForm(
    sources: ComputedRef<readonly AvailableSource[]>,
    templates: ComputedRef<readonly AutomationTemplate[]>,
    sandboxZone: ComputedRef<Zone>,
) {
    // Text the form put in the box (starter or template prompt); compared verbatim to detect a user edit.
    const templatePrompts = computed(() => new Set<string>(templates.value.map((template) => template.prompt)));
    // A template's guard, as opposed to one the owner typed: only the first leaves with its template's prompt.
    const templateGuards = computed(() => new Set<string>(templates.value.flatMap((template) => (template.guard === undefined ? [] : [template.guard]))));
    let original: Automation | undefined;
    const form = reactive({
        kind: `schedule` as TriggerKind,
        id: ``,
        // The check before anything runs. Each kind keeps its own boxes, so flipping between kinds while deciding does
        // not lose what was typed into the others; only the picked kind reaches `build`.
        condition: `none` as ConditionKind,
        guard: ``,
        npmPackage: ``,
        // A range waits for a version to exist; a tag follows one (latest by default), for firing on a change.
        npmBy: `range` as `range` | `tag`,
        npmRange: ``,
        npmTag: ``,
        githubRepo: ``,
        githubPrereleases: false,
        pageUrl: ``,
        pageSelect: ``,
        fireOn: `pass` as FireOn,
        // Retirement: switched off as it fires, or at an end date, as a `datetime-local` box reads it (blank is none).
        stopAfterFirst: false,
        expiresAt: ``,
        target: `agent` as TargetKind,
        conversationId: ``,
        // One line on what it watches for; a notification's title and what a woken conversation reads it as.
        note: ``,
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
        // Whether the automation decides per person who it answers; off means everyone the trigger's filters admit.
        senders: false,
        senderRules: [] as SenderRuleDraft[],
        // What a sender no rule names gets; `ignore` to begin with, since naming people is usually done to shut
        // everyone else out.
        senderOthers: `ignore` as Senders[`others`],
        // 0 = fire instantly; positive = each fire is held, visibly and cancellably, for this many seconds.
        holdForSeconds: 0,
        // Schedule's session bar: 0 fires every occurrence; positive skips until that many new sessions have run.
        afterSessions: 0,
        // Which clock the schedule's times are meant on. Blank is not "no zone" — it is "this sandbox's zone", which
        // is what most schedules want and what keeps one setting able to move all of them at once. A value here is a
        // deliberate override for the one chore that belongs to somewhere else.
        tz: ``,
        // A one-time wake's moment, as a `datetime-local` box reads it: the reader's own wall clock, no zone. Blank
        // until they pick one, which is what `onceError` refuses to save.
        onceAt: ``,
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

    const isVisitorChat = computed(() => form.kind === `listener` && form.provider === `webchat`);
    const listenerSource = computed(() => listenerSourceOf(sources.value, form.provider, form.eventType));

    // Drives the branch input and whether `build` writes it; undefined when the source has no branch axis.
    const branchField = computed(() => (form.kind === `listener` ? listenerSource.value.branchField : undefined));
    // Whether this source vouches for who is writing (TriggerSource.sender); without it no sender rules are drawn or
    // written, since the daemon would refuse them and the Visitor chat has its own `access`.
    const sendersOffered = computed(() => form.kind === `listener` && listenerSource.value.sender !== undefined);
    const addSenderRule = (): void => {
        form.senderRules.push(emptySenderRule());
        markTouched(`senders`);
    };
    const removeSenderRule = (index: number): void => {
        form.senderRules.splice(index, 1);
    };
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
    const loadSchedule = (trigger: { readonly cron: string; readonly afterSessions?: number; readonly tz?: string }): void => {
        Object.assign(schedule, parseCron(trigger.cron));
        form.afterSessions = trigger.afterSessions ?? 0;
        form.tz = trigger.tz ?? ``;
    };
    const scheduleTrigger = (): Automation[`trigger`] => ({
        kind: `schedule`,
        cron: effectiveCron.value as string,
        ...(form.afterSessions > 0 ? { afterSessions: form.afterSessions } : {}),
        // Absent rather than the resolved zone spelled out: storing the sandbox's own answer would freeze it, and
        // moving the setting afterwards would then leave every schedule behind on the old clock.
        ...(asZone(form.tz) === undefined ? {} : { tz: asZone(form.tz) as Zone }),
    });

    /** The clock this form's times are actually on: its own override, else the sandbox's. Never the browser's. */
    const effectiveZone = computed<Zone>(() => asZone(form.tz) ?? sandboxZone.value);

    // A callback-less Cron is only a queryable pattern. Evaluated in the zone the DAEMON will fire it in, not the
    // browser's: a preview computed on the reader's own clock showed the times they typed and the daemon fired at
    // others, so the one screen built to prove the schedule was right was the one confirming the bug.
    const cronPreview = computed<{ runs: number[] } | { error: string } | undefined>(() => {
        const cron = effectiveCron.value;
        if (form.kind !== `schedule` || cron === undefined) {
            return undefined;
        }
        try {
            const runs = new Cron(cron, cronOptions(effectiveZone.value)).nextRuns(3).map((date) => date.getTime());
            return runs.length > 0 ? { runs } : { error: t(`useAutomationForm.neverFires`) };
        } catch {
            return { error: t(`useAutomationForm.invalidCron`) };
        }
    });

    // The moment the box currently names, or NaN for blank or half-typed. Read by both the error and the preview, so
    // the two can't disagree about what was picked.
    const onceAt = computed(() => instantOf(form.onceAt));
    // Refused rather than accepted-and-dropped: the daemon fires an overdue one-time wake on its next poll, so saving
    // one dated yesterday would not schedule anything, it would fire on the spot.
    const onceError = computed<string | undefined>(() => {
        if (form.kind !== `once`) {
            return undefined;
        }
        if (Number.isNaN(onceAt.value)) {
            return t(`useAutomationForm.pickDateTime`);
        }
        return onceAt.value <= Date.now() ? t(`useAutomationForm.momentPassed`) : undefined;
    });

    /* ---- the check, what it sets off, and when it stops ---- */

    // A listener answers whoever wrote, so it only ever starts an agent: the daemon refuses any other target there.
    const targetsOffered = computed(() => form.kind !== `listener`);
    const effectiveTarget = computed<TargetKind>(() => (targetsOffered.value ? form.target : `agent`));
    // Only a new agent spends a model of the automation's own: a conversation runs on its own, a notification on none.
    const needsModels = computed(() => effectiveTarget.value === `agent`);
    // A one-time wake retires itself as it fires, so neither way of retiring one means anything there.
    const retireOffered = computed(() => form.kind !== `once`);

    // The source the boxes describe, whether or not they are complete; `watchSource` is the one worth sending.
    const sourceOf = (): WatchSource | undefined => {
        switch (form.condition) {
            case `npm`:
                return {
                    kind: `npm`,
                    package: form.npmPackage.trim(),
                    ...(form.npmBy === `range` && form.npmRange.trim() !== `` ? { range: form.npmRange.trim() } : {}),
                    ...(form.npmBy === `tag` && form.npmTag.trim() !== `` ? { tag: form.npmTag.trim() } : {}),
                };
            case `github-release`:
                return { kind: `github-release`, repo: form.githubRepo.trim(), ...(form.githubPrereleases ? { prereleases: true } : {}) };
            case `url`:
                return { kind: `url`, url: form.pageUrl.trim(), ...(form.pageSelect.trim() !== `` ? { select: form.pageSelect.trim() } : {}) };
            case `none`:
            case `guard`:
                return undefined;
        }
    };

    // Each kind's own refusal, said at the box rather than as the daemon's sentence after a save.
    const conditionError = computed<string | undefined>(() => {
        switch (form.condition) {
            case `none`:
                return undefined;
            case `guard`:
                return form.guard.trim() === `` ? t(`useAutomationForm.guardRequired`) : undefined;
            case `npm`:
                if (form.npmPackage.trim() === ``) {
                    return t(`useAutomationForm.packageRequired`);
                }
                return form.npmBy === `range` && form.npmRange.trim() === `` ? t(`useAutomationForm.rangeRequired`) : undefined;
            case `github-release`:
                return REPO_RE.test(form.githubRepo.trim()) ? undefined : t(`useAutomationForm.repoFormat`);
            case `url`: {
                if (!/^https?:\/\/\S+$/.test(form.pageUrl.trim()) || !URL.canParse(form.pageUrl.trim())) {
                    return t(`useAutomationForm.pageUrl`);
                }
                const problem = form.pageSelect.trim() === `` ? undefined : patternProblem(form.pageSelect.trim());
                return problem === undefined ? undefined : t(`useAutomationForm.selectInvalid`, { problem });
            }
        }
    });

    // What "Check now" sends: only a complete source, never a guard, which runs here with a persona's credentials.
    const watchSource = computed<WatchSource | undefined>(() => (conditionError.value === undefined ? sourceOf() : undefined));

    // The end date as an instant, NaN for blank or half-typed; refused once past, since the daemon would switch it off
    // on its next tick rather than arm it.
    const expiresAt = computed(() => instantOf(form.expiresAt));
    const expiresError = computed<string | undefined>(() => {
        if (!retireOffered.value || form.expiresAt === ``) {
            return undefined;
        }
        if (Number.isNaN(expiresAt.value)) {
            return t(`useAutomationForm.pickEndDate`);
        }
        return expiresAt.value <= Date.now() ? t(`useAutomationForm.endPassed`) : undefined;
    });

    const conversationError = computed<string | undefined>(() =>
        effectiveTarget.value === `conversation` && form.conversationId.trim() === `` ? t(`useAutomationForm.pickConversation`) : undefined,
    );

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
            // A template's guard leaves with its prompt; a stale guard on another trigger silently blocks every firing.
            // One the owner typed is theirs, and stays.
            if (form.guard !== `` && templateGuards.value.has(form.guard)) {
                form.guard = ``;
                if (form.condition === `guard`) {
                    form.condition = `none`;
                }
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
        touched.add(`senders`);
        touched.add(`condition`);
        touched.add(`expiresAt`);
        touched.add(`conversation`);
    };

    const nameError = computed<string | undefined>(() => {
        const trimmed = form.id.trim();
        if (trimmed.length === 0) {
            return t(`useAutomationForm.nameRequired`);
        }
        if (!NAME_RE.test(trimmed)) {
            return t(`useAutomationForm.nameFormat`);
        }
        return undefined;
    });
    const promptError = computed<string | undefined>(() => (form.prompt.trim() === `` ? t(`useAutomationForm.promptRequired`) : undefined));
    // Must match exactly what a browser sends in the Origin header: scheme + host, no path, since that's what the
    // daemon compares.
    const originsError = computed<string | undefined>(() => {
        if (!isVisitorChat.value) {
            return undefined;
        }
        if (originList.value.length === 0) {
            return t(`useAutomationForm.addSite`);
        }
        const bad = originList.value.find((origin) => !/^https?:\/\/[^/]+$/.test(origin));
        return bad === undefined ? undefined : t(`useAutomationForm.notAnOrigin`, { origin: bad });
    });

    // The one error about spending rather than syntax: no sandbox-wide tier to fall back on, so an empty ladder must
    // refuse. Enforced here too, not just in the schema, so the refusal happens at save with an actionable message.
    // Only a new agent needs one: a conversation continues on its own model, and a notification runs none.
    const modelsError = computed<string | undefined>(() =>
        needsModels.value && form.models.length === 0 ? t(`useAutomationForm.pickModel`) : undefined,
    );

    // A rule naming nobody would be refused by the daemon's schema; said here so the refusal points at the row.
    const sendersError = computed<string | undefined>(() => {
        if (!sendersOffered.value || !form.senders) {
            return undefined;
        }
        const empty = form.senderRules.some((rule) => splitIds(rule.ids).length === 0 && splitIds(rule.groups).length === 0);
        return empty ? t(`useAutomationForm.emptyRule`) : undefined;
    });

    const valid = computed(
        () =>
            nameError.value === undefined &&
            promptError.value === undefined &&
            originsError.value === undefined &&
            modelsError.value === undefined &&
            sendersError.value === undefined &&
            onceError.value === undefined &&
            conditionError.value === undefined &&
            expiresError.value === undefined &&
            conversationError.value === undefined &&
            (form.kind !== `schedule` || (cronPreview.value !== undefined && `runs` in cronPreview.value)),
    );

    /* ---- the two directions ---- */

    const reset = (): void => {
        original = undefined;
        Object.assign(form, {
            kind: `schedule`,
            id: ``,
            condition: `none`,
            guard: ``,
            npmPackage: ``,
            npmBy: `range`,
            npmRange: ``,
            npmTag: ``,
            githubRepo: ``,
            githubPrereleases: false,
            pageUrl: ``,
            pageSelect: ``,
            fireOn: `pass`,
            stopAfterFirst: false,
            expiresAt: ``,
            target: `agent`,
            conversationId: ``,
            note: ``,
            prompt: ``,
            // Empty: a template can't know which providers this sandbox has connected, so it never fills this.
            models: [],
            account: ``,
            actsAs: ``,
            allowedTools: ``,
            requireApproval: false,
            senders: false,
            senderRules: [],
            senderOthers: `ignore`,
            holdForSeconds: 0,
            afterSessions: 0,
            onceAt: ``,
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

    // The condition half of `load` and `loadTemplate`: a source, else a guard command, else none. Every kind's boxes
    // start from what the record says, so the condition shown is the one it names and nothing else is left over.
    const loadCondition = (from: Pick<Automation, `guard` | `source`>): void => {
        const source = from.source;
        form.guard = from.guard ?? ``;
        form.condition = source?.kind ?? (from.guard === undefined ? `none` : `guard`);
        if (source?.kind === `npm`) {
            form.npmPackage = source.package;
            // A range wins over a tag in the daemon's own check, so a record naming both reads as the range it obeys.
            form.npmBy = source.range !== undefined ? `range` : `tag`;
            form.npmRange = source.range ?? ``;
            form.npmTag = source.tag ?? ``;
        }
        if (source?.kind === `github-release`) {
            form.githubRepo = source.repo;
            form.githubPrereleases = source.prereleases === true;
        }
        if (source?.kind === `url`) {
            form.pageUrl = source.url;
            form.pageSelect = source.select ?? ``;
        }
    };

    // What a passing check sets off, the inverse of `targetOf`; absent is a new agent.
    const loadTarget = (target: AutomationTarget | undefined): void => {
        form.target = target?.kind ?? `agent`;
        form.conversationId = target?.kind === `conversation` ? target.conversationId : ``;
    };

    // Prefills only the fields a template carries; everything else resets first, so picking twice can't accumulate
    // state, and a template switch replaces the condition with the new template's own (or none). `chore` is carried,
    // not inferred: a schedule trigger alone can't tell a dependency sweep from an external poll. A template's `note` is
    // its card's disclosure ("checks every 6 hours"), not what the automation watches for, so it is not carried.
    const loadTemplate = (template: AutomationTemplate): void => {
        reset();
        form.kind = template.trigger.kind;
        form.id = template.id;
        loadCondition(template);
        form.fireOn = template.fireOn ?? `pass`;
        form.stopAfterFirst = template.until === `first-fire`;
        loadTarget(template.target);
        form.holdForSeconds = template.holdForSeconds ?? 0;
        form.prompt = template.prompt;
        form.chore = template.chore === true;
        if (template.trigger.kind === `schedule`) {
            loadSchedule(template.trigger);
        }
        if (template.trigger.kind === `once`) {
            form.onceAt = localInputOf(template.trigger.at);
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

    // The trigger half of `load`: each kind's own fields into the form, the inverse of `triggerOf`. Its own function
    // rather than a run of ifs inside `load`, which has the whole record to read besides this.
    const loadTrigger = (trigger: Automation[`trigger`]): void => {
        if (trigger.kind === `schedule`) {
            loadSchedule(trigger);
        }
        if (trigger.kind === `once`) {
            form.onceAt = localInputOf(trigger.at);
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
    };

    // Puts the user back in front of the form that produced this record, the inverse of `build`: a save that changes
    // nothing must round-trip identically.
    const load = (automation: AutomationSummary | Automation): void => {
        reset();
        original = AutomationSchema.parse(automation);
        const trigger = automation.trigger;
        form.kind = trigger.kind;
        form.id = automation.id;
        loadCondition(automation);
        form.fireOn = automation.fireOn ?? `pass`;
        form.stopAfterFirst = automation.until === `first-fire`;
        form.expiresAt = automation.expiresAt === undefined ? `` : localInputOf(automation.expiresAt);
        loadTarget(automation.target);
        form.note = automation.note ?? ``;
        form.prompt = automation.prompt;
        // Copied, not aliased: the picker edits in place, and a cancelled edit must not touch the stored record.
        form.models = (automation.models ?? []).map((pin) => ({ ...pin }));
        form.account = automation.account ?? ``;
        form.actsAs = automation.actsAs ?? ``;
        form.allowedTools = (automation.allowedTools ?? []).join(`, `);
        form.requireApproval = automation.requireApproval === true;
        loadSenders(automation.senders);
        form.holdForSeconds = automation.holdForSeconds ?? 0;
        form.chore = automation.chore === true;
        loadTrigger(trigger);
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

    // The sender block read into the form; absent leaves the block off with its defaults, which `reset` already set.
    const loadSenders = (senders: Senders | undefined): void => {
        if (senders === undefined) {
            return;
        }
        form.senders = true;
        form.senderRules = senders.rules.map(ruleDraftOf);
        form.senderOthers = senders.others;
    };

    // A listener trigger with only the filters actually typed; the Visitor chat's admission list lives on the trigger,
    // beside the provider it gates.
    const listenerTrigger = (): Automation["trigger"] => ({
        kind: `listener`,
        provider: form.provider,
        ...(form.eventType !== undefined ? { eventType: form.eventType } : {}),
        ...(form.eventType === `message` && form.mentioned ? { mentioned: true } : {}),
        ...(form.channelId.trim() !== `` ? { channelId: form.channelId.trim() } : {}),
        ...(branchField.value !== undefined && form.branch.trim() !== `` ? { branch: form.branch.trim() } : {}),
        ...(isVisitorChat.value ? { allowedOrigins: originList.value } : {}),
    });

    // The trigger the form describes, one shape per kind; the inverse of what `load` read.
    const triggerOf = (): Automation["trigger"] => {
        switch (form.kind) {
            case `schedule`:
                return scheduleTrigger();
            case `once`:
                return { kind: `once`, at: instantOf(form.onceAt) };
            case `event`:
                return {
                    kind: `event`,
                    ...(original?.trigger.kind === `event` && original.trigger.dailyMax !== undefined ? { dailyMax: original.trigger.dailyMax } : {}),
                };
            case `workspace`:
                return { kind: `workspace`, event: form.workspaceEvent, ...(form.repo.trim() !== `` ? { repo: form.repo.trim() } : {}) };
            case `listener`:
                return listenerTrigger();
        }
    };

    // What a passing check sets off, as stored: absent for a new agent, the default and a listener's only choice.
    const targetOf = (): AutomationTarget | undefined => {
        switch (effectiveTarget.value) {
            case `agent`:
                return undefined;
            case `conversation`:
                return { kind: `conversation`, conversationId: form.conversationId.trim() };
            case `notify`:
                return { kind: `notify` };
        }
    };

    // The end date as stored. The box reads to the minute, so an untouched one keeps the exact instant it was loaded
    // with rather than the minute it rounds to: an agent's "in a week" is rarely on a minute.
    const expiresAtOf = (): number | undefined => {
        if (!retireOffered.value || form.expiresAt === `` || Number.isNaN(expiresAt.value)) {
            return undefined;
        }
        const stored = original?.expiresAt;
        return stored !== undefined && localInputOf(stored) === form.expiresAt ? stored : expiresAt.value;
    };

    // The watch half of `build`: one condition, when it fires, when it retires and what it sets off. Each is written
    // only where it says something, and dropped where the record started with one the form no longer names.
    const applyWatch = (automation: Automation): void => {
        delete automation.guard;
        delete automation.source;
        if (form.condition === `guard` && form.guard.trim() !== ``) {
            automation.guard = form.guard.trim();
        }
        const source = sourceOf();
        if (source !== undefined) {
            automation.source = source;
        }
        // A change needs a check to compare; without one the daemon refuses it, so it is not written.
        if (form.fireOn === `change` && (automation.guard !== undefined || automation.source !== undefined)) {
            automation.fireOn = `change`;
        } else {
            delete automation.fireOn;
        }
        if (retireOffered.value && form.stopAfterFirst) {
            automation.until = `first-fire`;
        } else {
            delete automation.until;
        }
        const ends = expiresAtOf();
        if (ends === undefined) {
            delete automation.expiresAt;
        } else {
            automation.expiresAt = ends;
        }
        const target = targetOf();
        if (target === undefined) {
            delete automation.target;
        } else {
            automation.target = target;
        }
        if (form.note.trim() === ``) {
            delete automation.note;
        } else {
            automation.note = form.note.trim();
        }
    };

    // Record to upsert: keeps every opaque field from the loaded record, overwriting only what the editor exposes.
    // Enabled never changes as a side effect; the webhook token stays at the daemon's door, never here.
    const build = (): Automation => {
        // Starts from the stored record, so a newly added contract field survives until explicitly owned.
        const automation: Automation = {
            ...original,
            id: form.id.trim(),
            trigger: triggerOf(),
            prompt: form.prompt,
            enabled: original?.enabled ?? true,
        };
        applyWatch(automation);
        // Only a new agent spends models of its own, so only it carries them, and the account that pays for them. The
        // form keeps the ladder while another target is picked, so switching back finds it where it was.
        if (needsModels.value) {
            // Copied, not aliased, so a later form edit can't reach a record already handed to the caller.
            automation.models = form.models.map((pin) => ({ ...pin }));
        } else {
            delete automation.models;
        }
        // Clear an account pin when model choices span providers.
        const oneProvider = new Set(form.models.map((pin) => pin.provider)).size <= 1;
        if (form.account === `` || !oneProvider || !needsModels.value) {
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
        // Written only where the source vouches for a sender and the block is on; switching it off, or moving the
        // trigger to a source that cannot identify anyone, drops the rules rather than saving a refusal.
        if (sendersOffered.value && form.senders) {
            automation.senders = { rules: form.senderRules.map(ruleOf), others: form.senderOthers };
        } else {
            delete automation.senders;
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
        if (isVisitorChat.value) {
            automation.webchat = webchatOf();
            // A Visitor chat with no persona gets VISITOR_CHAT_PERSONA, written by the daemon on save if the workspace
            // lacks one yet. Only fills a blank: an owner's own choice of a stronger persona stands.
            if (automation.actsAs === undefined) {
                automation.actsAs = VISITOR_CHAT_PERSONA;
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
        isVisitorChat,
        listenerSource,
        branchField,
        sendersOffered,
        addSenderRule,
        removeSenderRule,
        liveSources,
        visibleSources,
        originList,
        effectiveCron,
        effectiveZone,
        // Re-exposed so the zone picker can label its blank option with what "follow the sandbox" currently means;
        // a blank that does not say which clock it stands for is the same silence this whole change is about.
        sandboxZone,
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
        sendersError,
        onceAt,
        onceError,
        // the check, its target, its retirement
        targetsOffered,
        effectiveTarget,
        needsModels,
        retireOffered,
        watchSource,
        conditionError,
        expiresAt,
        expiresError,
        conversationError,
        valid,
        // directions
        reset,
        load,
        loadTemplate,
        build,
    };
}

export type AutomationFormState = ReturnType<typeof useAutomationForm>;
