import type { Automation, AutomationTemplate } from "@intentic/sandbox-contract";
import { ZoneSchema } from "@intentic/sandbox-contract/time";
import { computed, nextTick } from "vue";
import type { AvailableSource } from "./catalog";
import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { useAutomationForm } from "./useAutomationForm";

await registerExtensionMessages(extensionIdOf(manifest), messages);

// The form's prompt must always match its trigger: a starter or template's text may be rewritten when the trigger
// changes, but the owner's own text never is.

const DISCORD: AvailableSource = {
    provider: `discord`,
    label: `Discord`,
    logo: `discord`,
    enabled: true,
    available: true,
    requires: [],
    events: [{ value: `message`, label: `Messages` }],
    mentionLabel: `Only mentions`,
    channel: { label: `Channel`, placeholder: `all channels` },
    // Discord vouches for a user id and reports role ids, so it is the source sender rules are drawn on.
    sender: { label: `User ID`, placeholder: `an id` },
    senderGroup: { label: `Role ID`, placeholder: `a role` },
    starterPrompt: `Handle Discord messages.`,
};
const CI: AvailableSource = {
    provider: `ci`,
    label: `CI/CD`,
    icon: `bolt`,
    enabled: true,
    available: true,
    requires: [],
    events: [{ value: `pipeline_failed`, label: `Pipeline failed` }],
    channel: { label: `Repository`, placeholder: `all repos` },
    starterPrompt: `Handle CI results.`,
};

// Stand-ins for the daemon's template catalogue: one listener trigger, one workspace trigger with a guard.
const FIX_CI: AutomationTemplate = {
    id: `fix-failing-ci`,
    title: `Fix failing CI`,
    requires: [`github`],
    trigger: { kind: `listener`, provider: `ci`, eventType: `pipeline_broken` },
    prompt: `A pipeline that was passing just failed — fix it.`,
};
const REVIEW: AutomationTemplate = {
    id: `review-agent-work`,
    title: `Review agent work`,
    requires: [],
    trigger: { kind: `workspace`, event: `turn.settled` },
    guard: `test "$(git diff --numstat | wc -l)" -gt 0`,
    prompt: `An agent just finished a turn. Review its diff.`,
    chore: true,
};

// Every automation needs a model ladder; round-trip tests check it survives an edit untouched.
const LADDER = [
    { provider: `claude`, model: `claude-sonnet-4-6` },
    { provider: `codex`, model: `gpt-5.3-codex` },
] satisfies Automation["models"];

// A watch template: a ready-made source, change-only firing, retiring at its first fire, and only a notification.
const PAGE_CHANGES: AutomationTemplate = {
    id: `page-changes`,
    title: `When a page changes`,
    requires: [],
    trigger: { kind: `schedule`, cron: `7 * * * *` },
    source: { kind: `url`, url: `https://example.com/status` },
    fireOn: `change`,
    until: `first-fire`,
    target: { kind: `notify` },
    prompt: `The page you were watching changed.`,
    note: `checks hourly`,
};

const SOURCES = computed<readonly AvailableSource[]>(() => [DISCORD, CI]);
const TEMPLATES = computed<readonly AutomationTemplate[]>(() => [FIX_CI, REVIEW, PAGE_CHANGES]);
// A sandbox zone that is NOT UTC and not the test runner's, so anything reading the process's own clock instead of
// this shows up as a wrong answer rather than an accidentally right one.
const SANDBOX_ZONE = computed(() => ZoneSchema.parse(`Europe/Warsaw`));
const formState = () => useAutomationForm(SOURCES, TEMPLATES, SANDBOX_ZONE);

