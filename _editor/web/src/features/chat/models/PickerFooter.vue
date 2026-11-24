<!-- THE MODEL PICKER'S FOOTER, one surface for every host (the composer's picker, the shell's, a pinned model's), so a reader
     can't tell which of them opened it. Its parts bring their own spacing: PickerStatus heads it as the list heads its groups,
     PickerAccounts' rows are the list's rows, and PickerRunSettings closes it under a rule of its own.
     NO FILL OF ITS OWN: it is the overlay's slab under one rule, as the search and the rail above are. It used to paint the
     canvas, the room's darkest value, which read as a separate dark panel bolted on while overlays were the shadow, and as a
     hole cut into the slab once they were lifted into the light (sanctum.css, `--sanctum-overlay`). -->
<template>
    <!-- Matches the model list's own px-3 rhythm; row groups counter it with -mx-3 so their wash still spans the panel.
         Shrinks and scrolls instead of holding natural height, paired with the list's own floor. -->
    <div class="flex min-h-0 shrink flex-col overflow-y-auto border-t border-line px-3">
        <slot />
    </div>
</template>
