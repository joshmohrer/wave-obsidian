# Wave AI for Obsidian

Every recording you make in [Wave AI](https://wave.co) shows up in your Obsidian vault as a Markdown file: the summary, action items and your notes, with the full transcript folded underneath. Your Wave folders become folders in your vault.

Works in Obsidian on Mac, Windows, Linux, iPhone, iPad and Android.

## What you get

Each recording becomes one note:

```markdown
---
title: "Q4 Roadmap Review"
date: 2026-10-13T10:30:12
duration_minutes: 34
type: "meeting"
platform: "google_meet"
folder: "Product"
tags:
  - "roadmap"
wave_id: "sess_…"
wave_url: "https://app.wave.co/sessions/sess_…"
---

## Q4 Roadmap Review
Three Q4 bets: offline mode, the sharing redesign, and the admin audit log…

## Action items
- [ ] Send legal the draft spec (JR) 📅 2026-10-20

> [!quote]- Transcript
> **Alex** · 0:59
> Q4 roadmap. We have room for three bets, not five…
```

- **Properties on top**: title, date, length, type, platform, language, Wave folder, tags, and a link back to the recording in Wave.
- **Action items** as a task list (with `📅` due dates the Tasks plugin understands).
- **Transcript** folded up under the note, speaker by speaker. Expand it, or turn it off.
- **Folders**: a recording filed under "Customer Calls" in Wave lands in `Wave/Customer Calls/`.

## Setting it up

1. In Obsidian, open **Settings → Community plugins**, search for **Wave AI** and install it. Enable it.
2. Open the plugin's settings and press **Connect Wave**. Your browser opens app.wave.co; sign in if you need to and press **Connect Obsidian**.
3. Obsidian comes back to the front and your notes start appearing in a folder called **Wave**.

Prefer not to use the browser flow? Create an API token at [app.wave.co → Settings → Developers](https://app.wave.co/settings/developers) and paste it into the plugin's settings instead.

## How syncing works

- It checks for new recordings every 5 minutes while Obsidian is open, whenever you come back to it, and whenever you press the Wave icon in the ribbon (or run **Sync now** from the command palette).
- **Your edits win.** Edit, move, rename or delete a synced note and Wave leaves it alone. A note you've changed is never written over, and a note you've deleted is never recreated.
- **One way only.** The plugin reads from Wave. Nothing in your vault is sent back.
- **Your history, your choice.** Sync everything, or only the last 30, 90 or 365 days. Big libraries sync in the background at Wave's API rate; the status bar shows progress.
- Changed the content options (transcript, action items, notes)? Press **Rebuild notes** to apply them to existing notes. Edited notes still stay as they are.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Folder | `Wave` | Vault folder that holds your Wave notes |
| Mirror Wave folders | on | Subfolders named after your Wave folders |
| File names | `2026-10-28 Title` | Or title only |
| Transcript | folded | Folded, expanded, or left out |
| Action items / Your notes | on | Include them in the note |
| Recordings to sync | everything | Or the last 30 / 90 / 365 days |
| Check every | 5 minutes | 1, 5, 15 or 60 minutes |
| When a recording is deleted in Wave | keep the note | Or move it to trash (only if you haven't edited it) |

## Privacy

The plugin talks only to `api.wave.co` using a read-only token scoped to your sessions, transcripts and folders. You can revoke it any time at app.wave.co → Settings → Developers. No analytics, no third parties.

## Development

```bash
npm install
npm test        # unit tests for the note builder and sync engine
npm run build   # type-check + bundle to main.js
npm run dev     # rebuild on change
```

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/wave-ai/` to try a local build.

The sync engine (`src/sync.ts`) is independent of Obsidian's API and runs against an in-memory vault in tests; `src/main.ts` wires it to the real vault.

## Support

[help.wave.co](https://help.wave.co) · support@wave.co

MIT licensed.
