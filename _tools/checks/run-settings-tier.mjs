#!/usr/bin/env node
// How a model is RUN — reasoning effort, extended thinking, speed — is one set of controls drawn by one
// component (PickerRunSettings.vue) off one derivation (pickerRunSettings.ts). Three pickers ask those
// questions: the shell's own panel, the settings page's pinned entries and the chat composer's. A fourth
// spelling is not a styling difference: the three drew their own until the shell's had segmented rows with a
// third "leave it to the model" stop where the composer's had two-state chips, so one model answered the same
// question with two instruments a chevron apart.
// 1. A run-settings label rendered by a template that is not one of the two that own it.
// 2. An <EffortMeter> mounted anywhere but the two bindings that own it.
// Exceptions: an entry in ALLOWED, keyed by file and exact finding, with a reason; a stale entry is reported.
import { at, blank, finishFindings, tags, templateSource, templatesUnder, waiverList } from "./lib/templates.mjs";

/** The controls themselves, and the meter one of them mounts: between them they own every word below. */
const OWNERS = new Set([`_editor/web/src/features/chat/models/PickerRunSettings.vue`, `_editor/web/src/features/chat/composer/EffortMeter.vue`]);

/* The two bindings of the meter, and the reason there are two: the composer keeps one beside its model pill, so
 * its own picker draws every other control and leaves that one out (`effortRow`). A third would be a third
 * answer to what a rung means. */
const METER_MOUNTS = new Set([
    `_editor/web/src/features/chat/models/PickerRunSettings.vue`,
    `_editor/web/src/features/chat/composer/ComposerEffort.vue`,
]);

// The visible name of each control. Matched against the template with script, style and comments blanked, so
// prose about them stays free and only what a reader would actually SEE counts.
const LABELS = [`Reasoning effort`, `Extended thinking`, `Fast speed`];

const ALLOWED = new Map();

const tracked = templatesUnder(`_editor`, `_extensions`);
const findings = [];
const { waived, stale } = waiverList(ALLOWED, `run-settings-tier.mjs`);

for (const path of tracked) {
    const scan = blank(templateSource(path));

    if (!OWNERS.has(path)) {
        for (const label of LABELS) {
            const index = scan.indexOf(label);
            if (index !== -1 && !waived(path, label)) {
                findings.push({
                    at: at(path, scan, index),
                    why: `"${label}" is a control of PickerRunSettings, the one place a model's run settings are drawn: mount <PickerRunSettings> (and \`usePickerRunSettings\` for whether your footer is earned) rather than drawing it again — its one switch, \`effort-row\`, is for a surface that already draws the meter, not for a second design`,
                });
            }
        }
    }

    if (!METER_MOUNTS.has(path)) {
        for (const { closing, name, index } of tags(scan)) {
            if (closing === `` && name === `EffortMeter` && !waived(path, name)) {
                findings.push({
                    at: at(path, scan, index),
                    why: `<EffortMeter> is bound in exactly two places — PickerRunSettings (every picker's row) and ComposerEffort (the chat's own, beside the model pill) — because the rungs a model offers and the clamp that survives a re-point are one derivation: bind it through one of those`,
                });
            }
        }
    }
}

findings.push(...stale());

finishFindings(
    findings,
    `with the run settings. Effort, extended thinking and speed are one set of controls, drawn once.`,
    `${tracked.length} templates: how a model is run is asked by one control, in one vocabulary, on every picker`,
);
