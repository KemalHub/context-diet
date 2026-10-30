# Context Diet

A Claude Code mod with two parts.

**The gauge** stays above the prompt and shows your 5-hour and weekly limits, when they reset, how full the context window is, your startup tokens (what every request carries before your first message), and the tokens you've saved.

**The diet** watches which MCP servers and skill plugins you actually use. Once it finds startup tokens you load but never use, it offers `1: diet  2: later`. Press `1` or type `/diet`. Claude shows you a menu, disables what you pick (configs are kept), and slims large CLAUDE.md or memory files with a backup.

The gauge and the audit cost no tokens. How much the diet saves depends on your setup, from a few thousand tokens on a lean one to 10k to 30k on a heavy one.

Install it inside Claude Code:

```
/plugin install context-diet --marketplace KemalHub/context-diet
```

The full README, demo and install steps are at https://github.com/KemalHub/context-diet.
