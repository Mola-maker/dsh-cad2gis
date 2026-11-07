/**
 * dsh-cad2gis — Host module.
 *
 * Exposes CAD2GIS (DWG/DXF → GIS) as DeepSeek Harness agent tools.
 *
 * The conversion itself runs in the CAD2GIS Python CLI (`cad2gis`) on the
 * host machine; this module is a thin bridge that spawns the CLI, captures
 * its `--json` output, and reports missing prerequisites instead of
 * pretending to convert. DWG reading needs the portable LibreDWG runtime and
 * GIS output needs the vendored GDAL runtime (`cad2gis runtime install`).
 *
 * Runs inside the dsh Host process with the Host's authority. It only
 * spawns the `cad2gis` binary (or `$CAD2GIS_BIN`), only on paths the model
 * passes as tool arguments, and never at module import time.
 */
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'cad2gis';
export const inject = ['tools'];

const CAD2GIS_BIN = process.env.CAD2GIS_BIN ?? 'cad2gis';
const CONVERT_TIMEOUT_MS = 20 * 60 * 1000;
const INSPECT_TIMEOUT_MS = 5 * 60 * 1000;
const DOCTOR_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const CAD_EXTENSIONS = new Set(['.dwg', '.dxf']);

const INSTALL_HINT =
  'cad2gis CLI not found on PATH. Install it with: ' +
  'uv tool install --python 3.12 --force "cad2gis[agent] @ https://github.com/Mola-maker/CAD2GIS/archive/refs/heads/main.zip" ' +
  'and then run `cad2gis runtime install` for DWG reading (LibreDWG) and GIS output (GDAL). ' +
  'Set $CAD2GIS_BIN to point at a specific cad2gis binary.';

class Cad2gisError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Cad2gisError';
  }
}

function tail(text, limit = 2000) {
  if (text.length <= limit) return text;
  return `…${text.slice(text.length - limit)}`;
}

