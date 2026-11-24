/* WHERE THE CI FLEET SERVICE KEEPS ITS THINGS on a Linux computer that runs self-hosted GitHub Actions runners. The
   service runs as root (systemd), from a root-owned copy of this agent's binary, so the person's own agent (and
   whatever runs as the person) cannot swap what root runs. Its state directory is the one the janitor scripts it
   replaces used, so a host moving over keeps its trash and compact-request file where wsl-maintenance.ps1 reads them. */

export const FLEET_UNIT = "intentic-ci-fleet.service";
export const FLEET_UNIT_PATH = `/etc/systemd/system/${FLEET_UNIT}`;
// The root-owned copy of the agent binary the unit runs.
export const FLEET_LIB_DIR = "/usr/local/lib/intentic-ci";
export const FLEET_BINARY = `${FLEET_LIB_DIR}/intentic-machine`;
export const FLEET_CONFIG_DIR = "/etc/intentic-ci";
export const FLEET_CONFIG_PATH = `${FLEET_CONFIG_DIR}/fleet.json`;
// The socket the person's agent asks over: root-owned, 0660, the agent user's group.
export const FLEET_RUN_DIR = "/run/intentic-ci";
export const FLEET_SOCKET = `${FLEET_RUN_DIR}/fleet.sock`;
// What wsl-workers.sh writes while it pauses the workers for a Windows smoke job (and the drop-in it puts on each).
export const SMOKE_PAUSE_FLAG = `${FLEET_RUN_DIR}/workers-paused`;
export const SMOKE_PAUSE_DROPIN = "intentic-paused.conf";

// The root units the service replaces; `ci-fleet install` disables them.
export const RETIRED_UNITS: readonly string[] = ["intentic-ci-janitor.timer", "intentic-ci-janitor.service", "intentic-ci-prune.timer", "intentic-ci-prune.service", "intentic-ci-test-slots.service"];

// The runner units, as the runner's own svc.sh names them.
export const RUNNER_UNIT_GLOB = "actions.runner.*.service";
export const RUNNER_UNIT_PATTERN = /^actions\.runner\.[A-Za-z0-9._-]+\.service$/u;
