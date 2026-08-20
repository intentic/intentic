import { type AgentHarness, type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import type { AgentRunChoice, ModelPicking } from "@intentic/ui";
import { effectScope } from "vue";
import { type AgentRunModel, useAgentRunModel } from "./agentRunModel";
import { requestModelPick } from "./hostModelPicker";
import { modelLabelFor } from "./modelPicker";
import { useChat } from "./useChat";

/* WHAT A SURFACE-STARTED RUN OPENS ON, AND HOW TO RE-POINT IT, the shell's own implementation of the kit's
 * `ModelPicking`, which is what every <AgentRunButton> in the app is driven by.
 *
 * THE SAME TWO ANSWERS THE EXTENSION API GIVES (`api.models` in extension-host/apiImpl.ts), and that is not a
 * coincidence, apiImpl is built on this. It has to be: a Fix button drawn by the pipelines extension and one
 * drawn by the shell are the same button, and the day the two disagreed about which model a click would spend,
 * one of them would be lying to the user about money. */

// A (provider, model) pair, named the way the app names it. An UNPINNED model has no catalog row to name it,
// and an empty label is the one thing this must never return, the provider is what will resolve one at run
// time, so the provider is what it says. Read from the catalog first all the same: an installed ACP agent IS a
// row with an empty model id, and that row has a name.
const namedChoice = (provider: AgentProvider, model: string, account?: string, harness?: AgentHarness): AgentRunChoice => {
    const label = modelLabelFor(provider, model);
    return {
        provider,
        model,
        label: label === `` ? providerLabel(provider) : label,
        ...(account !== undefined ? { account } : {}),
        ...(harness !== undefined ? { harness } : {}),
    };
};

/* THE AGENT-RUN LIST, ENTERED ONCE FOR THE WHOLE APP.
 *
 * `agentRunChoice` below is a READ, and it is read from places Vue gives nothing back: a run button names its
 * model from inside a computed, and the caret beside it re-reads the same fact from a click handler. Neither is
 * a setup, but `useAgentRunModel` is a vue-query composable underneath, and calling one per read did two bad
 * things at once. It needed an injection context that a computed getter and an event handler both lack, so the
 * read THREW ("vue-query hooks can only be used inside setup()") and took the surface down with it, which is
 * how a board of red pipeline rows came to render as a crashed extension. And every call that did land built
 * another query observer nothing ever disposed, so each settings change left one more copy of the same poll
 * running: twenty rows became twenty accumulating pollers, which is the other half of what that board did.
 *
 * A DETACHED SCOPE, not the scope of whoever reads first. This is app-lifetime state; owned by the first
 * component to render a run button, it would be torn down when that row unmounted and leave every later reader
 * holding a dead observer. Nothing stops it, by design, the list is as long-lived as the session. */
const appScope = effectScope(true);
let runModel: AgentRunModel | undefined;
// `run()` only answers undefined for a STOPPED scope, and this one is never stopped.
const agentRunModel = (): AgentRunModel => (runModel ??= appScope.run(useAgentRunModel)!);

/* THE STANDING ANSWER, and the floor underneath it. The head of the sandbox's agent-run list is what the daemon
 * would fill in; when that list is empty, or nothing in it is connected any more, the honest fallback is the
 * owner's own composer, because it is the model they already chose to work with rather than one this file
 * guessed at. Read inside a computed and it is reactive to both.
 *
 * The pin carries its provider WITH the model, and has to: a model id is only meaningful to the provider that
 * vends it, so honouring one without the other would send a Codex id to Claude. */
export const agentRunChoice = (): AgentRunChoice => {
    const head = agentRunModel().choice.value;
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
