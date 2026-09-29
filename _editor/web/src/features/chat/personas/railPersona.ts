import { ref } from "vue";

// Whom the chat list is scoped to: the persona picked in its grid, or undefined for Anyone, which scopes nothing. Held
// here rather than in the list, since the rail's foot reads it too (its New agent press starts as the persona picked,
// as that tile's own "+" does), and per window: a floating window is its own app copy with its own module state.
// The label rides along for the foot's button; the list keeps it current and drops a pick whose persona is gone
// (usePersonaScope).
export const railPersona = ref<{ readonly id: string; readonly label: string } | undefined>();
