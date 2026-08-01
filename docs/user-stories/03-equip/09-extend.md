# Add anything else, and be told when I am installing someone else's code

As someone whose stack is not in the catalog, I want to add an MCP server, a plugin, an extension or another coding agent, so that the catalog being finite is not the end of the conversation.

This section is the escape hatch, and it is the one where the honesty matters most: several of these cards install and run code from a repository I am naming. That is a legitimate thing to want and a dangerous thing to do quietly, so a card that will run someone else's code says so as a marker on the card in the catalog, and again in the list of what it will add before I apply it.

Finding the thing to install should not require knowing its clone URL. A plugin can be found by pointing at a marketplace repository and picking from what it lists, which fills the form for me — including the token, when the plugin lives in the same private repository I just browsed. And an agent that signs in interactively rather than by token gets a sign-in that opens its terminal, because that is where its login actually happens.

## Acceptance criteria

- [ ] The Extend section lists the MCP, plugin, extension and coding-agent cards with a line saying what each adds
- [ ] A card that installs or runs code from a repository carries that as a marker on the card in the catalog
- [ ] The form lists everything applying the card will add to the sandbox, before the action that applies it
- [ ] The plugin card can browse a marketplace repository and list what it offers, with anything not installable marked as such
- [ ] Picking an entry from that list fills the form's fields rather than leaving them to be copied by hand
- [ ] An entry from a private marketplace carries the token that was used to browse it into the install
- [ ] A coding agent that signs in interactively offers a sign-in that opens the terminal where that sign-in runs
- [ ] A custom MCP server can be added by naming its command or URL, and appears as a connected instance afterwards
- [ ] Opening a capability address that names no real card returns to the catalog rather than showing an empty form