function truncate(text, limit = 4000) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} more characters)`;
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Cad2gisError(`${label} must be an absolute path, got: ${JSON.stringify(value)}`);
  }
  return value;
}

async function requireCadSource(source) {
  requireAbsolutePath(source, 'source');
  if (!CAD_EXTENSIONS.has(extname(source).toLowerCase())) {
    throw new Cad2gisError(`source must be a .dwg or .dxf file, got: ${source}`);
  }
  if (!(await pathExists(source))) {
    throw new Cad2gisError(`source file does not exist: ${source}`);
  }
  return source;
}

async function requireNewDir(path, label) {
  requireAbsolutePath(path, label);
  if (await pathExists(path)) {
    throw new Cad2gisError(`${label} must be a new directory that does not exist yet, got: ${path}`);
  }
  return path;
}

/**
 * Run the cad2gis CLI and return its parsed `--json` output.
 *
 * Throws Cad2gisError for infrastructure failures (binary missing, spawn
 * failure, timeout, unparseable output). A non-zero CLI exit is NOT thrown:
 * it is returned as `{ ok: false, error }` so the model sees what failed.
 * An aborted call (exec.signal) propagates as an abort, not as a value.
 */
async function runCad2gis(argv, { signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
      execFile(
        CAD2GIS_BIN,
        argv,
        { signal: controller.signal, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && error.code === 'ENOENT') {
            reject(new Cad2gisError(INSTALL_HINT));
            return;
          }
          if (error && (controller.signal.aborted || error.code === 'ABORT_ERR')) {
            reject(timedOut ? new Cad2gisError(`cad2gis ${argv[0]} timed out after ${timeoutMs}ms`) : error);
            return;
          }
          if (error && typeof error.code === 'number') {
            // Non-zero exit: still resolve with captured output; the caller
            // turns it into an ok:false envelope.
            resolve({ stdout, stderr, exitCode: error.code });
            return;
          }
          if (error) {
            reject(new Cad2gisError(`failed to run cad2gis ${argv[0]}: ${error.message}`));
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        },
      );
    });
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function parseCliJson(stdout, command) {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new Cad2gisError(`cad2gis ${command} produced no output`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Cad2gisError(
      `cad2gis ${command} produced output that is not valid JSON: ${truncate(text, 500)}`,
    );
  }
}

/** Call the CLI for one tool invocation and shape the canonical envelope. */
async function callCli(command, argv, { signal, timeoutMs }) {
  const { stdout, stderr, exitCode } = await runCad2gis(argv, { signal, timeoutMs });
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    return {
      ok: false,
      command,
      exitCode,
      error: detail ? tail(detail) : `cad2gis ${command} failed with exit code ${exitCode}`,
    };
  }
  return { ok: true, command, exitCode, result: parseCliJson(stdout, command) };
}

const ENVELOPE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        command: { type: 'string', required: true },
        exitCode: { type: 'integer', required: true },
        result: { type: 'json', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        command: { type: 'string', required: true },
        exitCode: { type: 'integer', required: true },
        error: { type: 'string', required: true },
      },
    },
  ],
};

function renderEnvelope(_args, value) {
  const lines = [`cad2gis ${value.command}: ${value.ok ? 'ok' : 'failed'} (exit ${value.exitCode})`];
  if (!value.ok) {
    lines.push(`Error: ${value.error}`);
  } else {
    lines.push(truncate(JSON.stringify(value.result, null, 2)));
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

function terminalCall(commandLine, description) {
  return {
    card: 'terminal',
    title: commandLine,
    description,
  };
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'cad2gis_doctor',
      description:
        'Check whether the CAD2GIS runtime is ready on this host: Python CLI, ' +
        'LibreDWG reader for DWG, and the vendored GDAL runtime for GIS output. ' +
        'Call this first when a conversion fails or before the first conversion.',
      parameters: {
        profile: {
          type: 'string',
          enum: ['conversion', 'agent', 'review', 'full'],
          description: 'Which readiness profile to validate (default: conversion).',
        },
      },
      output: {
        schema: ENVELOPE_SCHEMA,
        render: renderEnvelope,
      },
      presentCall: (args) => terminalCall(
        `cad2gis doctor --profile ${args.profile ?? 'conversion'} --json`,
        'Check CAD2GIS runtime readiness.',
      ),
      presentResult: (_args, { isError }) => ({
        card: 'generic',
        title: isError ? 'cad2gis doctor — failed' : 'cad2gis doctor — done',
      }),
      async execute(args, exec) {
        return callCli('doctor', ['doctor', '--profile', args.profile ?? 'conversion', '--json'], {
          signal: exec.signal,
          timeoutMs: DOCTOR_TIMEOUT_MS,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'cad2gis_inspect',
      description:
        'Inventory a DWG/DXF source without converting it: entities, units, ' +
        'coordinate system, and a proposed unreviewed project profile. ' +
        'Requires the cad2gis CLI on the host PATH.',
      parameters: {
        source: {
          type: 'string',
          required: true,
          description: 'Absolute path to the .dwg or .dxf source file.',
        },
        project_dir: {
          type: 'string',
          description: 'Absolute path to a project directory to write the proposed profile into.',
        },
      },
      output: {
        schema: ENVELOPE_SCHEMA,
        render: renderEnvelope,
      },
      presentCall: (args) => terminalCall(
        `cad2gis inspect ${args.source} --json`,
        'Inventory a CAD source.',
      ),
      presentResult: (_args, { isError }) => ({
        card: 'generic',
        title: isError ? 'cad2gis inspect — failed' : 'cad2gis inspect — done',
      }),
      async execute(args, exec) {
        const source = await requireCadSource(args.source);
        const argv = ['inspect', source, '--json'];
        if (args.project_dir !== undefined) {
          argv.push('--project', requireAbsolutePath(args.project_dir, 'project_dir'));
        }
        return callCli('inspect', argv, { signal: exec.signal, timeoutMs: INSPECT_TIMEOUT_MS });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'cad2gis_convert',
      description:
        'Convert a DWG/DXF source to GIS (GeoPackage plus review evidence) in one ' +
        'run: bootstrap, onboard, validate, and convert. Needs the cad2gis CLI on ' +
        'the host PATH and the portable runtime for DWG/GIS output ' +
        '(`cad2gis runtime install`). Requires an onboarding provider API key in ' +
        'the host environment (DEEPSEEK_API_KEY by default; NEW_API_* for new-api): ' +
        'the onboarding proposal always calls the provider, even with llm=off — ' +
        'llm only switches the compile-step supervisor. DWG reading and GIS writing ' +
        'fail clearly when the runtime is missing — check with cad2gis_doctor first. ' +
        'project_dir and run_dir must be absolute paths; run_dir must not exist yet.',
      parameters: {
        source: {
          type: 'string',
          required: true,
          description: 'Absolute path to the .dwg or .dxf source file.',
        },
        project_dir: {
          type: 'string',
          required: true,
          description: 'Absolute path to the source-bound project pack directory.',
        },
        run_dir: {
          type: 'string',
          required: true,
          description: 'Absolute path to a new immutable run directory (must not exist yet).',
        },
        layout: {
          type: 'string',
          description: 'Named layout tab to convert (e.g. "Model"). Default: Model.',
        },
        llm: {
          type: 'string',
          enum: ['off', 'observe', 'assist'],
          description:
            'LLM supervisor mode for the compile step (default: off). An onboarding provider key is required regardless (DEEPSEEK_API_KEY by default); llm only switches the compile-step supervisor.',
        },
      },
      output: {
        schema: ENVELOPE_SCHEMA,
        render: renderEnvelope,
      },
      presentCall: (args) => terminalCall(
        `cad2gis auto-convert ${args.source} --project ${args.project_dir} --run-dir ${args.run_dir} --json`,
        'Convert CAD to GIS.',
      ),
      presentResult: (_args, { isError }) => ({
        card: 'generic',
        title: isError ? 'cad2gis convert — failed' : 'cad2gis convert — done',
      }),
      async execute(args, exec) {
        const source = await requireCadSource(args.source);
        const projectDir = requireAbsolutePath(args.project_dir, 'project_dir');
        const runDir = await requireNewDir(args.run_dir, 'run_dir');
        const argv = [
          'auto-convert',
          source,
          '--project',
          projectDir,
          '--run-dir',
          runDir,
          '--llm',
          args.llm ?? 'off',
          '--json',
        ];
        if (args.layout !== undefined) argv.push('--layout', args.layout);
        return callCli('convert', argv, { signal: exec.signal, timeoutMs: CONVERT_TIMEOUT_MS });
      },
    }),
  );
}