describe(`the prompt follows the trigger`, () => {
    it(`arrives with the picked source's starter`, async () => {
        const { form } = formState();
        form.kind = `listener`;
        await nextTick();
        expect<string | undefined>(form.prompt).toBe(DISCORD.starterPrompt);
    });

    it(`re-writes the starter when the source changes under it`, async () => {
        const { form } = formState();
        form.kind = `listener`;
        await nextTick();
        form.provider = `ci`;
        await nextTick();
        expect<string | undefined>(form.prompt).toBe(CI.starterPrompt);
    });

    it(`clears the starter when the trigger stops being a live one`, async () => {
        const { form } = formState();
        form.kind = `listener`;
        await nextTick();
        form.kind = `event`;
        await nextTick();
        expect(form.prompt).toBe(``);
    });

    it(`never touches text the user typed`, async () => {
        const { form, staleStarter } = formState();
        form.kind = `listener`;
        await nextTick();
        form.prompt = `Only tell me about deploys to main.`;
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(`Only tell me about deploys to main.`);
        // staleStarter tracks only a lingering starter, not text the owner typed.
        expect(staleStarter.value).toBeUndefined();
    });
});

describe(`a template's own text`, () => {
    it(`survives the trigger it set itself`, async () => {
        const fixCi = FIX_CI;
        const { form, loadTemplate } = formState();
        loadTemplate(fixCi);
        await nextTick();
        // Trigger and prompt load together; the trigger change must not overwrite the template's prompt.
        expect(form.prompt).toBe(fixCi.prompt);
        expect(form.prompt).not.toBe(CI.starterPrompt);
    });

    it(`goes, with its guard, when the trigger moves off it`, async () => {
        const review = REVIEW;
        const { form, loadTemplate } = formState();
        loadTemplate(review);
        await nextTick();
        expect<string | undefined>(form.guard).toBe(review.guard);
        expect(form.condition).toBe(`guard`);
        form.kind = `listener`;
        await nextTick();
        expect<string | undefined>(form.prompt).toBe(DISCORD.starterPrompt);
        // A diff-size jq left on a Discord listener is a row that never fires and never says why.
        expect(form.guard).toBe(``);
        expect(form.condition).toBe(`none`);
    });

    it(`leaves a guard the owner typed where it is when the trigger moves`, async () => {
        const { form, loadTemplate } = formState();
        loadTemplate(REVIEW);
        await nextTick();
        form.guard = `test -s inbox.txt`;
        form.kind = `listener`;
        await nextTick();
        expect(form.condition).toBe(`guard`);
        expect(form.guard).toBe(`test -s inbox.txt`);
    });

    it(`replaces the condition with the next template's own when another is picked`, () => {
        const { form, loadTemplate, build } = formState();
        loadTemplate(REVIEW);
        loadTemplate(PAGE_CHANGES);
        expect(form.condition).toBe(`url`);
        expect(form.guard).toBe(``);
        expect(build().guard).toBeUndefined();
        loadTemplate(FIX_CI);
        expect(form.condition).toBe(`none`);
        expect(build().source).toBeUndefined();
    });

    it(`prefills a watch: its source, when it fires, when it retires and what it sets off`, () => {
        const { form, loadTemplate, build, modelsError } = formState();
        loadTemplate(PAGE_CHANGES);
        expect(form.condition).toBe(`url`);
        expect(form.pageUrl).toBe(`https://example.com/status`);
        expect(form.fireOn).toBe(`change`);
        expect(form.stopAfterFirst).toBe(true);
        expect(form.target).toBe(`notify`);
        // A notification runs no model, so a template that cannot know the sandbox's providers is still saveable.
        expect(modelsError.value).toBeUndefined();
        const built = build();
        expect(built.source).toEqual({ kind: `url`, url: `https://example.com/status` });
        expect(built.fireOn).toBe(`change`);
        expect(built.until).toBe(`first-fire`);
        expect(built.target).toEqual({ kind: `notify` });
        expect(built.models).toBeUndefined();
        // The template's note is its card's disclosure, not what the automation watches for.
        expect(built.note).toBeUndefined();
    });
});

