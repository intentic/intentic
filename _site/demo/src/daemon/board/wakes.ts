import type { AutomationSummary, SenderSeen } from "@intentic/sandbox-contract/schemas/automations";
import { refuse } from "@intentic/contract-serve";
import { automationApprovals, automationsList, resolveApproval } from "../../fixture/automations";
import { finishCard, putCard, workCard } from "./workCards";

// What firing an automation does here: the wake starts a conversation on the board (or is held for a person, where the
// automation asks for that), its turn plays for a few seconds, and the run lands in the automation's history with the
// conversation it ran on, as the daemon's wake records it when the turn ends.

// How long a wake's turn takes: long enough to see the card working, short enough to see the run recorded.
const TURN_MS = 9_000;

let wakes = 0;

const automationOf = (id: string): AutomationSummary => automationsList(Date.now()).find((automation) => automation.id === id) ?? refuse(`No automation ${id}.`, 404);

// What the card and the held row are called: the automation's note, else its prompt's first line.
const titleOf = (automation: AutomationSummary): string => (automation.note ?? automation.prompt.split(`\n`)[0] ?? automation.id).slice(0, 80);

const providerOf = (automation: AutomationSummary): string =>
    automation.trigger.kind === `listener` ? automation.trigger.provider : automation.trigger.kind === `event` ? `webhook` : automation.trigger.kind;

// Starts the woken turn and records its run once it ends.
const wake = (automation: AutomationSummary, conversationId: string | undefined, now: number): void => {
    wakes += 1;
    const id = conversationId ?? `auto-${automation.id}-${wakes}`;
    putCard(
        workCard({
            id,
            title: titleOf(automation),
            now,
            todo: automation.prompt.split(`\n`)[0],
            extra: { origin: { automationId: automation.id, provider: providerOf(automation) } },
        }),
    );
    setTimeout(() => {
        const ended = Date.now();
        finishCard(id, ended, 0.06 + (wakes % 4) * 0.03);
        automation.runs = [{ at: ended, outcome: `completed`, detail: `Ran on request; the turn finished.`, conversationId: id }, ...automation.runs];
    }, TURN_MS);
};

/** POST /automations/{id}/run: fires it now, or holds the fire where the automation asks a person first. */
export const runAutomation = (id: string): void => {
    const automation = automationOf(id);
    const now = Date.now();
    if (automation.requireApproval === true) {
        wakes += 1;
        automationApprovals(now).unshift({
            id: `held-${automation.id}-${wakes}`,
            automationId: automation.id,
            title: titleOf(automation),
            createdAt: now,
        });
        return;
    }
    wake(automation, undefined, now);
};

/** Releases a held wake: it leaves the queue and runs as an automatic one would have. */
export const approveWake = (id: string): void => {
    const now = Date.now();
    const held = automationApprovals(now).find((approval) => approval.id === id) ?? refuse(`Nothing is waiting under ${id}.`, 404);
    resolveApproval(now, id);
    wake(automationOf(held.automationId), held.conversationId, now);
};

/** Switching one off drops its next fire; switching it on schedules the next. */
export const setAutomationEnabled = (id: string, enabled: boolean): void => {
    const automation = automationOf(id);
    automation.enabled = enabled;
    automation.nextRun = enabled && automation.trigger.kind === `schedule` ? Date.now() + 3_600_000 : undefined;
};

/** A fresh door token: the old one stops working at once. Only an automation with a door has one to rotate. */
export const rotateAutomationToken = (id: string) => {
    const automation = automationOf(id);
    if (automation.trigger.kind !== `event` && automation.webhookToken === undefined) {
        refuse(`${id} has no webhook door, so there is no token to rotate.`, 409);
    }
    const token = `whk_${crypto.randomUUID().replaceAll(`-`, ``).slice(0, 28)}`;
    automation.webhookToken = token;
    return { token };
};

const HOUR = 3_600_000;
// The people the shop's Discord and Slack have brought to an automation, newest first.
const SEEN = {
    discord: [
        { id: `318274615509221376`, name: `ada`, groups: [`1180-maintainers`], messages: 42 },
        { id: `402998173225107456`, name: `jo.ops`, groups: [`1180-maintainers`], messages: 17 },
        { id: `771205093312520193`, name: `kasia (customer)`, messages: 3 },
    ],
    slack: [
        { id: `U04ADA0001`, name: `Ada Lovelace`, messages: 25 },
        { id: `U04JOOPS02`, name: `Jo`, messages: 9 },
    ],
};

export const sendersOf = (provider: string, now: number): SenderSeen[] =>
    (provider === `discord` || provider === `slack` ? SEEN[provider] : []).map((sender, index) => ({ ...sender, firstSeenAt: now - (30 + index * 6) * 24 * HOUR, lastSeenAt: now - (index * 5 + 1) * HOUR }));
