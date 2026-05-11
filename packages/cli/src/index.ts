import {
  addGitHubPlugin,
  delegateToPlugin,
  diskBytes,
  ensureGitHubPlugin,
  formatInfo,
  infoForPlugin,
  listManagedPlugins,
  loadLocalPlugin,
  type RuntimeContext,
  removeManagedPlugin,
  updatePlugins,
} from './cache.js'
import { ClifyError, errorMessage, isClifyError } from './errors.js'
import { initPlugin } from './init.js'
import { getXdgPaths, type RuntimeEnv } from './paths.js'
import { looksLikeSourceSpec, parseSourceSpec } from './source.js'

export interface RunCliOptions {
  readonly cwd?: string
  readonly env?: RuntimeEnv
  readonly stdout?: (chunk: string) => void
  readonly stderr?: (chunk: string) => void
  readonly now?: () => number
}

interface GlobalFlags {
  readonly format: 'text' | 'json'
  readonly silent: boolean
  readonly noFetch: boolean
  readonly reinstall: boolean
  readonly fullOutput: boolean
  readonly filterOutput: string | null
  readonly help: boolean
  readonly version: boolean
  readonly schema: boolean
  readonly llms: boolean
}

interface ParsedArgs {
  readonly globals: GlobalFlags
  readonly rest: readonly string[]
}

const version = '0.1.0'
const reservedCommands = new Set([
  'add',
  'remove',
  'rm',
  'list',
  'ls',
  'update',
  'init',
  'info',
  'help',
])

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const started = Date.now()
  const parsed = parseLeadingGlobals(argv)
  const context = createContext(options, parsed.globals.silent)
  try {
    return await runParsedCli(parsed, context)
  } catch (error) {
    const clifyError = isClifyError(error) ? error : wrapUnexpectedError(error)
    renderError(clifyError, parsed.globals, context, argv, started)
    return 1
  }
}

async function runParsedCli(parsed: ParsedArgs, context: RuntimeContext): Promise<number> {
  const globals = parsed.globals
  const [token, ...tail] = parsed.rest
  if (globals.version) {
    context.stdout(`${version}\n`)
    return 0
  }
  if (globals.schema) {
    context.stdout(`${JSON.stringify(schemaObject(), null, 2)}\n`)
    return 0
  }
  if (globals.llms) {
    context.stdout(llmsText())
    return 0
  }
  if (globals.help || token === undefined || token === 'help') {
    context.stdout(helpText())
    return 0
  }

  if (reservedCommands.has(token)) return runCommand(token, tail, globals, context)

  if (!looksLikeSourceSpec(token)) {
    throw new ClifyError('UNKNOWN_COMMAND', `unknown command: ${token}. Try clify --help.`)
  }

  const source = parseSourceSpec(token, context.cwd, context.env)
  if (source.type === 'local') {
    if (globals.reinstall || globals.noFetch) {
      throw new ClifyError('LOCAL_NOT_MANAGED', 'local paths are direct-run only')
    }
    const cli = await loadLocalPlugin(source.path, context)
    return delegateToPlugin(cli, tail)
  }
  const loaded = await ensureGitHubPlugin(source, context, {
    noFetch: globals.noFetch,
    reinstall: globals.reinstall,
  })
  return delegateToPlugin(loaded.cli, tail)
}

