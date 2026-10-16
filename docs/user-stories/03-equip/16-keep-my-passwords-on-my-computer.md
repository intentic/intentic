# Keep my passwords on my own computer

As someone whose agent works on my own computers as well as in the sandbox, I want my personal passwords (the VPN,
SSH and sudo, a router's admin page, the program that has no browser) to stay in a keyring on my computer, typed where
they belong and handed to the sandbox only for a use I allow, so that giving the agent hands on my machine does not mean
giving it my passwords, and none of them sit in a sandbox that runs other people's code all day.

The keyring is a program of its own beside intentic-machine (`intentic-machine keyring setup`), unlocked with Windows
Hello where the computer has it and with a passphrase I choose everywhere. Each entry says what it is (a password, or
text), which programs it may be typed into without asking (`FortiClient.exe`, `mstsc.exe`), which Android apps and
sites, and which sandboxes it is shared with, each on its own terms: **ask me each time**, **while I'm here** (unasked
while the keyring is unlocked, for as long as I unlocked it), or **keep a copy in the sandbox** (it then works with my
computer off, and is an ordinary sandbox secret from there on).

In the sandbox an entry I shared is a row on the Secrets view under "On your computers", and the agent spends it like
any other: `{{secret:VPN_FORTI}}` in a command, or `type_secret` aimed at a window on my computer, my phone, the
sandbox's desktop or a page in my own browser. The sandbox never stores the value. It signs a grant for that one use,
the keyring checks the grant against the key it fetched from the sandbox's own address when I shared the entry, asks me
when the entry's terms say to, and either types the value into the focused window itself, after checking which program
has the focus and whether the field is a password field, or hands it back sealed to that sandbox alone. My other
programs, the agent's own commands on my computer among them, reach the keyring's pipe but cannot sign a grant, and
everything else they could ask it for needs me at the computer.

`ssh`, `sudo` and `git` ask the keyring too, through intentic-askpass (`intentic-machine keyring askpass install`): the
prompt they show is matched to an entry, I confirm, and the answer goes to the program that asked and nowhere else.

An entry may instead name where its value is read: 1Password, Bitwarden or KeePassXC, read at each use. Two of my
computers' keyrings can be paired, at my yes on each with both fingerprints shown, and then keep one set of entries,
sealed between them and carried by a sandbox that cannot open what it carries. On Windows, hardened mode (one
administrator prompt) moves the vault under an account of its own, so no program I run can read it.

## Acceptance criteria

- [ ] `intentic-machine keyring setup` installs and starts the keyring and sets up its vault with a passphrase, plus Windows Hello where the computer has it; the vault's values never leave it unencrypted
- [ ] An entry can be added from the terminal or the desktop app without its value ever appearing on a command line, and adding, widening or removing one asks the person at the computer
- [ ] An entry is shared with a sandbox in one of three modes, and the sandbox's Secrets view lists it under "On your computers" with the computer, the mode and whether that computer answers, never with the value
- [ ] A `{{secret:NAME}}` naming a shared entry is resolved after the sandbox's own gates pass, by a release the keyring answers sealed to that sandbox alone; a value is never reused for a second use
- [ ] `ask me each time` asks the person at the computer for every use; `while I'm here` goes unasked while the keyring is unlocked and asks once it locks; a copy works with the computer off
- [ ] Typing into a window on the computer checks the focused program against the entry's list and, for a password, that the field is a password field; anything else asks, and focus that moves while the person answers stops the typing
- [ ] A grant is the sandbox's own (verified against keys fetched from its address), names one secret and one use, answers once and expires within two minutes
- [ ] ssh, sudo and git prompts are answered through intentic-askpass from the entry whose matcher fits, asking each time unless the entry says to remember an answer for some minutes
- [ ] Values released into the sandbox are masked in everything the agent reads and in the terminal output the filter keeps
- [ ] Two computers' keyrings can be paired with both fingerprints shown on each, and then keep one set of entries through a sandbox that carries only ciphertext
- [ ] On Windows, hardened mode moves the vault where no program of the user can read it, and the keyring still answers the same pipe
