/**
 * Smoke tests for dsh-cad2gis.
 *
 * Two layers, no dsh Host required:
 *  1. Structural checks mirroring the 1024Store/dsh.pub static validation:
 *     package.json, dsh.bundle.patch target, patch YAML shape, committed
 *     runtime artifacts, README + LICENSE, no `workspace:` ranges.
 *  2. Tool-logic checks against a stub `cad2gis` binary on PATH: the real
 *     defineTool definitions are registered into a fake ctx and executed.
 *
 * Run: `npm test` (needs devDependencies installed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(PLUGIN_ROOT, 'package.json');
const PATCH_PATH = join(PLUGIN_ROOT, 'cordis.patch.yml');
const LIB_PATH = join(PLUGIN_ROOT, 'lib', 'index.js');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const STUB_SCRIPT = `#!/usr/bin/env node
// Stub cad2gis: echoes canned JSON per subcommand. STUB_MODE=fail exits 3,
// STUB_MODE=badjson prints non-JSON. Never touches the real toolchain.
const argv = process.argv.slice(2);
const mode = process.env.STUB_MODE ?? 'ok';
if (mode === 'fail') {
  console.error('stub failure: simulated CLI error');
  process.exit(3);
}
if (mode === 'badjson') {
  console.log('this is not json');
  process.exit(0);
}
const [cmd, ...rest] = argv;
const payload = { stub: true, command: cmd, argv: rest };
if (cmd === 'doctor') payload.readiness = { cli: true, libredwg: true, gdal: true };
if (cmd === 'inspect') payload.source = rest[0];
if (cmd === 'auto-convert') payload.runDir = rest[rest.indexOf('--run-dir') + 1];
console.log(JSON.stringify(payload));
`;

async function makeStubBin() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cad2gis-stub-'));
  const bin = join(dir, 'cad2gis');
  await writeFile(bin, STUB_SCRIPT, { mode: 0o755 });
  await chmod(bin, 0o755);
  return { dir, bin };
}

async function loadPlugin(cad2gisBin, cacheBuster) {
  process.env.CAD2GIS_BIN = cad2gisBin;
  const url = `${pathToFileURL(LIB_PATH).href}?t=${cacheBuster}`;
  const mod = await import(url);
  const defs = [];
  const ctx = { tools: { register: (def) => defs.push(def) } };
  mod.apply(ctx);
  return { mod, defs };
}

function tool(defs, name) {
  const def = defs.find((d) => d.name === name);
  assert.ok(def, `tool ${name} should be registered`);
  return def;
}

const signal = () => new AbortController().signal;

test('structure: package, patch, artifacts, license', async () => {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'));
  assert.equal(pkg.name, 'dsh-cad2gis');
  assert.ok(pkg.version);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(await exists(join(PLUGIN_ROOT, 'cordis.patch.yml')));
  assert.ok(await exists(join(PLUGIN_ROOT, 'lib', 'index.js')));
  assert.ok(await exists(join(PLUGIN_ROOT, 'README.md')));
  assert.ok(await exists(join(PLUGIN_ROOT, 'LICENSE')));
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      assert.ok(!String(range).startsWith('workspace:'), `${name} must not use a workspace: range`);
    }
  }
  for (const file of pkg.files ?? []) {
    assert.ok(await exists(join(PLUGIN_ROOT, file)), `files[] entry missing: ${file}`);
  }
  const patch = parseYaml(await readFile(PATCH_PATH, 'utf8'));
  assert.ok(Array.isArray(patch), 'cordis.patch.yml must be a top-level YAML array');
  const rows = patch.flatMap((entry) => entry.insert ?? []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, pkg.name);
  assert.ok(typeof rows[0].id === 'string' && rows[0].id.length > 0);
});

test('tools register: three tools with schemas', async () => {
  const { dir, bin } = await makeStubBin();
  try {
    const { defs } = await loadPlugin(bin, 'register');
    assert.deepEqual(
      defs.map((d) => d.name).sort(),
      ['cad2gis_convert', 'cad2gis_doctor', 'cad2gis_inspect'],
    );
    for (const def of defs) {
      assert.ok(def.parameters && typeof def.parameters === 'object');
      assert.ok(def.output && def.output.schema && typeof def.output.render === 'function');
      assert.equal(typeof def.presentCall, 'function');
      assert.equal(typeof def.presentResult, 'function');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('doctor/inspect/convert succeed against the stub CLI', async () => {
  const { dir, bin } = await makeStubBin();
  const work = await mkdtemp(join(tmpdir(), 'dsh-cad2gis-work-'));
  try {
    const { defs } = await loadPlugin(bin, 'success');
    const doctor = await tool(defs, 'cad2gis_doctor').execute({}, { signal: signal() });
    assert.equal(doctor.ok, true);
    assert.equal(doctor.command, 'doctor');
    assert.equal(doctor.result.readiness.gdal, true);

    const dxf = join(work, 'drawing.dxf');
    await writeFile(dxf, '');
    const inspected = await tool(defs, 'cad2gis_inspect').execute(
      { source: dxf },
      { signal: signal() },
    );
    assert.equal(inspected.ok, true);
    assert.equal(inspected.result.source, dxf);

    const runDir = join(work, 'run-1');
    const converted = await tool(defs, 'cad2gis_convert').execute(
      { source: dxf, project_dir: join(work, 'proj'), run_dir: runDir },
      { signal: signal() },
    );
    assert.equal(converted.ok, true);
    assert.equal(converted.result.runDir, runDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('CLI failure becomes ok:false, bad JSON throws', async () => {
  const { dir, bin } = await makeStubBin();
  const work = await mkdtemp(join(tmpdir(), 'dsh-cad2gis-work-'));
  try {
    const dxf = join(work, 'drawing.dxf');
    await writeFile(dxf, '');

    process.env.STUB_MODE = 'fail';
    const { defs } = await loadPlugin(bin, 'fail');
    const failed = await tool(defs, 'cad2gis_convert').execute(
      { source: dxf, project_dir: join(work, 'proj'), run_dir: join(work, 'run-1') },
      { signal: signal() },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.match(failed.error, /simulated CLI error/);

    process.env.STUB_MODE = 'badjson';
    const { defs: badDefs } = await loadPlugin(bin, 'badjson');
    await assert.rejects(
      tool(badDefs, 'cad2gis_doctor').execute({}, { signal: signal() }),
      /not valid JSON/,
    );
  } finally {
    delete process.env.STUB_MODE;
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('validation: bad extension, existing run dir, missing binary', async () => {
  const { dir, bin } = await makeStubBin();
  const work = await mkdtemp(join(tmpdir(), 'dsh-cad2gis-work-'));
  try {
    const { defs } = await loadPlugin(bin, 'validate');
    const txt = join(work, 'notes.txt');
    await writeFile(txt, '');
    await assert.rejects(
      tool(defs, 'cad2gis_inspect').execute({ source: txt }, { signal: signal() }),
      /\.dwg or \.dxf/,
    );
    const dxf = join(work, 'drawing.dxf');
    await writeFile(dxf, '');
    const existing = join(work, 'run-1');
    await writeFile(join(work, 'placeholder'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(existing);
    await assert.rejects(
      tool(defs, 'cad2gis_convert').execute(
        { source: dxf, project_dir: join(work, 'proj'), run_dir: existing },
        { signal: signal() },
      ),
      /must be a new directory/,
    );

    const { defs: missingDefs } = await loadPlugin(join(work, 'no-such-cad2gis'), 'missing');
    await assert.rejects(
      tool(missingDefs, 'cad2gis_doctor').execute({}, { signal: signal() }),
      /Install it with/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
