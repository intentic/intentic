<!-- The dock over the composer: everything this chat offers the reader to press, in one frame, a line each (ChatDockRow). -->
<script setup lang="ts">
// ONE FRAME FOR EVERY LINE, whichever component draws it. The lines used to be a stack of separate cards with gaps
// between, each drawn its own way, so two things waiting at once read as two unrelated boxes. Here they are rows of one
// thing, ruled apart (chat.css `.chat-dock`), the frame taking the accent while the agent waits on the reader. The order
// is the slot's: what the work needs next above, what the agent waits on last, against the composer whose words a
// plan's answers carry.
</script>

<template>
    <!-- `-mt-px` on the column: the first line's rule sits under the frame's own top edge. -->
    <section class="chat-dock relative overflow-hidden rounded-xl bg-card" data-chat-dock>
        <div class="-mt-px flex flex-col">
            <slot />
        </div>
    </section>
</template>
