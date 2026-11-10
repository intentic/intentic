import { ref } from "vue";

// A press elsewhere asking the board to open its metrics readout when it is next on screen: the rail's near-a-limit
// tile (shell/rail/tools/MetricsAlertTile.vue) sets it and goes to the board, whose readout (BoardMetrics.vue) opens
// and clears it. Not remembered: a popover opened to look at something is not still open after a reload.
// allow(module-state): one window's request, the same whichever sandbox is open
export const metricsAsked = ref(false);
