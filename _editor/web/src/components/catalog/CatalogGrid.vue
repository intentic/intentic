<!-- The grid a catalog's tiles (<CatalogTile>) sit in, one for every catalog (Capabilities, and Extensions' Browse and
     Installed), so they all wrap at the same widths. How many columns fit is a fact about the pane, not the screen, so it
     asks its own container rather than the viewport. -->
<template>
    <div class="@container">
        <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
            <slot />
        </div>
    </div>
</template>
