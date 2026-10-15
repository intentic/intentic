import { type ChildAgentAsk, type ChildRun, childRunOf, loopLabel, sameChildRun } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { modelLabelFor } from "../../accounts/providerCatalog";
import { accountsOf } from "../../accounts/useChat-accounts";
import type { ModelChoice } from "../../models/host/hostModelPicker";
import { effortLabelOf } from "../../models/run-settings/effortScale";
import { offeredLoops, selectedLoop } from "../../models/offeredLoops";
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

// Who pays, where someone chose: the account named, by its name here. Left unnamed, the daemon takes whichever account
// has the most room when the child starts, which is the default and so nothing worth a line; the picker shows it.
const accountFact = (run: ChildRun): string | undefined => {
    if (run.account === undefined) {
        return undefined;
    }
    const named = accountsOf(run.provider).find((account) => account.id === run.account);
    return t(`chat.chatChildAgentAsk.account`, { account: named?.label ?? run.account });
};

// The loop is worth a word only where it isn't the provider's default; Claude's own IS Claude Code. A loop this daemon
// doesn't offer the provider on runs as the default, so it is not named either.
const loopFact = (run: ChildRun): string | undefined => {
    const offered = offeredLoops(run.provider);
    const loop = selectedLoop(offered, run.harness ?? `native`);
    return loop === offered[0] ? undefined : t(`chat.chatChildAgentAsk.through`, { harness: loopLabel(run.provider, loop) });
};

/** What the run line leaves out, each only where it says something: who pays, which loop, which machine. */
export const childRunFacts = (ask: ChildAgentAsk, run: ChildRun): readonly string[] =>
    [
        accountFact(run),
        loopFact(run),
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
