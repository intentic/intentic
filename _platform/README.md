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
