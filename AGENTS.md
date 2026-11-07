# AGENTS.md

## DeepSeek Harness plugin development

Before changing plugin code, read https://dsh.pub/develop-plugin.md completely. Follow the pinned
runtime contract and verification boundaries there; this repository's own security, testing, and
release rules remain authoritative.

## Local rules

- The conversion runs in the CAD2GIS Python CLI on the host. This package
  must never claim to convert anything by itself; it spawns `cad2gis`,
  captures `--json` output, and reports failures honestly.
- Do not claim runtime, install, or compatibility checks that were not
  executed. If `dsh plugin add` / `--dump-config` could not run here, say so.
- `lib/index.js` is the committed runtime artifact. There is no build step;
  edit it directly and run `npm test` (structural checks + stub-CLI smoke
  test) and `npm run check` (`node --check`).
- Never commit credentials, tokens, or machine-specific absolute paths.
- Do not publish to npm or submit to any marketplace from this checkout
  without the maintainer's explicit go-ahead.
