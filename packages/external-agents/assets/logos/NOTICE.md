# External agent logos

Default avatars of external-agent Bots. Each file is 192×192 PNG, rendered from the vendor's
own mark without redrawing or recolouring; Pi Bot uses them only to identify the integrated
product (the user's own installed agent). Trademarks belong to their owners. Users can replace the
avatar like any Bot's.

| File | Source | Render |
|---|---|---|
| `codex.png` | The classic white Codex icon: the OpenAI knot from Simple Icons `openai.svg` (https://simpleicons.org/?q=openai), black on white (owner choice 2026-11-14) | black on white |
| `claude.png` | Claude spark glyph, Simple Icons `claude.svg` (https://simpleicons.org/?q=claude) | `#d97757` on `#faf9f5` |
| `cursor.png` | Cursor's own app icon (dark tile, grey cube), from the installed app's `Cursor.app/Contents/Resources/Cursor.icns` (brand guide https://cursor.com/brand) | downscaled to 192, as shipped |
| `opencode.png` | OpenCode dark avatar, https://opencode.ai/brand/files/opencode-avatar-dark-1024.png (brand guide https://opencode.ai/brand) | downscaled 1024 → 192 |
| `antigravity.png` | Antigravity's own mark as its site publishes it, https://antigravity.google/assets/image/antigravity-logo.png | downscaled 276 → 192, flattened onto white |

`packages/external-agents-contract/src/agents/logos.ts` embeds these files as data URLs; regenerate
it after replacing a file.
