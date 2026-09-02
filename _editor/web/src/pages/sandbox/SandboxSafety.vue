<script setup lang="ts">
import { Notice, type NoticeModel } from "@intentic/ui";
import { computed } from "vue";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import SafetyChildAgents from "./safety/SafetyChildAgents.vue";
import SafetyCommands from "./safety/SafetyCommands.vue";
import SafetyHeldCommands from "./safety/SafetyHeldCommands.vue";

/* The Sandbox hub's "Safety" tab: the standing answer to what this box may do without stopping to ask you.
 *
 * WHY IT IS A SECTION OF ITS OWN, rather than a group on the Agent tab, which is where the only related switch
 * used to live:
 *
 *   NOTHING WROTE THESE RULES. `commandRules` has been enforced on every shell command in every runtime since
 *   it was added, and the only mention of it anywhere in this app was a comment on the Agent tab saying the
 *   rulebook "is set elsewhere". There was no elsewhere: the entire safety posture of a sandbox was reachable
 *   only by hand-editing .intentic/config/settings.json. A control that exists and cannot be found is the same
 *   product as no control.
 *
 *   IT IS NOT A PROPERTY OF THE AGENT. The Agent tab is about the AI this box runs — which accounts it signs
 *   in as, which models get spent, what it is told, what it remembers. The command gate binds underneath all of
 *   that: Claude, Codex and every ACP runtime consult the same book, and so does a turn nobody started. Filed
 *   under "Agent ▸ How it runs" it would read as one runtime's turn mechanics, which is exactly what it is not.
 *
 *   IT IS NOT AN ACCOUNT PREFERENCE. /settings is the signed-in person's, across every sandbox; these rules are
 *   stored in this sandbox and enforced by its own daemon, which is what makes /sandbox the right hub.
 *
 *   AND IT IS LOOKED FOR. Someone who wants "make it ask before it runs rm -rf" scans the index column for a
 *   word. "Safety" is a word they will stop on; "Agent", four categories deep, is not.
 *
 * "SAFETY", NOT "SECURITY", and the name is argued rather than picked. The classifier under all of this is
 * regex over shell text, and the contract says so at length: it is friction and a prompt for well-behaved work,
 * never a boundary. A page called Security promises a wall this cannot be, and the person most likely to
 * believe the promise is the one reading this page. "Permissions" was the other candidate and collides twice
 * over — with Access (who may use this sandbox) and with the SDK's own permission modes in the composer.
 *
 * THE ORDER IS THE ORDER OF A TURN: which commands stop, then what you see when one stops, then whether the
 * turn may hand the job to agents of its own. `admission` — who may WAKE this box from outside — is
 * deliberately not here: that decides whether a session starts at all, which is a property of the automation
 * that starts it, and it belongs with automations rather than in the middle of this page's three groups.
 *
 * Every group reads and writes the same settings object through useSandboxSettings (a vue-query cache with one
 * optimistic write path), so this file owns only what is true of the page: why the controls are inert when they
 * are, and that the daemon dropped a field. Same shape as the Agent tab, deliberately. */

const sandbox = useSandbox();
const { settings, error: settingsError, dropped: settingsDropped } = useSandboxSettings();

// Only the states that need explaining. The first-load moment stays silent: the groups draw their own outlines
// for it, and a line that appears and then vanishes would shove every row down and back on each visit.
const settingsBlocked = computed<NoticeModel | undefined>(() => {
    if (settings.value !== undefined) {
        return undefined;
    }
    // A failed read is a fault and reads as one; an offline sandbox is a fact about the world, so it is a
    // warning rather than an alarm: the controls are disabled either way and there is nothing to fix here.
    if (settingsError.value !== undefined) {
        return { tone: `danger`, title: `Couldn't read this sandbox's safety rules.`, detail: settingsError.value };
    }
    return sandbox.reachable.value
        ? undefined
        : { tone: `warning`, title: `Your sandbox is offline, its safety rules can't be read or changed from here.` };
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Why every control below is inert, whenever it is: a settings read that hasn't landed (or failed)
             disables all of them, and an unexplained dead switch is indistinguishable from a broken page. -->
        <Notice v-if="settingsBlocked" :of="settingsBlocked" />

        <!-- A save the daemon accepted but stored WITHOUT one of its fields: the control has already snapped
             back to its old value, and without this line that reads as a picker refusing to be set rather than
             as a sandbox that predates the setting. It matters more here than anywhere else in the app, because
             the field that silently failed to save is a safety rule. -->
        <Notice v-if="settingsDropped" tone="warning">{{ settingsDropped }}</Notice>

        <SafetyCommands />
        <SafetyHeldCommands />
        <SafetyChildAgents />
    </div>
</template>
