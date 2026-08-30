<script setup lang="ts">
import { Icon, InfoHint } from "@intentic/ui";
import { useEndpoint } from "../composables/sandbox/useEndpoint";

/* THE ONE TRANSPORT STATE WORTH SAYING OUT LOUD, because it is the only one the user can act on and the only
 * one that changes what the app can do.
 *
 * Three addresses can reach a daemon and two of them multiplex: the certified loopback speaks h2, the tunnel's
 * edge speaks h2 and advertises h3, and either carries every stream this app wants on one connection. The
 * third is plain http on 127.0.0.1, which is HTTP/1.1 and cannot be otherwise, because no browser speaks
 * cleartext h2. There a browser allows SIX connections per origin, shared across every window of this app,
 * against something that holds one for each window's live feed and one for every streaming agent.
 *
 * WHY IT NEEDS SAYING AT ALL, rather than being left to the connection detail. The symptom of running out is
 * not an error. Requests queue in the browser and never reach the daemon, so the daemon's log stays healthy
 * and silent, nothing times out on the wire, and the workspace simply stops moving. It was reported as "the
 * sandbox froze" for as long as it existed, and the true cause: a DNS record, three layers away: was not
 * visible from any screen in the product. One line naming the transport turns an unexplainable freeze into a
 * fact about the network, which is a thing people can recognise.
 *
 * WHY IT READS AS INFORMATION RATHER THAN AN ALARM. Being here means every multiplexed address was tried and
 * none answered (endpoint.ts ranks this one last), which is very nearly a synonym for "this machine is
 * offline". Offline is not a failure of ours, the workspace still works, and the app re-probes every minute and
 * moves itself back the moment anything better answers. So: the receipt lane, muted, no buttons, and it leaves
 * on its own. There is nothing here to dismiss and nothing to click, because the fix is not in this app. */

const { degradedTransport } = useEndpoint();
</script>

<template>
    <!-- THE CORNER, not the centred lane at the bottom of the screen, and the distinction is between a fact and
         an event. That lane belongs to things that happen and then stop: a receipt (`bottom-4`) and the
         shortcut question above it (`bottom-16`), both of which retire. This is a CONDITION, on screen for as
         long as it is true, and a persistent card parked in that lane would sit on top of every receipt raised
         while it lasts. Same geometry, tokens and tier as AppUpdateNotice, which is the other card in this app
         that states a standing fact about the session rather than reporting an event. -->
    <div
        v-if="degradedTransport"
        class="fixed inset-x-3 bottom-3 z-40 ml-auto flex max-w-[22rem] items-start gap-2 rounded-lg border border-line-strong bg-card p-3 shadow-lg"
        role="status"
    >
        <Icon name="wifi" class="mt-0.5 shrink-0 text-xs text-muted" aria-hidden="true" />
        <div class="min-w-0 flex-1">
            <p class="text-xs font-medium text-content">Limited connection to this sandbox</p>
            <p class="mt-0.5 text-2xs text-muted">Live agent output may lag. It clears when you are back online.</p>
        </div>
        <InfoHint class="mt-0.5 shrink-0" label="About this connection">
            <span class="block text-xs text-content">
                Nothing but your own machine can be reached right now, so the browser is talking to the sandbox over plain HTTP on 127.0.0.1. That is
                HTTP/1.1, which a browser allows only six of at a time across every window of this app, and each streaming agent holds one. Everything
                still works; some of it waits its turn. The faster addresses are re-checked every minute, and this goes away on its own once one of
                them answers.
            </span>
        </InfoHint>
    </div>
</template>
