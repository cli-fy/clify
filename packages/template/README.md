# my-plugin

A clify plugin scaffold.

## Run

Users can run the published plugin with:

```bash
bunx @clify/cli <owner>/<repo> api search "coffee"
```

During development, build or watch the bundled output and run the local checkout:

```bash
bun run dev
bunx @clify/cli ./ api search "test query"
```

## Authoring Notes

- Bundle every runtime dependency into `dist/index.js`.
- Commit `dist/` so clify can install without running package-manager commands.
- Use semver tags for stable refs, for example `v0.1.0`.
- See the canonical example at `https://github.com/cli-fy/hacker-news`.
- See clify docs for the trust model and plugin contract.