describe(`editing a stored automation`, () => {
    it(`keeps the owner's prompt when its source is changed`, async () => {
        const { form, load } = formState();
        load({ id: `inbox`, trigger: { kind: `listener`, provider: `discord` }, prompt: `Mine, hand-written.`, models: LADDER, enabled: true });
        await nextTick();
        form.provider = `ci`;
        await nextTick();
        expect(form.prompt).toBe(`Mine, hand-written.`);
    });

    it(`names a starter that belongs to another source, and swaps it on request`, () => {
        const { form, load, staleStarter, applyStarter } = formState();
        // Stored prompt: CI trigger, Discord's starter text; an edit must not overwrite it, only offer a swap.
        load({
            id: `on-failed-ci`,
            trigger: { kind: `listener`, provider: `ci`, eventType: `pipeline_failed` },
            prompt: DISCORD.starterPrompt ?? ``,
            models: LADDER,
            enabled: true,
        });
        expect(staleStarter.value?.label).toBe(DISCORD.label);
        applyStarter();
        expect<string | undefined>(form.prompt).toBe(CI.starterPrompt);
        expect(staleStarter.value).toBeUndefined();
    });
});

describe(`editing preserves fields outside the changed control`, () => {
    // `deps.broken` is retired (nothing emits it) and never offered, but the record is the owner's: the form shows the
    // moment it names, and saving any other change must not quietly re-point it at a moment the owner never chose.
    it(`keeps a retired workspace moment as it was stored`, () => {
        const retired: Automation = {
            id: `fix-broken-deps`,
            trigger: { kind: `workspace`, event: `deps.broken`, repo: `web` },
            prompt: `Fix what the land broke.`,
            models: LADDER,
            enabled: true,
            // A workspace trigger is a chore by definition, so the stored record says so.
            chore: true,
        };
        const { form, load, build } = formState();
        load(retired);
        expect(form.workspaceEvent).toBe(`deps.broken`);
        expect(build()).toEqual(retired);
    });

    it(`carries a schedule's sessions bar both ways, and drops it at zero`, () => {
        const nightly: Automation = {
            id: `dream`,
            trigger: { kind: `schedule`, cron: `0 5 * * *`, afterSessions: 30 },
            prompt: `Dream.`,
            models: LADDER,
            enabled: true,
        };
        const { form, load, build } = formState();
        load(nightly);
        expect(form.afterSessions).toBe(30);
        expect(build()).toEqual(nightly);
        // Zero means unlimited: the record represents it by omitting afterSessions, not by storing zero.
        form.afterSessions = 0;
        expect(build().trigger).toEqual({ kind: `schedule`, cron: `0 5 * * *` });
    });

    it(`round-trips a schedule's zone, and omits it when the sandbox's own answers`, () => {
        const tokyo: Automation = {
            id: `market`,
            trigger: { kind: `schedule`, cron: `0 9 * * *`, tz: ZoneSchema.parse(`Asia/Tokyo`) },
            prompt: `Open of business.`,
            models: LADDER,
            enabled: true,
        };
        const { form, load, build, effectiveZone } = formState();
        load(tokyo);
        expect(form.tz).toBe(`Asia/Tokyo`);
        expect<string>(effectiveZone.value).toBe(`Asia/Tokyo`);
        expect(build()).toEqual(tokyo);

        // Cleared means "follow the sandbox", which is stored as an ABSENT tz rather than the sandbox's id spelled
        // out: writing the resolved zone down would freeze it, and moving the setting later would strand this row.
        form.tz = ``;
        expect(build().trigger).toEqual({ kind: `schedule`, cron: `0 9 * * *` });
        expect<string>(effectiveZone.value).toBe(`Europe/Warsaw`);
    });

    it(`round-trips a one-time wake through the reader's own clock`, () => {
        // Built from a local wall-clock reading, not a hardcoded epoch: the box speaks the reader's zone, and the
        // stored trigger is the instant that resolves to, so the pair has to survive whatever zone the suite runs in.
        const moment = new Date(Date.now() + 3 * 3_600_000);
        moment.setSeconds(0, 0);
        const reminder: Automation = {
            id: `dentist`,
            trigger: { kind: `once`, at: moment.getTime() },
            prompt: `Remind me about the dentist.`,
            models: LADDER,
            enabled: true,
        };
        const { form, load, build, onceError, valid } = formState();
        load(reminder);
        expect(form.kind).toBe(`once`);
        // The box holds what a person would read off a clock, and `T` separates the halves as the input requires.
        expect(form.onceAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        expect(onceError.value).toBeUndefined();
        expect(valid.value).toBe(true);
        expect(build()).toEqual(reminder);
    });

    it(`refuses a moment already gone, and a box nobody has answered`, () => {
        const { form, build, onceError, valid } = formState();
        form.kind = `once`;
        form.id = `too-late`;
        form.prompt = `Tell me.`;
        form.models = [...LADDER];
        // Nothing picked yet: an error, but the one that says to pick, not the one that says it has passed.
        expect(onceError.value).toMatch(/Pick the date and time/);
        expect(valid.value).toBe(false);
        const gone = new Date(Date.now() - 60_000);
        gone.setSeconds(0, 0);
        form.onceAt = `${gone.getFullYear()}-${String(gone.getMonth() + 1).padStart(2, `0`)}-${String(gone.getDate()).padStart(2, `0`)}T${String(gone.getHours()).padStart(2, `0`)}:${String(gone.getMinutes()).padStart(2, `0`)}`;
        expect(onceError.value).toMatch(/already passed/);
        expect(valid.value).toBe(false);
        // The trigger it would build is still the honest reading of the box; `valid` is what stops the save.
        expect(build().trigger).toEqual({ kind: `once`, at: gone.getTime() });
    });

    it(`keeps a webhook's daily ceiling and disabled state`, () => {
        // Token lives at the door, not the record; only dailyMax and enabled must survive the edit untouched.
        const automation: Automation = {
            id: `deploy-hook`,
            trigger: { kind: `event`, dailyMax: 40 },
            prompt: `Handle the deploy.`,
            models: LADDER,
            enabled: false,
        };
        const { form, load, build } = formState();
        load(automation);
        form.prompt = `Handle the deploy carefully.`;
        expect(build()).toEqual({ ...automation, prompt: `Handle the deploy carefully.` });
    });

    it(`round-trips a secured Visitor chat including settings the form does not render`, () => {
        const automation: Automation = {
            id: `support`,
            trigger: { kind: `listener`, provider: `webchat`, eventType: `message`, allowedOrigins: [`https://example.com`] },
            prompt: `Answer support questions.`,
            // Single provider throughout, so the account pin (that provider's store key) survives the round trip.
            models: [
                { provider: `claude`, model: `claude-opus-4-6` },
                { provider: `claude`, model: `claude-sonnet-4-6` },
            ],
            webchat: {
                access: `google`,
                requireName: true,
                antiBot: `turnstile`,
                turnstileSiteKey: `site-key`,
                turnstileSecret: `secret-key`,
                googleClientId: `client-id`,
                title: `Support`,
                greeting: `Hello`,
                accent: `#123456`,
                position: `bottom-left`,
                dailyMessageMax: 40,
                conversationMessageMax: 8,
                sessionTtlMinutes: 30,
            },
            // Narrower than its persona; editing must not widen a security boundary.
            allowedTools: [`Read`],
            actsAs: `visitor-chat`,
            account: `reliable-account`,
            holdForSeconds: 20,
            enabled: false,
        };
        const { load, build } = formState();
        load(automation);
        expect(build()).toEqual(automation);
    });

    it(`gives a Visitor chat that names no persona the visitor chat`, () => {
        const { form, build } = formState();
        form.kind = `listener`;
        form.provider = `webchat`;
        form.id = `support`;
        form.prompt = `Answer support questions.`;
        form.origins = `https://example.com`;
        expect(build().actsAs).toBe(`visitor-chat`);
    });

    it(`leaves a Visitor chat's chosen persona alone`, () => {
        const { form, build } = formState();
        form.kind = `listener`;
        form.provider = `webchat`;
        form.id = `support`;
        form.prompt = `Answer support questions.`;
        form.origins = `https://example.com`;
        form.actsAs = `support-guest`;
        expect(build().actsAs).toBe(`support-guest`);
    });
});

// Pins that a saveable automation must always name its own models; there is no sandbox-wide default to fall back on.
describe(`the model ladder`, () => {
    const filled = () => {
        const state = formState();
        state.form.id = `nightly`;
        state.form.prompt = `Sweep the dependencies.`;
        return state;
    };

    it(`refuses to save until a model is named`, () => {
        const { form, modelsError, valid } = filled();
        expect(modelsError.value).toMatch(/at least one model/i);
        expect(valid.value).toBe(false);
        form.models = [...LADDER];
        expect(modelsError.value).toBeUndefined();
        expect(valid.value).toBe(true);
    });

    // Templates are authored before this sandbox exists and cannot know which providers are connected.
    it(`is not filled in by a template`, () => {
        const { form, loadTemplate } = formState();
        loadTemplate(REVIEW);
        expect(form.models).toEqual([]);
    });

    it(`round-trips in the owner's order, since order is what the daemon walks`, () => {
        const { form, load, build } = formState();
        const automation: Automation = {
            id: `nightly`,
            trigger: { kind: `schedule`, cron: `0 5 * * *` },
            prompt: `Sweep.`,
            models: LADDER,
            enabled: true,
        };
        load(automation);
        expect(form.models).toEqual(LADDER);
        expect(build()).toEqual(automation);
    });

    // An account id is one provider's store key; pinning one only makes sense while the ladder stays on that provider,
    // so crossing providers clears it.
    it(`clears a pinned account once the ladder crosses providers`, () => {
        const { form, build } = filled();
        form.models = [{ provider: `claude`, model: `claude-sonnet-4-6` }];
        form.account = `reliable-account`;
        expect(build().account).toBe(`reliable-account`);
        form.models = [...LADDER];
        expect(build().account).toBeUndefined();
    });
});

// Who a listener answers: rules by id or group, each naming a persona, drawn only where the source vouches for a sender.
describe(`sender rules`, () => {
    const frontLine: Automation = {
        id: `front-line`,
        trigger: { kind: `listener`, provider: `discord`, eventType: `message` },
        prompt: `Answer the team.`,
        models: LADDER,
        actsAs: `customer-service`,
        senders: {
            rules: [
                { label: `The boss`, ids: [`u-mark`] },
                { ids: [`u-martha`, `u-annie`], groups: [`r-support`], actsAs: `customer-service`, requireApproval: true },
            ],
            others: `hold`,
        },
        enabled: true,
    };

    it(`round-trips rules, their personas and what everyone else gets`, () => {
        const { form, load, build } = formState();
        load(frontLine);
        expect(form.senders).toBe(true);
        expect(form.senderRules).toEqual([
            { label: `The boss`, ids: `u-mark`, groups: ``, actsAs: ``, requireApproval: false },
            { label: ``, ids: `u-martha, u-annie`, groups: `r-support`, actsAs: `customer-service`, requireApproval: true },
        ]);
        expect(form.senderOthers).toBe(`hold`);
        expect(build()).toEqual(frontLine);
    });

    it(`drops the block when switched off, rather than saving an empty one`, () => {
        const { form, load, build } = formState();
        load(frontLine);
        form.senders = false;
        expect(build().senders).toBeUndefined();
    });

    it(`refuses a rule naming nobody, and says which`, () => {
        const { form, load, addSenderRule, sendersError, valid } = formState();
        load(frontLine);
        expect(valid.value).toBe(true);
        addSenderRule();
        expect(sendersError.value).toMatch(/at least one person or group/);
        expect(valid.value).toBe(false);
        (form.senderRules[2] as { ids: string }).ids = `u-annie`;
        expect(sendersError.value).toBeUndefined();
        expect(valid.value).toBe(true);
    });

    it(`is not offered, and not written, on a source that vouches for nobody`, () => {
        const { form, sendersOffered, build } = formState();
        form.kind = `listener`;
        form.provider = `ci`;
        form.id = `failed-builds`;
        form.prompt = `Fix it.`;
        form.models = [...LADDER];
        form.senders = true;
        form.senderRules.push({ label: ``, ids: `u-mark`, groups: ``, actsAs: ``, requireApproval: false });
        expect(sendersOffered.value).toBe(false);
        expect(build().senders).toBeUndefined();
    });
});

// Who pays: a new agent names its models; a conversation runs on its own and a notification on none.
describe(`what a passing check sets off`, () => {
    const filled = () => {
        const state = formState();
        state.form.id = `bun-ships`;
        state.form.prompt = `Bun shipped.`;
        return state;
    };

    it(`needs no model to notify, and writes none`, () => {
        const { form, modelsError, valid, build } = filled();
        form.models = [...LADDER];
        form.account = `reliable-account`;
        form.target = `notify`;
        expect(modelsError.value).toBeUndefined();
        expect(valid.value).toBe(true);
        const built = build();
        expect(built.target).toEqual({ kind: `notify` });
        expect(built.models).toBeUndefined();
        expect(built.account).toBeUndefined();
        // The ladder waits in the form, so switching back to a new agent finds it where it was.
        form.target = `agent`;
        expect(build().models).toEqual(LADDER);
        expect(build().target).toBeUndefined();
    });

    it(`continues a conversation only once one is named`, () => {
        const { form, conversationError, modelsError, valid, build } = filled();
        form.target = `conversation`;
        expect(modelsError.value).toBeUndefined();
        expect(conversationError.value).toMatch(/conversation to continue/);
        expect(valid.value).toBe(false);
        form.conversationId = `c-123`;
        expect(valid.value).toBe(true);
        expect(build().target).toEqual({ kind: `conversation`, conversationId: `c-123` });
    });

    it(`is always a new agent for a listener, which answers whoever wrote`, () => {
        const { form, modelsError, build } = filled();
        form.kind = `listener`;
        form.target = `notify`;
        expect(modelsError.value).toMatch(/at least one model/i);
        form.models = [...LADDER];
        expect(build().target).toBeUndefined();
        expect(build().models).toEqual(LADDER);
    });
});

// One check at a time, as the daemon has it: the picked kind is the only one written, whatever the other boxes hold.
describe(`the condition`, () => {
    const filled = () => {
        const state = formState();
        state.form.id = `watch`;
        state.form.prompt = `Look.`;
        state.form.models = [...LADDER];
        return state;
    };

    it(`writes nothing when it always goes ahead, and no change to fire on`, () => {
        const { form, build } = filled();
        form.guard = `true`;
        form.fireOn = `change`;
        const built = build();
        expect(built.guard).toBeUndefined();
        expect(built.source).toBeUndefined();
        expect(built.fireOn).toBeUndefined();
    });

    it(`writes a guard command, and firing on its change`, () => {
        const { form, build, conditionError } = filled();
        form.condition = `guard`;
        expect(conditionError.value).toMatch(/Write the command/);
        form.guard = `  ./bin/new-release  `;
        form.fireOn = `change`;
        expect(conditionError.value).toBeUndefined();
        const built = build();
        expect(built.guard).toBe(`./bin/new-release`);
        expect(built.source).toBeUndefined();
        expect(built.fireOn).toBe(`change`);
    });

    it(`writes an npm range, or a tag, never both`, () => {
        const { form, build, conditionError, watchSource } = filled();
        form.condition = `npm`;
        expect(conditionError.value).toMatch(/Name the package/);
        expect(watchSource.value).toBeUndefined();
        form.npmPackage = `bun`;
        expect(conditionError.value).toMatch(/version range/);
        form.npmRange = `>=1.4.3`;
        form.npmTag = `canary`;
        expect(build().source).toEqual({ kind: `npm`, package: `bun`, range: `>=1.4.3` });
        expect(watchSource.value).toEqual({ kind: `npm`, package: `bun`, range: `>=1.4.3` });
        form.npmBy = `tag`;
        expect(build().source).toEqual({ kind: `npm`, package: `bun`, tag: `canary` });
        // Blank is latest, which the daemon reads from an absent tag.
        form.npmTag = ``;
        expect(build().source).toEqual({ kind: `npm`, package: `bun` });
    });

    it(`writes a GitHub repository's releases, prereleases only when asked`, () => {
        const { form, build, conditionError } = filled();
        form.condition = `github-release`;
        form.githubRepo = `bun`;
        expect(conditionError.value).toMatch(/owner\/name/);
        form.githubRepo = `oven-sh/bun`;
        expect(build().source).toEqual({ kind: `github-release`, repo: `oven-sh/bun` });
        form.githubPrereleases = true;
        expect(build().source).toEqual({ kind: `github-release`, repo: `oven-sh/bun`, prereleases: true });
    });

    it(`writes a web page and its pattern, and refuses one that does not compile`, () => {
        const { form, build, conditionError, valid } = filled();
        form.condition = `url`;
        form.pageUrl = `example.com`;
        expect(conditionError.value).toMatch(/http/);
        form.pageUrl = `https://example.com/changelog`;
        form.pageSelect = `v(\\d+`;
        expect(conditionError.value).toMatch(/does not compile/);
        expect(valid.value).toBe(false);
        form.pageSelect = `v(\\d+\\.\\d+)`;
        expect(valid.value).toBe(true);
        expect(build().source).toEqual({ kind: `url`, url: `https://example.com/changelog`, select: `v(\\d+\\.\\d+)` });
    });

    it(`drops what another kind's boxes still hold when the kind is switched`, () => {
        const { form, build } = filled();
        form.condition = `guard`;
        form.guard = `./check`;
        form.condition = `github-release`;
        form.githubRepo = `oven-sh/bun`;
        const built = build();
        expect(built.guard).toBeUndefined();
        expect(built.source).toEqual({ kind: `github-release`, repo: `oven-sh/bun` });
    });
});

describe(`retiring`, () => {
    const filled = () => {
        const state = formState();
        state.form.id = `watch`;
        state.form.prompt = `Look.`;
        state.form.models = [...LADDER];
        return state;
    };
    const inputOf = (date: Date): string =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, `0`)}-${String(date.getDate()).padStart(2, `0`)}T${String(date.getHours()).padStart(2, `0`)}:${String(date.getMinutes()).padStart(2, `0`)}`;

    it(`stops after the first fire, and at an end date that is still ahead`, () => {
        const { form, build, expiresError, valid } = filled();
        form.stopAfterFirst = true;
        const later = new Date(Date.now() + 7 * 86_400_000);
        later.setSeconds(0, 0);
        form.expiresAt = inputOf(later);
        expect(expiresError.value).toBeUndefined();
        expect(valid.value).toBe(true);
        const built = build();
        expect(built.until).toBe(`first-fire`);
        expect(built.expiresAt).toBe(later.getTime());
    });

    it(`refuses an end date already gone`, () => {
        const { form, expiresError, valid } = filled();
        const gone = new Date(Date.now() - 3_600_000);
        form.expiresAt = inputOf(gone);
        expect(expiresError.value).toMatch(/already passed/);
        expect(valid.value).toBe(false);
    });

    it(`offers neither on a one-time wake, which already retires as it fires`, () => {
        const { form, build, retireOffered } = filled();
        form.kind = `once`;
        form.onceAt = inputOf(new Date(Date.now() + 3_600_000));
        form.stopAfterFirst = true;
        form.expiresAt = inputOf(new Date(Date.now() + 7_200_000));
        expect(retireOffered.value).toBe(false);
        const built = build();
        expect(built.until).toBeUndefined();
        expect(built.expiresAt).toBeUndefined();
    });
});

describe(`a stored watch`, () => {
    it(`round-trips whole, an end date off the minute included`, () => {
        const watch: Automation = {
            id: `bun-1-4-3`,
            trigger: { kind: `schedule`, cron: `17 */6 * * *` },
            source: { kind: `npm`, package: `bun`, range: `>=1.4.3` },
            fireOn: `change`,
            until: `first-fire`,
            // An agent's "a week from now", seconds and milliseconds and all.
            expiresAt: Date.now() + 7 * 86_400_000 + 12_345,
            target: { kind: `conversation`, conversationId: `c-armed-it` },
            note: `Bun 1.4.3 is published`,
            prompt: `Carry on with the upgrade.`,
            enabled: true,
        };
        const { form, load, build, valid } = formState();
        load(watch);
        expect(form.condition).toBe(`npm`);
        expect(form.target).toBe(`conversation`);
        expect(form.note).toBe(`Bun 1.4.3 is published`);
        expect(valid.value).toBe(true);
        expect(build()).toEqual(watch);
    });

    it(`drops a blank note rather than saving an empty one`, () => {
        const { form, load, build } = formState();
        load({ id: `x`, trigger: { kind: `event` }, prompt: `Go.`, models: LADDER, note: `Old`, enabled: true });
        form.note = `   `;
        expect(build().note).toBeUndefined();
    });
});
