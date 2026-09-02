<script setup lang="ts">
import type { AdmissionRule } from "@intentic/sandbox-contract";
import { Icon, Picker, type PickerOption, Row, RowGroup } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import type { Posture } from "./commandRules";

/* THE OTHER THING A TURN DOES THAT IT CANNOT TAKE BACK, and the reason it is on this page rather than beside
 * the subagent ceilings on the Agent tab: those are numbers about how WIDE a fan-out may be, and this is the
 * question of whether the turn may spend the owner's connected accounts on somebody else's say-so at all.
 *
 * It is stored in `actionRules` rather than `commandRules` (the guard's `agents.spawn` action), which is why
 * this is its own group and not a seventh row above: a group whose rows wrote to two different rulebooks would
 * be one table pretending to be one thing.
 *
 * ONE ROW FOR EVERY PROVIDER. The rulebook also takes `agents.spawn.<provider>`, and this page deliberately
 * does not offer per-provider rows: "may a tainted turn start children" is not a question whose answer changes
 * between Codex and Cursor, and six rows saying the same word is a table nobody reads. A specific key set by
 * hand still wins at the gate, so the row says when one exists rather than quietly showing a value that is not
 * in force. */

const SPAWN_KEY = `agents.spawn`;

const OPTIONS: readonly PickerOption<Posture>[] = [
    {
        value: `default`,
        label: `Default`,
        icon: `circle`,
        hint: `Starts children freely — unless this turn has read content from outside, and then it asks first.`,
    },
    {
        value: `allow`,
        label: `Always allow`,
        icon: `check-circle`,
        hint: `Starts children without asking, including in a turn that has read a page, a visitor's message or a foreign tool's output.`,
    },
    {
        value: `hold`,
        label: `Ask me`,
        icon: `lock`,
        hint: `Raises a card on the parent's own turn and waits. A detached run with no live turn to draw a card in is refused instead.`,
    },
    { value: `deny`, label: `Never`, icon: `times`, hint: `This sandbox runs no child agents at all. The tools and the CLI both refuse.` },
];

const { settings, patch } = useSandboxSettings();

const rules = computed<Readonly<Record<string, AdmissionRule>>>(() => settings.value?.actionRules ?? {});
const posture = computed<Posture>(() => rules.value[SPAWN_KEY] ?? `default`);

// Somebody has singled a provider out by hand. Named rather than swallowed: the gate prefers the specific key,
// so the control above is not the whole answer and a page that implied it was would be lying by omission.
const overridden = computed<readonly string[]>(() =>
    Object.keys(rules.value)
        .filter((key) => key.startsWith(`${SPAWN_KEY}.`))
        .map((key) => key.slice(SPAWN_KEY.length + 1))
        .sort(),
);

/* The whole rulebook back, with this one key set or dropped. `actionRules` is an OPEN record — the outbound
 * sniffer's `<provider>.<type>` keys live in it too — so it is spread rather than replaced: writing an object
 * with only this key in it would silently delete every send rule the owner has. */
const setPosture = (next: Posture): void => {
    const actionRules: Record<string, AdmissionRule> = { ...rules.value };
    if (next === `default`) {
        delete actionRules[SPAWN_KEY];
    } else {
        actionRules[SPAWN_KEY] = next;
    }
    patch({ actionRules });
};
</script>

<template>
    <RowGroup label="Helper agents">
        <Row
            icon="robot"
            title="Start agents of its own"
            description="A child agent runs its own conversation and spends the same connected accounts this one does."
        >
            <template #control>
                <Picker
                    :model-value="posture"
                    :options="OPTIONS"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    aria-label="When the agent would start helper agents"
                    header="Start agents of its own"
                    @update:model-value="(next: Posture | undefined) => next !== undefined && setPosture(next)"
                />
            </template>

            <!-- Same two cases the command rows carry, and the same ink: what `Default` resolves to, and what
                 `Always allow` gives up. `items-center` on the glyph, never `mt-0.5` — <Row> states that rule
                 for lead icons and states why. -->
            <template v-if="posture === `default` || posture === `allow` || overridden.length > 0" #below>
                <p v-if="posture === `default`" class="flex items-center gap-1.5 text-2xs text-subtle">
                    <Icon name="info-circle" aria-hidden="true" class="shrink-0" />
                    <span class="min-w-0">Starts children freely, except in a turn that has read content from outside — that one asks first.</span>
                </p>
                <p v-else-if="posture === `allow`" class="flex items-center gap-1.5 text-2xs text-warning">
                    <Icon name="exclamation-triangle" aria-hidden="true" class="shrink-0" />
                    <span class="min-w-0">
                        Also stops asking in a turn that has read outside content. That hold is the one standing between a hostile page and a fleet of
                        agents started on its instructions.
                    </span>
                </p>
                <p v-if="overridden.length > 0" class="mt-1.5 flex items-center gap-1.5 text-2xs text-subtle">
                    <Icon name="sliders-h" aria-hidden="true" class="shrink-0" />
                    <span class="min-w-0"
                        >Set by hand for {{ overridden.join(`, `) }} in this sandbox's settings file. A provider named there answers for itself and
                        ignores this row.</span
                    >
                </p>
            </template>
        </Row>
    </RowGroup>
</template>
