<!-- Centered, width-constrained page shell. Replaces the repeated `mx-auto max-w-* p-6` wrappers;
     width/padding come from the `--ui-page-*` tokens via the `.ui-page` class. -->
<template>
    <div class="ui-page">
        <slot />
    </div>
</template>
