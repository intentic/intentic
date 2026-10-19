import { requestModelPick } from "./hostModelPicker";
import { usePaneView } from "../panel/useChat-view";

// The model list reached from somewhere other than the composer's own pill (the account gate, a spent trial, a turn a
// model's refusal stopped partway): the shell's picker opens anchored to the press, and its answer applies to this
// pane's conversation exactly as a pick from the composer would. The conversation keeps its history and its changes.
export const usePaneModelPick = (): ((anchor: HTMLElement) => Promise<void>) => {
    const view = usePaneView();
    return async (anchor) => {
        const choice = await requestModelPick({ anchor, provider: view.provider.value, model: view.model.value, harness: view.harness.value });
        if (choice === undefined) {
            return;
        }
        view.selectModel({ provider: choice.provider, value: choice.model });
        if (choice.harness !== undefined) {
            view.conversation.value.selection.apply({ kind: `selectHarness`, harness: choice.harness });
        }
        if (choice.account !== undefined) {
            view.conversation.value.selection.apply({ kind: `selectAccount`, account: choice.account });
        }
    };
};
