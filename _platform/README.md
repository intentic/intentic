# Account

The hosted platform plane: sign-in, the web↔api contract, the database schema, and the capability
catalog. Deliberately off the command path — the editor talks to the sandbox directly, and this plane cannot
reach into anyone's box. Two configured-off-by-default exceptions: the optional free trial
([api/src/trial/](api/src/trial/)), which serves model turns on intentic's own keys so a new user can chat
before connecting an AI account (it grants no ability to reach a sandbox); and the **hosted lane**
([api/src/sandbox/hosted/](api/src/sandbox/hosted/)), which creates a sandbox's machine on intentic's own
provider account so a new user gets a working sandbox at first sign-in with no command — for those machines
the platform deliberately keeps the way back in (wake/stop/destroy), the trade ARCHITECTURE.md states in
full. Commands still never pass through here.

A third door, and the only one an agent outside a sandbox comes through: the **MCP plane**
([api/src/mcp/](api/src/mcp/)), where a coding agent someone installed on their own laptop reaches the paid
services catalogue. It rides the same pool switch as the membership it spends, and it is authenticated by an
OAuth bearer this platform issues rather than by a sandbox's connect token — which is what lets a person buy
and spend a membership without owning a machine, as was always the intent
([docs/services-in-claude-code.md](../docs/services-in-claude-code.md)). The spend gate travels with it: an
agent may ask, but only a click in the owner's own browser releases a run.

The [Claude Code plugin](claude-plugin/) is the client half — a manifest, one MCP server URL and a skill. It
holds no logic and no credential; everything it can do is a route above.
