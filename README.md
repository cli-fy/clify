# clify

`clify` turns a GitHub-hosted website API plugin into a CLI on demand.

```bash
bunx @clify/cli cli-fy/hacker-news api top --limit 10
```

clify resolves, installs, validates, caches, updates, and delegates to plugins.
Plugins are normal GitHub repositories that ship a bundled `dist/index.js` with a
default-exported incur `Cli`.

## Usage

```bash
clify <owner>/<repo> [plugin args...]
clify <owner>/<repo>@v0.1.0 [plugin args...]
clify https://github.com/<owner>/<repo> [plugin args...]
clify ./local-plugin [plugin args...]
```

Management commands:

```bash
clify add <source-spec>
clify remove <install-id>
clify list
clify update [install-id...]
clify init [dir]
clify info <source-spec>
```

## Trust Model

clify executes arbitrary JavaScript from arbitrary GitHub repositories during
validation, first run, update, info, and normal plugin execution. v1 has no
sandbox, no auth, no telemetry, and no central registry. Pin a tag or sha when
you need reproducibility.

## Development

This repo uses Bun workspaces as its package manager.

```bash
bun install
bun run test
bun run coverage
bun run typecheck
bun run lint
bun run knip
bun run build
```

Coverage is enforced at 95% or higher for statements, branches, functions, and
lines.
