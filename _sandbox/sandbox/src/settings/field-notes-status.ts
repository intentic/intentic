import { asZone, cronOptions, type FieldNotesStatus, UTC, type Zone } from "@intentic/sandbox-contract";
import { Cron } from "croner";
import { zoneOf } from "../automations/schedule-zone.js";
import { fieldNotes } from "../agent/prompt/field-notes.js";
import { FIELD_NOTES_AUTOMATION_ID } from "../automations/catalog.js";
import type { Services } from "../composition.js";

// What the agent-settings row can say about the brief. Two independent facts that read as one: the FILE (is there a
// brief, how much of it this budget reaches) and the AUTOMATION (is anything going to rewrite it). Both are needed,
// because the failure the row exists to show is a switch left on over a file nothing maintains.

// Absent for anything but a cron: a listener or workspace trigger has no next time, and a one-off that has fired has no
// next one either.
const nextRunAt = (trigger: { readonly kind: string; readonly cron?: string | undefined; readonly tz?: string | undefined }, sandbox: Zone): number | undefined => {
    if (trigger.kind !== "schedule" || trigger.cron === undefined) {
        return undefined;
    }
    try {
        return new Cron(trigger.cron, cronOptions(zoneOf(trigger, sandbox))).nextRun()?.getTime();
    } catch {
        // A cron hand-edited into invalidity silences its own automation; the row says "nothing scheduled" rather than
        // failing the whole settings screen over it.
        return undefined;
    }
};

// Three seams, named: the budget to read the brief at, the tree to read it from, and whether anything is scheduled to
// rewrite it.
type FieldNotesDeps = Pick<Services, "sandboxSettings" | "workspace" | "automations">;

export const fieldNotesStatus = async (services: FieldNotesDeps): Promise<FieldNotesStatus> => {
    const settings = await services.sandboxSettings.get();
    let unreadable: string | undefined;
    const brief = fieldNotes({
        root: services.workspace.root,
        budget: settings.fieldNotesBudget,
        onUnreadable: (why) => {
            unreadable = why;
        },
    });
    const automation = await services.automations.get(FIELD_NOTES_AUTOMATION_ID);
    const scheduled = automation === undefined ? undefined : nextRunAt(automation.trigger, asZone(settings.timezone) ?? UTC);
    return {
        // A file that exists and cannot be indexed is PRESENT and broken, not missing: "set one up" would be the wrong
        // advice, and it is the advice the row gives when this is false.
        present: brief !== undefined || unreadable !== undefined,
        ...(brief === undefined
            ? {}
            : { writtenAt: brief.writtenAt, ranksSent: brief.ranksSent, ranksTotal: brief.ranksTotal, chars: brief.chars }),
        automation: automation === undefined ? "missing" : automation.enabled ? "enabled" : "disabled",
        ...(scheduled === undefined ? {} : { nextRunAt: scheduled }),
        ...(unreadable === undefined ? {} : { unreadable }),
    };
};
