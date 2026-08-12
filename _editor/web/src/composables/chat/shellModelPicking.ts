import { type AgentHarness, type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import type { AgentRunChoice, ModelPicking } from "@intentic/ui";
import { useAgentRunModel } from "./agentRunModel";
import { requestModelPick } from "./hostModelPicker";
import { modelLabelFor } from "./modelPicker";
import { useChat } from "./useChat";

/* WHAT A SURFACE-STARTED RUN OPENS ON, AND HOW TO RE-POINT IT — the shell's own implementation of the kit's
 * `ModelPicking`, which is what every <AgentRunButton> in the app is driven by.
 *
 * THE SAME TWO ANSWERS THE EXTENSION API GIVES (`api.models` in extension-host/apiImpl.ts), and that is not a
 * coincidence — apiImpl is built on this. It has to be: a Fix button drawn by the pipelines extension and one
 * drawn by the shell are the same button, and the day the two disagreed about which model a click would spend,
 * one of them would be lying to the user about money. */

// A (provider, model) pair, named the way the app names it. An UNPINNED model has no catalog row to name it,
// and an empty label is the one thing this must never return — the provider is what will resolve one at run
// time, so the provider is what it says. Read from the catalog first all the same: an installed ACP agent IS a
// row with an empty model id, and that row has a name.
export const namedChoice = (provider: AgentProvider, model: string, account?: string, harness?: AgentHarness): AgentRunChoice => {
    const label = modelLabelFor(provider, model);
    return {
        provider,
        model,
        label: label === `` ? providerLabel(provider) : label,
        ...(account !== undefined ? { account } : {}),
        ...(harness !== undefined ? { harness } : {}),
    };
};

/* THE STANDING ANSWER, and the floor underneath it. The head of the sandbox's agent-run list is what the daemon
 * would fill in; when that list is empty — or nothing in it is connected any more — the honest fallback is the
 * owner's own composer, because it is the model they already chose to work with rather than one this file
 * guessed at. Read inside a computed and it is reactive to both.
 *
 * The pin carries its provider WITH the model, and has to: a model id is only meaningful to the provider that
 * vends it, so honouring one without the other would send a Codex id to Claude. */
export const agentRunChoice = (): AgentRunChoice => {
    const head = useAgentRunModel().choice.value;
    const chat = useChat();
    return namedChoice((head?.provider ?? chat.provider.value) as AgentProvider, head?.model ?? chat.model.value);
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
        });
        return choice === undefined ? undefined : namedChoice(choice.provider, choice.model, choice.account, choice.harness);
    },
});
