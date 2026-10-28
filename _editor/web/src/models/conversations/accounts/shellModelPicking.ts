import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { FixResume } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import type { ModelRole } from "@intentic/sandbox-contract/models/model-roles";
import { sendableEffort } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentRunAllowance, AgentRunChoice, ModelPicking } from "@intentic/ui";
import { effectScope } from "vue";
import { effortLabelOf } from "../../providers/effortScale";
import { type RoleModel, useRoleModel } from "../../providers/roleModel";
import { requestModelPick } from "./hostModelPicker";
import { modelLabelFor } from "../../providers/providerCatalog";
import { rememberedModelFor, rememberedProviderFor } from "../run/turnDefaults";
import { pickUpShort, pickUpWhen } from "../endings/pickUp";
import { runSpentUntil } from "./runServing";

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

// Standing model for one job; falls back to the model a new chat would open on (the remembered pick, resolved against
// what can run) when the job's pin list is empty or its role is unknown to this build: a run starts a conversation of
// its own, so the open chat's model says nothing about it. A surface that sends this along with its press (Pipelines'
// Fix) gets it run by a sandbox with no pin. Effort follows the pin's own thinking via sendableEffort
// (turn-resume.ts): a Max pin with thinking off reads as High, not Max.
export const agentRunChoice = (role: string): AgentRunChoice => {
    const head = roleModel(role).choice.value;
/* THE CHAT FLOOR CONTRIBUTES ITS MODEL AND NOTHING ELSE. */
    if (head === undefined) {
        const provider = rememberedProviderFor();
        return namedChoice({ provider, model: rememberedModelFor(provider) });
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

/**
 * What a run started on `choice` at `now` would meet: its allowance spent until a reopen still ahead, worded as the
 * composer's scheduled Send words it ("40m", "21:00"), or undefined when it would go at once. One rule (runServing.ts) for
 * the composer and every run button, so a model the picker stamps "back at 21:00" is one whose press books for 21:00.
 */
export const runAllowance = (
    choice: { readonly provider: string; readonly model: string; readonly account?: string | undefined; readonly harness?: string | undefined },
    now: number,
): AgentRunAllowance | undefined => {
    const at = runSpentUntil(choice, now);
    return at === undefined ? undefined : { reopensAt: at, short: pickUpShort(at, now), when: pickUpWhen(at, now) };
};

export const shellModelPicking = (): ModelPicking => ({
    agentRun: agentRunChoice,
    allowance: runAllowance,
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
            schedules: options.schedules,
        });
        return choice === undefined ? undefined : namedChoice(choice);
    },
});
