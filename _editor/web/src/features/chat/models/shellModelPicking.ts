import { type AgentHarness, type AgentProvider, type ModelRole, sendableEffort } from "@intentic/sandbox-contract";
import type { AgentRunChoice, ModelPicking } from "@intentic/ui";
import { effectScope } from "vue";
import { effortLabelOf } from "./effortScale";
import { type RoleModel, useRoleModel } from "../accounts/roleModel";
import { requestModelPick } from "./hostModelPicker";
import { modelLabelFor } from "../accounts/providerCatalog";
import { useChat } from "../run/useChat";

/* WHAT A SURFACE-STARTED RUN OPENS ON, AND HOW TO RE-POINT IT, the shell's own implementation of the kit's
 * `ModelPicking`, which is what every <AgentRunButton> in the app is driven by.
 *
 * THE SAME TWO ANSWERS THE EXTENSION API GIVES (`api.models` in extension-host/apiImpl.ts), and that is not a
 * coincidence, apiImpl is built on this. It has to be: a Fix button drawn by the pipelines extension and one
 * drawn by the shell are the same button, and the day the two disagreed about which model a click would spend,
 * one of them would be lying to the user about money. */

/* A (provider, model) pair, named the way the app names it — the ONE naming rule (providerCatalog.modelLabelFor),
 * shared with the composer's pill and the board's cards so no two surfaces can call the same pair different
 * things. An UNPINNED model has no catalog row to name it, and an empty label is the one thing this must never
 * return; that floor is the rule's own last rung, the provider's display name, since the provider is what will
 * resolve a model at run time.
 *
 * THE TIER IS NAMED HERE TOO, by the same argument: a run button that says "Opus 4.6" and spends X-High has told
 * the reader half of what the click costs, and the scale a tier is named against is the shell's (effortScale),
 * which neither the kit nor an extension can see. Read against the selection's OWN thinking, which is now a
 * thing a run pick can carry: absent (nobody touched it) keeps Max on the scale, because the turn then goes out
 * with no thinking field and the daemon names the reasoning that tier needs on the way; explicitly off takes it
 * away, because Claude refuses that pair — the same reading the daemon will make, so the word on the button is
 * the tier the run spends. */
const namedChoice = (selection: {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly account?: string | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}): AgentRunChoice => {
    const { provider, model, account, harness, effort, thinking, fast } = selection;
    const label = effortLabelOf(effort, provider, model, thinking);
    return {
        provider,
        model,
        label: modelLabelFor(provider, model),
        ...(account !== undefined ? { account } : {}),
        ...(harness !== undefined ? { harness } : {}),
        ...(effort === undefined || effort === `` ? {} : { effort }),
        ...(label === undefined ? {} : { effortLabel: label }),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(fast !== undefined ? { fast } : {}),
    };
};

/* ONE ROLE'S LIST, ENTERED ONCE FOR THE WHOLE APP, AND CACHED PER ROLE.
 *
 * `agentRunChoice` below is a READ, and it is read from places Vue gives nothing back: a run button names its
 * model from inside a computed, and the caret beside it re-reads the same fact from a click handler. Neither is
 * a setup, but `useRoleModel` is a vue-query composable underneath, and calling one per read did two bad things
 * at once. It needed an injection context that a computed getter and an event handler both lack, so the read
 * THREW ("vue-query hooks can only be used inside setup()") and took the surface down with it, which is how a
 * board of red pipeline rows came to render as a crashed extension. And every call that did land built another
 * query observer nothing ever disposed, so each settings change left one more copy of the same poll running:
 * twenty rows became twenty accumulating pollers, which is the other half of what that board did.
 *
 * A DETACHED SCOPE, not the scope of whoever reads first. This is app-lifetime state; owned by the first
 * component to render a run button, it would be torn down when that row unmounted and leave every later reader
 * holding a dead observer. Nothing stops it, by design, the list is as long-lived as the session.
 *
 * A MAP RATHER THAN ONE ENTRY, because there is a list per JOB now (contract model-roles.ts) and one board can
 * show two kinds of run button at once. Bounded by the role catalog, a fixed table, so "cache forever" is a
 * handful of computeds rather than a leak. */
