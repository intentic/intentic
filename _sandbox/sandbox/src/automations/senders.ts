import type { Automation, ListenerMessage } from "@intentic/sandbox-contract";

// Which lane a listener message runs in, decided by who sent it (Automation.senders). A lane is what the fire wears
// and whether a person has to release it; two senders resolving to different personas must never share a wake or a
// thread, which is why the lane also keys the batcher and the thread (listeners.ts).

export interface SenderLane {
    // The persona the wake wears; undefined is no persona, the full toolbox reaching no account.
    readonly actsAs: string | undefined;
    // Held for a person on top of whatever the automation and the admission floor already say.
    readonly requireApproval: boolean;
}

// Whether a rule names this sender: by id, or by any group the service reported on them. Never by name.
const named = (rule: NonNullable<Automation["senders"]>["rules"][number], author: ListenerMessage["author"]): boolean =>
    (rule.ids?.includes(author.id) ?? false) || (rule.groups?.some((group) => author.groups?.includes(group)) ?? false);

// The lane for this sender, or undefined when they are not admitted at all. No `senders` means everyone the trigger's
// filters admit, wearing the automation's own persona, which is what a listener did before rules existed.
export const senderLane = (automation: Automation, author: ListenerMessage["author"]): SenderLane | undefined => {
    const senders = automation.senders;
    if (senders === undefined) {
        return { actsAs: automation.actsAs, requireApproval: false };
    }
    const rule = senders.rules.find((candidate) => named(candidate, author));
    if (rule !== undefined) {
        return { actsAs: rule.actsAs, requireApproval: rule.requireApproval === true };
    }
    switch (senders.others) {
        case "ignore":
            return undefined;
        case "hold":
            return { actsAs: automation.actsAs, requireApproval: true };
        case "allow":
            return { actsAs: automation.actsAs, requireApproval: false };
    }
};
