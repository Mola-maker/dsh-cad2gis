# dsh-cad2gis

Convert DWG/DXF to GIS (GeoPackage) with review evidence, as DeepSeek
Harness agent tools. A thin Host bridge over the CAD2GIS Python CLI — it
does not reimplement conversion.

## Tools

| Tool | What it does | Maps to |
| --- | --- | --- |
| `cad2gis_doctor` | Check runtime readiness: CLI, LibreDWG reader, GDAL runtime | `cad2gis doctor --json` |
| `cad2gis_inspect` | Inventory a DWG/DXF source without converting it | `cad2gis inspect --json` |
| `cad2gis_convert` | Bootstrap, onboard, validate, and convert in one run | `cad2gis auto-convert --json` |

Every tool returns a canonical envelope: `{ ok, command, exitCode, result }`
on success, `{ ok: false, command, exitCode, error }` when the CLI itself
reports failure. A missing `cad2gis` binary, a timeout, or unparseable CLI
output throws with install instructions instead of a value.

## Prerequisites (on the host)

- DeepSeek Harness **0.2.x** (`engines.dsh >=0.2.0 <0.3.0`), Node.js 20+.
- The `cad2gis` CLI on `PATH` (Python 3.12):
  `uv tool install --python 3.12 --force "cad2gis[agent] @ https://github.com/Mola-maker/CAD2GIS/archive/refs/heads/main.zip"`
- For DWG reading and GIS output, the portable runtime:
  `cad2gis runtime install` (LibreDWG CLI + vendored GDAL wheel).
  DXF inspection works without it; DWG conversion and GeoPackage output do
  not. Run `cad2gis_doctor` to check before the first conversion.
- Set `$CAD2GIS_BIN` to point at a specific `cad2gis` binary if it is not
  on `PATH`.
- `cad2gis_convert` needs an onboarding provider API key in the host
  environment (`DEEPSEEK_API_KEY` by default; `NEW_API_*` for new-api):
  the onboarding proposal always calls the provider, even with
  `--llm off` — the flag only switches the compile-step supervisor.
  `doctor` and `inspect` need no key.

## Install

The standalone repository is not published yet; install from a local
checkout for now:

```sh
dsh plugin --profile web add ./
dsh --profile web --dump-config   # should show a "# == dsh-cad2gis" layer
```

Once published, the same command works from GitHub:

```sh
dsh plugin --profile web add github:<owner>/dsh-cad2gis#<commit>
```

## Configure

No configuration file. Optional environment variables read at Host start:

- `CAD2GIS_BIN` — path to the `cad2gis` binary (default: `cad2gis` on `PATH`).

## Verify

```sh
dsh --profile web --dump-config
```

Then ask the agent to run `cad2gis_doctor`, or call it directly. A healthy
host reports the CLI, the LibreDWG reader, and the GDAL runtime as ready.

## Disable / uninstall

```sh
dsh plugin --profile web remove dsh-cad2gis
```

Removing the bundle unregisters the three tools; it does not touch the
`cad2gis` CLI, the portable runtime, or any conversion output.

## Limitations

- Conversion runs on the host through the `cad2gis` CLI. It is not
  sandboxed by the agent tool sandbox: the plugin spawns a host process
  with the Host's authority, only on paths passed as tool arguments.
- `cad2gis_convert` runs in the foreground with a 20-minute timeout.
  Very large drawings may need a background-job upgrade (not implemented).
- No Web UI client: this is a Host-only bundle.

## License

Apache-2.0. See `LICENSE`. CAD2GIS itself lives at
https://github.com/Mola-maker/CAD2GIS.
