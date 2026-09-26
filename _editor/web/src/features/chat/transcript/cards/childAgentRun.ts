import { type ChildAgentAsk, type ChildRun, childRunOf, harnessChoosable, sameChildRun } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { modelLabelFor } from "../../accounts/providerCatalog";
import { accountsOf } from "../../accounts/useChat-accounts";
import type { ModelChoice } from "../../models/host/hostModelPicker";
import { effortLabelOf } from "../../models/run-settings/effortScale";
import { defaultPinRunSettings } from "../../models/run-settings/pickerRunSettings";

// How the child-agent card reads the run a child would start on, and turns the shell picker's answer back into one.
// The card only draws what these return.

/** The run in one line, as the picker's commit bar and a run button's caret spell it: model, the tier it thinks at, speed. */
export const childRunLine = (run: ChildRun): string =>
    [
        modelLabelFor(run.provider, run.model),
        effortLabelOf(run.effort, run.provider, run.model, run.thinking),
        run.fast === true ? t(`chat.chatChildAgentAsk.fast`) : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

// Who pays: the account named, by its name here; the only one there is, when nothing is named; or the daemon's
// most-room pick among several. A provider with no accounts of its own has nothing to say here.
const accountFact = (run: ChildRun): string | undefined => {
    const accounts = accountsOf(run.provider);
    if (run.account !== undefined) {
        const named = accounts.find((account) => account.id === run.account);
        return t(`chat.chatChildAgentAsk.account`, { account: named?.label ?? run.account });
    }
    const [only, ...others] = accounts;
    if (only === undefined) {
        return undefined;
    }
    return others.length === 0 ? t(`chat.chatChildAgentAsk.account`, { account: only.label }) : t(`chat.chatChildAgentAsk.anyAccount`);
};

/** What the run line leaves out, each only where it says something: who pays, which loop, which machine. */
export const childRunFacts = (ask: ChildAgentAsk, run: ChildRun): readonly string[] =>
    [
        accountFact(run),
        // The loop is worth a word only where the provider has two that differ; Claude's own IS Claude Code.
        run.harness === `claude-code` && harnessChoosable(run.provider) ? t(`chat.chatChildAgentAsk.through`, { harness: t(`shared.claudeCode`) }) : undefined,
        ask.on === undefined ? undefined : ask.on === `here` ? t(`chat.chatChildAgentAsk.onHere`) : t(`chat.chatChildAgentAsk.onRunner`, { runner: ask.on }),
    ].filter((fact) => fact !== undefined);

// The picker opens every knob at a state, never at "unset" (pickerRunSettings.ts), so a knob the agent left to the model
// comes back as the picker's default. Left there, it is still the agent's: only a knob the owner moved is a change.
const unmoved = (choice: ModelChoice, ask: ChildRun): ChildRun => {
    const picked = childRunOf(choice);
    const harness = ask.harness ?? `native`;
    if (picked.provider !== ask.provider || (picked.harness ?? `native`) !== harness) {
        return picked;
    }
    const seeded = defaultPinRunSettings(ask.provider, harness);
    const { effort, thinking, ...kept } = picked;
    const run: ChildRun = kept;
    if (effort !== undefined && !(ask.effort === undefined && effort === seeded.effort)) {
        run.effort = effort;
    }
    if (thinking !== undefined && !(ask.thinking === undefined && thinking === seeded.thinking)) {
        run.thinking = thinking;
    }
    return run;
};

/** The picker's answer as the run to start the child on, or undefined when it is what the agent asked for anyway. */
export const pickedChildRun = (choice: ModelChoice, ask: ChildRun): ChildRun | undefined => {
    const picked = unmoved(choice, ask);
    return sameChildRun(picked, ask) ? undefined : picked;
};