async function runCommand(
  command: string,
  args: readonly string[],
  inherited: GlobalFlags,
  context: RuntimeContext,
): Promise<number> {
  const parsed = parseCommandFlags(args, inherited)
  const globals = parsed.globals
  const positionals = parsed.rest

  if (command === 'add') {
    const sourceArg = requiredArg(positionals[0], 'add requires <source-spec>')
    const source = parseSourceSpec(sourceArg, context.cwd, context.env)
    if (source.type === 'local')
      throw new ClifyError('LOCAL_NOT_MANAGED', 'local paths are direct-run only')
    const entry = await addGitHubPlugin(
      source,
      { ...context, silent: globals.silent },
      globals.reinstall,
    )
    writeOutput(
      {
        installed: entry.id,
        sha: entry.sha,
        ref: entry.ref,
        refKind: entry.refKind,
        resolvedRef: entry.resolvedRef,
        source: entry.source,
      },
      globals,
      context,
      formatAdd,
    )
    return 0
  }

  if (command === 'remove' || command === 'rm') {
    const id = requiredArg(positionals[0], 'remove requires <install-id>')
    const removed = await removeManagedPlugin(id, { ...context, silent: globals.silent })
    writeOutput({ ok: true, removed }, globals, context, (value) => formatKeyValues(value))
    return 0
  }

  if (command === 'list' || command === 'ls') {
    const rows = await listManagedPlugins(
      { ...context, silent: globals.silent },
      globals.fullOutput,
    )
    writeOutput(rows, globals, context, formatList)
    return 0
  }

  if (command === 'update') {
    const installIds: string[] = []
    for (const id of positionals) {
      const source = parseSourceSpec(id, context.cwd, context.env)
      if (source.type === 'local')
        throw new ClifyError('LOCAL_NOT_MANAGED', 'local paths are direct-run only')
      installIds.push(source.installId)
    }
    const results = await updatePlugins(installIds, { ...context, silent: globals.silent })
    writeOutput(results, globals, context, formatUpdate)
    return 0
  }

  if (command === 'init') {
    const target = positionals[0]
    const created = await initPlugin(target, { cwd: context.cwd, force: parsed.force })
    writeOutput({ created }, globals, context, formatCreated)
    return 0
  }

  if (command === 'info') {
    const sourceArg = requiredArg(positionals[0], 'info requires <source-spec>')
    const source = parseSourceSpec(sourceArg, context.cwd, context.env)
    if (source.type === 'local')
      throw new ClifyError('LOCAL_NOT_MANAGED', 'local paths are direct-run only')
    const loaded = await infoForPlugin(source, { ...context, silent: globals.silent })
    const paths = getXdgPaths(context.env)
    const bytes = await diskBytes(`${paths.cacheRoot}/${loaded.entry.cacheDir}`)
    context.stdout(`${formatInfo(loaded.entry, bytes)}\n`)
    return delegateToPlugin(loaded.cli, ['--llms'])
  }

  /* v8 ignore next */
  throw new ClifyError('UNKNOWN_COMMAND', `unknown command: ${command}`)
}

function parseLeadingGlobals(argv: readonly string[]): ParsedArgs {
  return parseFlagsUntilCommand(argv, defaultGlobals())
}

function parseCommandFlags(
  argv: readonly string[],
  inherited: GlobalFlags,
): ParsedArgs & { readonly force: boolean } {
  let globals = inherited
  let force = false
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const [arg = ''] = argv.slice(index, index + 1)
    if (arg === '--force') {
      force = true
      continue
    }
    const parsed = parseOneFlag(arg, argv[index + 1], globals)
    if (parsed.consumed > 0) {
      globals = parsed.globals
      index += parsed.consumed - 1
      continue
    }
    rest.push(arg)
  }
  return { globals, rest, force }
}

function parseFlagsUntilCommand(argv: readonly string[], initial: GlobalFlags): ParsedArgs {
  let globals = initial
  let index = 0
  while (index < argv.length) {
    const [arg = ''] = argv.slice(index, index + 1)
    if (!arg.startsWith('-')) break
    const parsed = parseOneFlag(arg, argv[index + 1], globals)
    if (parsed.consumed === 0) break
    globals = parsed.globals
    index += parsed.consumed
  }
  return { globals, rest: argv.slice(index) }
}

function parseOneFlag(
  arg: string,
  next: string | undefined,
  globals: GlobalFlags,
): { readonly globals: GlobalFlags; readonly consumed: number } {
  if (arg === '--silent') return { globals: { ...globals, silent: true }, consumed: 1 }
  if (arg === '--no-fetch') return { globals: { ...globals, noFetch: true }, consumed: 1 }
  if (arg === '--reinstall') return { globals: { ...globals, reinstall: true }, consumed: 1 }
  if (arg === '--json') return { globals: { ...globals, format: 'json' }, consumed: 1 }
  if (arg === '--full-output') return { globals: { ...globals, fullOutput: true }, consumed: 1 }
  if (arg === '--help' || arg === '-h') return { globals: { ...globals, help: true }, consumed: 1 }
  if (arg === '--version' || arg === '-v')
    return { globals: { ...globals, version: true }, consumed: 1 }
  if (arg === '--schema') return { globals: { ...globals, schema: true }, consumed: 1 }
  if (arg === '--llms') return { globals: { ...globals, llms: true }, consumed: 1 }
  if (arg === '--format' && next !== undefined) {
    return { globals: { ...globals, format: next === 'json' ? 'json' : 'text' }, consumed: 2 }
  }
  if (arg === '--filter-output' && next !== undefined) {
    return { globals: { ...globals, filterOutput: next }, consumed: 2 }
  }
  if ((arg === '--token-limit' || arg === '--token-offset') && next !== undefined) {
    return { globals, consumed: 2 }
  }
  if (arg === '--token-count') return { globals, consumed: 1 }
  return { globals, consumed: 0 }
}

function defaultGlobals(): GlobalFlags {
  return {
    format: 'text',
    silent: false,
    noFetch: false,
    reinstall: false,
    fullOutput: false,
    filterOutput: null,
    help: false,
    version: false,
    schema: false,
    llms: false,
  }
}

