// The panel keys of the sandbox's own background services, named once so the capability that starts each one
// (capabilities/handlers), the boot chain that adopts it, the system routes and the port attribution here all read the
// same name. Here rather than beside the handlers so port attribution, a host-level concern, does not import the
// capability layer to recognise its own processes.

// The dockerd session; must match what the boot chain's adopt uses.
export const DOCKER_PANEL_KEY = "docker";

// Tmux session for one entry's llama-server (`panel-model-<id>`); classified as a background process so it sits beside
// extension gateways and dockerd, not as a visible panel tab.
export const LOCAL_MODEL_PREFIX = "model-";
export const localModelPanelKey = (id: string): string => `${LOCAL_MODEL_PREFIX}${id}`;
