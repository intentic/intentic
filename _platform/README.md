# Account

The hosted platform plane: sign-in, the web↔api contract, the database schema, and the capability
catalog. Deliberately off the command path — the editor talks to the sandbox directly, and this plane cannot
reach into anyone's box. The single exception is the optional free trial ([api/src/trial/](api/src/trial/)),
which serves model turns on intentic's own keys so a new user can chat before connecting an AI account; it is
off unless keys are configured, and it grants no ability to reach a sandbox.