function createContext(options: RunCliOptions, silent: boolean): RuntimeContext {
  return {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdout: options.stdout ?? ((chunk) => process.stdout.write(chunk)),
    stderr: options.stderr ?? ((chunk) => process.stderr.write(chunk)),
    now: options.now ?? (() => Date.now()),
    silent,
  }
}

function requiredArg(value: string | undefined, message: string): string {
  if (value === undefined) throw new ClifyError('INVALID_SOURCE_SPEC', message)
  return value
}

function writeOutput(
  value: unknown,
  globals: GlobalFlags,
  context: RuntimeContext,
  textFormatter: (value: unknown) => string,
) {
  const filtered = applyFilter(value, globals.filterOutput)
  if (globals.format === 'json') {
    context.stdout(`${JSON.stringify(filtered, null, 2)}\n`)
    return
  }
  context.stdout(textFormatter(filtered))
}

function applyFilter(value: unknown, filter: string | null): unknown {
  if (filter === null || filter.trim() === '') return value
  const fields = filter
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  if (Array.isArray(value)) return value.map((item) => filterRecord(item, fields))
  return filterRecord(value, fields)
}

function filterRecord(value: unknown, fields: readonly string[]): unknown {
  if (!isOutputRecord(value)) return value
  const next: Record<string, unknown> = {}
  for (const field of fields) next[field] = value[field]
  return next
}

function isOutputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatAdd(value: unknown): string {
  if (!isOutputRecord(value)) return `${String(value)}\n`
  return [
    `installed: ${String(value.installed)}`,
    `sha: ${String(value.sha)}`,
    `ref: ${value.ref === null ? 'null' : String(value.ref)}`,
    `refKind: ${String(value.refKind)}`,
    `resolvedRef: ${String(value.resolvedRef)}`,
    `source: ${String(value.source)}`,
    '',
  ].join('\n')
}

function formatKeyValues(value: unknown): string {
  if (!isOutputRecord(value)) return `${String(value)}\n`
  return `${Object.entries(value)
    .map(([key, item]) => `${key}: ${String(item)}`)
    .join('\n')}\n`
}

function formatCreated(value: unknown): string {
  if (!isOutputRecord(value)) return `${String(value)}\n`
  return `created: ${String(value.created)}\n`
}

function formatList(value: unknown): string {
  if (!Array.isArray(value)) return `${String(value)}\n`
  if (value.length === 0) return 'plugins[0]:\n'
  const lines = ['id                  version  ref       description                 source']
  for (const row of value) {
    if (!isOutputRecord(row)) continue
    lines.push(
      `${pad(String(row.id), 19)} ${pad(String(row.version), 8)} ${pad(String(row.ref), 9)} ${pad(
        String(row.description),
        27,
      )} ${String(row.source)}`,
    )
  }
  return `${lines.join('\n')}\n`
}

function formatUpdate(results: unknown): string {
  if (!Array.isArray(results)) return formatKeyValues(results)
  const lines = [`updated[${results.length}]{id,from,to}:`]
  for (const result of results) {
    if (!isOutputRecord(result)) continue
    lines.push(
      `  ${String(result.id)},${shortSha(String(result.from))},${shortSha(String(result.to))}`,
    )
  }
  return `${lines.join('\n')}\n`
}

function wrapUnexpectedError(error: unknown): ClifyError {
  if (error instanceof Error) {
    return new ClifyError('INSTALL_FAILED', errorMessage(error), { cause: error })
  }
  return new ClifyError('INSTALL_FAILED', errorMessage(error))
}

function renderError(
  error: ClifyError,
  globals: GlobalFlags,
  context: RuntimeContext,
  argv: readonly string[],
  started: number,
) {
  if (globals.format === 'json') {
    context.stdout(
      `${JSON.stringify(
        {
          ok: false,
          error: { code: error.code, message: error.message },
          meta: {
            command: argv[0] ?? '',
            duration: `${((Date.now() - started) / 1000).toFixed(1)}s`,
          },
        },
        null,
        2,
      )}\n`,
    )
    return
  }
  context.stderr(`error (${error.code}): ${error.message}\n`)
}

function pad(value: string, size: number): string {
  return value.length >= size ? value : `${value}${' '.repeat(size - value.length)}`
}

function shortSha(value: string): string {
  return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value
}

function helpText(): string {
  return `Usage: clify <source-spec> [plugin args...]\n\nCommands:\n  add <source-spec>\n  remove <install-id>\n  list\n  update [install-id...]\n  init [dir]\n  info <source-spec>\n\nExample: bunx @clify/cli cli-fy/hacker-news api top --limit 10\n`
}

function llmsText(): string {
  return `clify: resolve, install, validate, and delegate GitHub-hosted API plugins.\ncommands: add, remove, list, update, init, info\n`
}

function schemaObject(): Record<string, unknown> {
  return {
    name: 'clify',
    version,
    commands: ['add', 'remove', 'list', 'update', 'init', 'info'],
  }
}
