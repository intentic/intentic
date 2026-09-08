import { type AgentHarness, type AgentProvider, type ModelRole, sendableEffort } from "@intentic/sandbox-contract";
import type { AgentRunChoice, ModelPicking } from "@intentic/ui";
import { effectScope } from "vue";
import { effortLabelOf } from "./effortScale";
import { type RoleModel, useRoleModel } from "../accounts/roleModel";
import { requestModelPick } from "./hostModelPicker";
import { modelLabelFor } from "../accounts/providerCatalog";
import { useChat } from "../run/useChat";

// The shell's implementation of the kit's `ModelPicking`, driving every <AgentRunButton>. `api.models` in
// extension-host/apiImpl.ts is built on this, so a Fix button drawn by an extension and one drawn by the shell
// must answer identically about which model a click spends.

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

// Caches one role's list app-wide: read from a computed or click handler, contexts with no Vue injection of their
// own, via a detached `appScope` so it outlives the first button to unmount. Bounded by the fixed role catalog.
const appScope = effectScope(true);
const entered = new Map<string, RoleModel>();
// `run()` returns undefined only for a stopped scope; this one is never stopped.
const roleModel = (role: string): RoleModel => {
    const held = entered.get(role);
    if (held !== undefined) {
        return held;
    }
    const made = appScope.run(() => useRoleModel(role as ModelRole))!;
    entered.set(role, made);
    return made;
};

// Standing model for one job; falls back to the chat's own composer model when the job's pin list is empty or its
// role is unknown to this build. Effort follows the pin's own thinking via sendableEffort (turn-resume.ts): a Max
// pin with thinking off reads as High, not Max.
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
