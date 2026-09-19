import { type AgentHarness, type AgentProvider, type FixResume, type ModelRole, sendableEffort } from "@intentic/sandbox-contract";
import type { AgentRunChoice, ModelPicking } from "@intentic/ui";
import { effectScope } from "vue";
import { effortLabelOf } from "./run-settings/effortScale";
import { type RoleModel, useRoleModel } from "../accounts/roleModel";
import { requestModelPick } from "./host/hostModelPicker";
import { modelLabelFor } from "../accounts/providerCatalog";
import { useChat } from "../run/useChat";

// The shell's implementation of the kit's `ModelPicking`, driving every <AgentRunButton>. `api.models` in
// extension-host/apiImpl.ts is built on this, so a Fix button drawn by an extension and one drawn by the shell
// must answer identically about which model a click spends.

/* A (provider, model) pair, named the way the app names it — the ONE naming rule (providerCatalog.modelLabelFor). */
const namedChoice = (selection: {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly account?: string | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
    readonly resume?: FixResume | undefined;
}): AgentRunChoice => {
    const { provider, model, account, harness, effort, thinking, fast, resume } = selection;
    const label = effortLabelOf(effort, provider, model, thinking);
    return {
        provider,
        model,
        label: modelLabelFor(provider, model),
        // The verb the panel ended with rides out with the pick; the run it starts is defined by both.
        ...(resume !== undefined ? { resume } : {}),
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
/* THE COMPOSER FLOOR CONTRIBUTES ITS MODEL AND NOTHING ELSE. */
    if (head === undefined) {
        return namedChoice({ provider: chat.provider.value, model: chat.model.value });
    }
/* The picker preserves the entry's configured run settings. */
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
            ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
        });
        return choice === undefined ? undefined : namedChoice(choice);
    },
});
