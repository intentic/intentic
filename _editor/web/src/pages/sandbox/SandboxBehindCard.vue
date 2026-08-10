<script setup lang="ts">
import { Card, Code, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { daemonBehind, daemonDrifted, driftedRoutes, missingRoutes } from "../../composables/sandbox/useDaemonRoutes";
import { useEnvironment } from "../../composables/sandbox/useEnvironment";

/* "This sandbox predates some features" — the specific companion to SandboxUpdateCard.
 *
 * That card compares version strings against the latest published release, which answers "is something newer
 * out?". This one compares the daemon's ADVERTISED route surface against the contract this app was built with,
 * which answers the sharper question: "what can this sandbox actually not do?". Two reasons it exists
 * separately rather than folding into the version check:
 *
 *   - In local development every package is version 0.0.0, so there is no release to compare against and the
 *     update card can never fire — which is exactly the case where a developer's daemon is most often behind
 *     their working tree, and exactly the confusion this whole mechanism was built to end.
 *   - A version being newer does not tell you whether anything you care about changed. A named route gap does.
 *
 * It reports the two ways that surface can disagree, because they read differently to whoever hit them: a
 * feature the sandbox does not HAVE fails loudly and is merely unexplained, while one it has under a different
 * shape fails QUIETLY — the screen loads, a value is blank, and nothing anywhere says why.
 *
 * THEY ALSO DIFFER IN WHAT THEY PROVE, which is why the heading is not fixed. A missing route names the older
 * side: this app has a name the daemon lacks, and a daemon newer than the app would merely advertise extras
 * nobody asks about. A drifted one names nothing — two builds disagreeing about a payload says they differ,
 * not which of them moved, and in a dev loop the page has usually been open longer than the daemon has been
 * running. Asserting "the sandbox is behind" over that is a guess, and the half of the time it guesses wrong it
 * sends someone to rebuild a sandbox that was already current — which is how a warning teaches people to
 * ignore it.
 *
 * Non-blocking on purpose. An older sandbox is a fully supported thing to be running — everything it does
 * implement keeps working, and nothing here forces an update. It only stops the gap being invisible. */

// The group half of a `<group>.<route>` name — a route name with no dot in it is its own area rather than a
// hole in the list.
const areas = (names: readonly string[]): string[] => [...new Set(names.map((name) => name.split(`.`)[0] ?? name))].toSorted();
const groups = computed(() => areas(missingRoutes.value));
const driftedGroups = computed(() => areas(driftedRoutes.value));
// The developer's remedy is the one the dev loop already documents; a user's is the update card's path.
const isDev = import.meta.env.DEV;
const { slug } = useEnvironment();
/* A RELOAD, not an image rebuild — the distinction this card used to get wrong, and the reason rebuilding felt
 * like it never helped. In dev the container does not run the daemon baked into the image: dev-sandbox.sh
 * bind-mounts the compiled output from the working tree, so the image never predates anything. What predates
 * the tree is the RUNNING PROCESS, which read that output once at boot and holds it until it restarts.
 * `pnpm build:sandbox` clears this only incidentally, by recreating the container at the end of a build that
 * takes minutes; dev-reload.sh compiles and restarts in seconds, and refuses with its own message on a
 * container old enough to lack the mounts.
 *
 * Named, not detected. The reload is one container's, and a dev machine running a branch sandbox beside main
 * is exactly where an unnamed command either touches the wrong one or refuses to move at all. This card knows
 * which sandbox it is looking at, so it says so; the slug is omitted only while /environment hasn't answered
 * yet, where the detect is right anyway. */
const reloadCommand = computed(() => `sh _sandbox/sandbox/scripts/dev-reload.sh${slug.value === undefined ? `` : ` ${slug.value}`}`);
</script>

<template>
    <Card v-if="daemonBehind || daemonDrifted" class="flex flex-col gap-4">
        <div class="flex items-start gap-2.5">
            <Icon name="info-circle" class="mt-0.5 text-lg text-muted" />
            <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-3">
                    <h2 class="font-semibold leading-tight">
                        {{ daemonBehind ? `This sandbox is behind the app` : `This sandbox and the app disagree` }}
                    </h2>
                    <StatusBadge
                        variant="warning"
                        :label="daemonBehind ? `${missingRoutes.length} missing` : `${driftedRoutes.length} changed`"
                        dot
                    />
                </div>
                <p class="text-2xs text-subtle">
                    {{
                        daemonBehind
                            ? `Its daemon was built before some of what this app knows about. Everything else is unaffected.`
                            : `One of the two is running older code than the other. Everything else is unaffected.`
                    }}
                </p>
            </div>
        </div>

        <p v-if="daemonBehind" class="text-2xs text-subtle">
            Missing — these will report that the feature is unavailable rather than working. Affected area<span v-if="groups.length !== 1">s</span>:
            <span class="font-mono">{{ groups.join(`, `) }}</span>
        </p>

        <p v-if="daemonDrifted" class="text-2xs text-subtle">
            Changed — these still answer, but exchange different fields than this app expects, so something may look blank or fail to save. Affected
            area<span v-if="driftedGroups.length !== 1">s</span>: <span class="font-mono">{{ driftedGroups.join(`, `) }}</span>
        </p>

        <template v-if="isDev">
            <p class="text-xs font-medium text-content">
                {{
                    daemonBehind
                        ? `Its daemon predates your working tree — reload it:`
                        : `If the sandbox is the older side, reloading it settles this:`
                }}
            </p>
            <Code :code="reloadCommand" lang="bash" label="Reload command" :wrap="true" />
            <p v-if="!daemonBehind" class="text-2xs text-subtle">
                Still here afterwards? Then this page is the older side — reload it and the two agree again.
            </p>
        </template>
        <p v-else class="text-2xs text-subtle">
            {{
                daemonBehind
                    ? `Updating the sandbox to a newer image restores these features.`
                    : `Reloading this page, or updating the sandbox to a newer image, brings the two back in line.`
            }}
        </p>
    </Card>
</template>
