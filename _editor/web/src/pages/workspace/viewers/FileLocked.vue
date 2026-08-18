<script setup lang="ts">
import { STATE_DIR } from "@intentic/constants";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { basename } from "@intentic/ui/path";

/* THE FILES THE APP WILL NOT OPEN, SAYING SO IN THE ONE PLACE THE READER LOOKED.
 *
 * A handful of entries under the workspace's own state folder hold the sandbox's keys — the sign-ins behind
 * every connected account, who owns the box, the browsers the agent is logged into. They are refused to
 * everyone, the owner included, because nothing needs to reach a credential by opening a file.
 *
 * The refusal used to arrive as a flicker: a tab appeared, the read came back empty, the tab closed. That reads
 * as a bug, and a reader who thinks a screen is broken tries again. So the row is drawn locked (the explorer)
 * and clicking it lands HERE, where the file says what it holds and points at the screen that actually manages
 * it — the padlock is a door, not a wall.
 *
 * Each entry gets its own sentence rather than one blanket line, because "kept private" answers nothing on its
 * own: what the reader wants to know is what is inside and where to go instead. */

const { path } = defineProps<{ path: string }>();

interface Locked {
    // What it holds, in the reader's terms — completes "It holds …".
    readonly holds: string;
    // A whole folder rather than a single file, which changes both the noun and the name shown for it.
    readonly folder?: boolean;
    // Where that thing is actually managed, when there is such a screen.
    readonly manage?: { readonly label: string; readonly to: string };
}

const LOCKED: Record<string, Locked> = {
    /* The one entry here that holds no secret — its sign-ins moved to the vault under `auth/`, and what is left
     * is the LIST: every account, computer and service the agent may reach. Locked all the same, because adding
     * a line to that list by saving a file would be granting a capability nobody approved. Its sentence says
     * connections rather than sign-ins for that reason; the old wording described a file that no longer exists,
     * and it is also the entry whose changes ARE readable — the root repo tracks it, so the diff is in Changes. */
    "capabilities.json": {
        holds: `the list of accounts, computers and services this sandbox may reach, which the agent acts through`,
        manage: { label: `Capabilities`, to: `/capabilities` },
    },
    "owner.json": { holds: `who this sandbox belongs to`, manage: { label: `Access`, to: `/sandbox/access` } },
    "members.json": { holds: `who you've invited to this sandbox`, manage: { label: `Access`, to: `/sandbox/access` } },
    "ci.json": { holds: `the secret your builds use to reach this sandbox` },
    "claude.json": { holds: `an agent's own sign-in`, manage: { label: `Agent settings`, to: `/sandbox/agent` } },
    auth: { holds: `the agents' sign-ins with their providers`, folder: true, manage: { label: `Agent settings`, to: `/sandbox/agent` } },
    sessions: {
        holds: `your agents' conversations, in the form their provider keeps them`,
        folder: true,
        manage: { label: `Agents`, to: `/agents` },
    },
    browser: {
        holds: `the browser profiles your agent is signed in on`,
        folder: true,
        manage: { label: `Browsers`, to: `/browsers` },
    },
    ".git": { holds: `this workspace's own history, kept where nothing running here can rewrite it`, folder: true },
};

// Which entry this path belongs to: the root's own `.git`, or the name directly under the state folder — so
// everything inside `auth/`, `sessions/` and `browser/` inherits that folder's sentence.
const entry = computed(() => {
    const segments = path.split(`/`).filter((segment) => segment !== ``);
    return segments[0] === `.git` ? `.git` : segments[0] === STATE_DIR ? (segments[1] ?? ``) : ``;
});
const locked = computed<Locked | undefined>(() => LOCKED[entry.value]);
/* WHAT THE HEADLINE NAMES — the locked entry, not the path that was opened.
 *
 * They are the same thing for a locked file, which is every case the explorer can produce: a locked folder is
 * drawn as one row and never descended, so nobody clicks their way to a file inside one. A restored tab or a
 * pasted link still can, and naming the leaf there produced sentences like "Cookies is kept private" — true of
 * something the reader has no idea about. The folder is the fact; its contents are an implementation detail of
 * the folder. */
const subject = computed(() => (locked.value?.folder === true ? (entry.value === `.git` ? `.git` : `${STATE_DIR}/${entry.value}`) : basename(path)));
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon name="lock" class="text-4xl text-subtle" />
        <p class="text-sm text-content">
            <span class="font-medium">{{ subject }}</span> is kept private by this sandbox.
        </p>
        <p class="max-w-sm text-xs text-muted">
            It holds {{ locked?.holds ?? `something only the sandbox itself uses` }}. It can't be opened, edited or downloaded here.
        </p>
        <RouterLink
            v-if="locked?.manage"
            :to="locked.manage.to"
            class="mt-1 inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-content transition-colors hover:border-line-strong hover:bg-overlay"
        >
            Open {{ locked.manage.label }}
            <Icon name="arrow-right" class="text-xs" />
        </RouterLink>
    </div>
</template>
