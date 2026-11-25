<!-- The dock over the composer: everything this chat offers the reader to press, a line each (ChatDockRow), one group of tiles. -->
<script setup lang="ts">
// ONE GROUP FOR EVERY LINE, whichever component draws it. The lines used to be a stack of separate cards with gaps
// between, each drawn its own way, so two things waiting at once read as two unrelated boxes. Here they are tiles of one
// group, a hair apart and alike (chat.css `.chat-dock`), the one the agent waits on the reader for washed warm. The order
// is the slot's: what the work needs next above, what the agent waits on last, against the composer whose words a
// plan's answers carry.
</script>

<template>
    <!-- `-mt-0.75` on the column: the first line's gap above it (chat.css `.chat-dock-row`) is taken back. -->
    <section class="chat-dock" data-chat-dock>
        <div class="-mt-0.75 flex flex-col">
            <slot />
        </div>
    </section>
</template>