const appScope = effectScope(true);
const entered = new Map<string, RoleModel>();
// `run()` only answers undefined for a STOPPED scope, and this one is never stopped.
const roleModel = (role: string): RoleModel => {
    const held = entered.get(role);
    if (held !== undefined) {
        return held;
    }
    const made = appScope.run(() => useRoleModel(role as ModelRole))!;
    entered.set(role, made);
    return made;
};

/* THE STANDING ANSWER FOR ONE JOB, and the floor underneath it. The head of that job's list is what the daemon
 * would fill in; when the list is empty, or nothing in it is connected any more, the honest fallback is the
 * owner's own composer, because it is the model they already chose to work with rather than one this file
 * guessed at. Read inside a computed and it is reactive to both.
 *
 * A ROLE THIS BUILD DOES NOT KNOW resolves to an empty chain and so to that same composer floor, which is why
 * the parameter is a bare string: an extension shipped against a newer catalog names a job this shell has never
 * heard of, and the honest answer to that is the owner's own model rather than a thrown panel.
 *
 * The pin carries its provider WITH the model, and has to: a model id is only meaningful to the provider that
 * vends it, so honouring one without the other would send a Codex id to Claude.
 *
 * ITS EFFORT COMES ALONG, so the caret opens on the tier the run would actually have used rather than on
 * "Default", and so a reader who only re-points the MODEL keeps the tier their setting asked for. `sendableEffort`
 * is read against THE PIN'S OWN THINKING, because that is what the daemon will read: the whole entry rides onto
 * a turn that named no model (turn-resume.ts), so an entry written at `max` beside `thinking: off` runs at High
 * and the meter has to say High rather than light a rung the run will not use — while one that pinned no
 * thinking keeps Max, which is what it will actually spend. The composer floor contributes none: an empty list
 * means nobody chose a tier for this job, and the chat's own effort is an answer about the turn in front of
 * you. */
export const agentRunChoice = (role: string): AgentRunChoice => {
    const head = roleModel(role).choice.value;
    const chat = useChat();
    /* THE COMPOSER FLOOR CONTRIBUTES ITS MODEL AND NOTHING ELSE. An empty list means nobody chose how this job
     * should run, and the chat's own tier, thinking and speed are answers about the turn in front of you. */
    if (head === undefined) {
        return namedChoice({ provider: chat.provider.value, model: chat.model.value });
    }
    /* THE WHOLE ENTRY OTHERWISE, so the caret opens on the run as the owner actually configured it rather than
     * on a stripped version of it: a pin written at Fast, or with thinking off, or through the Claude Code loop,
     * is a different and differently-priced run from the same model on its defaults, and a panel that opened on
     * the defaults would have quietly offered to undo that setting the moment anybody pressed its button. */
    return namedChoice({
        provider: head.provider,
        model: head.model,
        effort: sendableEffort(head.effort, head.thinking),
        harness: head.harness,
        thinking: head.thinking,
        fast: head.fast,
    });
};

export const shellModelPicking = (): ModelPicking => ({
    agentRun: agentRunChoice,
    pick: async (options) => {
        const choice = await requestModelPick({
            anchor: options.anchor,
            provider: options.provider as AgentProvider,
            model: options.model,
            ...(options.account !== undefined ? { account: options.account } : {}),
            ...(options.harness !== undefined ? { harness: options.harness as AgentHarness } : {}),
            ...(options.effort !== undefined ? { effort: options.effort } : {}),
            ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
            ...(options.fast !== undefined ? { fast: options.fast } : {}),
            ...(options.action !== undefined ? { action: options.action } : {}),
            ...(options.chooseRun === true ? { chooseRun: true } : {}),
        });
        return choice === undefined ? undefined : namedChoice(choice);
    },
});
