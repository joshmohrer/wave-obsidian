# Contributing

Thanks for helping make Wave AI for Obsidian better.

- **Bugs and ideas:** open an issue at https://github.com/joshmohrer/wave-obsidian/issues. For sync problems, run **Wave AI: Copy diagnostics for Wave support** in Obsidian and paste the result; it contains no token and no note contents.
- **Pull requests:** keep them small and focused. Run `npm test` and `npm run build` before opening one; both must pass.
- **Layout:** `src/sync.ts` is the Obsidian-free sync engine (unit-tested in `test/`), `src/markdown.ts` builds notes, `src/api.ts` talks to Wave's API, `src/main.ts` is the Obsidian glue.
- **Releases** are cut by the maintainers: `npm version x.y.z`, then a bare `x.y.z` tag triggers the GitHub release workflow.

By contributing you agree your work is released under the MIT license in `LICENSE`.
