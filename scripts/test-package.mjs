// End-to-end package test: packs the SDK, installs the tarball into throwaway
// projects, and exercises it the way users do.
//
//   node scripts/test-package.mjs
//   OPENAI_VERSION=7 ANTHROPIC_VERSION=0.20.0 node scripts/test-package.mjs
//
// Checks:
//   - default and named imports under native ESM, require() under CommonJS,
//     and that both resolve to the same class (no second copy of the SDK)
//   - TypeScript with moduleResolution node16 (.mts and .cts) and bundler
//   - an Anthropic-only install, without the optional openai peer
//   - bundling with esbuild and webpack (the SDK must stay bundleable:
//     provider SDKs are loaded with literal require() calls for this reason)
//   - real provider SDK calls (streaming and not) against a local mock of
//     OpenAI, Anthropic and SignalVault, asserting what gets audited
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openaiVersion = process.env.OPENAI_VERSION || '4';
const anthropicVersion = process.env.ANTHROPIC_VERSION || 'latest';
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
const work = mkdtempSync(join(tmpdir(), 'sv-package-'));
const npm = 'npm'; // POSIX only (CI runs on Linux)

function run(cmd, args, cwd, env = {}) {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } });
}

function project(name, deps, type = 'module') {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, type }));
  run(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', ...deps], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Mock OpenAI / Anthropic / SignalVault
// ---------------------------------------------------------------------------

const events = [];
const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) res.write(frame);
  res.end();
};

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.url === '/v1/events') {
      events.push(body);
      return json(200, body.type === 'ai.request' ? { decision: 'allow', violations: [], redactions: [] } : {});
    }
    if (req.url === '/_events') return json(200, events.splice(0));

    if (req.url === '/openai/v1/chat/completions') {
      if (!body.stream) {
        return json(200, {
          id: 'c1', object: 'chat.completion', created: 0, model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      }
      const chunk = (delta, extra = {}) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
      const frames = [chunk({ role: 'assistant', content: 'Hel' }), chunk({ content: 'lo' })];
      if (body.stream_options?.include_usage) {
        frames.push(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
      }
      frames.push('data: [DONE]\n\n');
      return sse(res, frames);
    }

    if (req.url === '/anthropic/v1/messages') {
      const message = { id: 'm1', type: 'message', role: 'assistant', model: body.model, stop_sequence: null };
      if (!body.stream) {
        return json(200, {
          ...message, stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Hi' }],
          usage: { input_tokens: 4, output_tokens: 1 },
        });
      }
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return sse(res, [
        ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
        ev('message_stop', {}),
      ]);
    }
    json(404, { error: `unexpected ${req.method} ${req.url}` });
  });
});

// ---------------------------------------------------------------------------
// Consumer code
// ---------------------------------------------------------------------------

const scenario = `
const base = process.env.MOCK_URL;
const { createRequire: svCreateRequire } = require_('node:module');
const requireHere = svCreateRequire(process.cwd() + '/');
// Old provider SDKs ignore OPENAI_BASE_URL / ANTHROPIC_BASE_URL, so after the
// SignalVault client has loaded the provider itself (the path under test), its
// provider client is swapped for one pointed at the mock.
function pointAtMock(client, field, pkg, path) {
  const mod = requireHere(pkg);
  const Provider = mod.default ?? mod;
  client[field] = new Provider({ apiKey: 'sk-fake', baseURL: base + path });
}
const messages = [{ role: 'user', content: 'hi' }];
const drained = async () => (await fetch(base + '/_events')).json();
function check(label, cond, detail) {
  if (!cond) { console.error('FAIL', label, JSON.stringify(detail)); process.exitCode = 1; }
  else console.log('ok  ', label);
}
async function collect(stream) { const out = []; for await (const c of stream) out.push(c); return out; }

async function openaiScenario(Client, tag) {
  const client = new Client({ apiKey: 'sk_test', openaiApiKey: 'sk-fake', baseUrl: base });
  pointAtMock(client, 'openai', 'openai', '/openai/v1');
  const res = await client.chat.completions.create({ model: 'gpt-x', messages });
  check(tag + ' openai response', res.choices[0].message.content === 'Hello', res);
  const chunks = await collect(await client.chat.completions.create({ model: 'gpt-x', messages, stream: true }));
  check(tag + ' openai stream: caller sees no usage-only chunk', chunks.length === 2 && chunks.every((c) => c.choices[0].delta), chunks);
  await client.flush();
  const responses = (await drained()).filter((e) => e.type === 'ai.response');
  check(tag + ' openai usage recorded (non-streaming, streaming)',
    responses.length === 2 && responses.every((r) => r.payload.usage.prompt_tokens === 3 && r.payload.usage.completion_tokens === 2),
    responses.map((r) => r.payload));
  check(tag + ' openai stream output recorded', responses[1]?.payload.output === 'Hello', responses[1]?.payload);
}

async function anthropicScenario(Client, tag) {
  const client = new Client({ apiKey: 'sk_test', anthropicApiKey: 'sk-ant-fake', baseUrl: base });
  pointAtMock(client, 'anthropic', '@anthropic-ai/sdk', '/anthropic');
  const res = await client.messages.create({ model: 'claude-x', max_tokens: 5, system: 'be brief', messages });
  check(tag + ' anthropic response', res.content[0].text === 'Hi', res);
  const events = await collect(await client.messages.create({ model: 'claude-x', max_tokens: 5, messages, stream: true }));
  check(tag + ' anthropic stream events', events.some((e) => e.type === 'message_stop'), events.map((e) => e.type));
  await client.flush();
  const recorded = await drained();
  const req = recorded.find((e) => e.type === 'ai.request');
  check(tag + ' anthropic system prompt scanned', req?.payload.messages[0]?.role === 'system', req?.payload);
  const responses = recorded.filter((e) => e.type === 'ai.response');
  check(tag + ' anthropic usage sent as prompt_tokens/completion_tokens',
    responses.length === 2 && responses.every((r) => r.payload.usage.prompt_tokens === 4 && r.payload.usage.completion_tokens === 1),
    responses.map((r) => r.payload.usage));
}
`;

const esmTest = (withOpenAI) => `
import SignalVaultClient, { SignalVaultClient as Named } from '@signalvaultio/node';
import * as ns from '@signalvaultio/node';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
${scenario}
const cjs = createRequire(import.meta.url)('@signalvaultio/node');
check('esm default import is the client class', typeof SignalVaultClient === 'function' && SignalVaultClient === Named);
check('esm and cjs share one copy of the SDK', SignalVaultClient === cjs.SignalVaultClient);
const esmKeys = Object.keys(ns).filter((k) => k !== 'default').sort();
const cjsKeys = Object.keys(cjs).filter((k) => k !== 'default' && k !== '__esModule').sort();
check('esm exports match cjs exports', JSON.stringify(esmKeys) === JSON.stringify(cjsKeys), { esmKeys, cjsKeys });
${withOpenAI ? "await openaiScenario(SignalVaultClient, 'esm');" : `
try { new SignalVaultClient({ apiKey: 'k', openaiApiKey: 'x' }); check('missing openai reported', false); }
catch (e) { check('missing openai reported clearly', /openai is not installed/.test(e.message), e.message); }`}
await anthropicScenario(Named, 'esm');
`;

const cjsTest = (withOpenAI) => `
const sv = require('@signalvaultio/node');
const require_ = require;
${scenario}
(async () => {
  check('cjs require default', typeof sv.default === 'function' && sv.default === sv.SignalVaultClient);
  ${withOpenAI ? "await openaiScenario(sv.SignalVaultClient, 'cjs');" : ''}
  await anthropicScenario(sv.default, 'cjs');
})();
`;

const tsConsumer = (importLine) => `
${importLine}
const client = new SignalVaultClient({ apiKey: 'k', openaiApiKey: 'x', failMode: 'closed' });
const named: SignalVaultClient = new Named({ apiKey: 'k', anthropicApiKey: 'y' });
void named;
export async function use(): Promise<void> {
  const res = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  const text: string | null = res.choices[0].message.content;
  // @ts-expect-error — fails to compile if the response type collapsed to any
  res.choices[0].message.not_a_real_field;
  const stream = await client.chat.completions.create({ model: 'm', messages: [], stream: true });
  for await (const chunk of stream) {
    const delta: string | null | undefined = chunk.choices[0]?.delta?.content;
    void delta;
  }
  try { await client.flush(); } catch (e) { if (e instanceof SignalVaultBlockedError) void e.violations; }
  void text;
}
`;

// ---------------------------------------------------------------------------

const bundleEntry = (withOpenAI) => `
import SignalVaultClient, { SignalVaultClient as Named } from '@signalvaultio/node';
const fail = (msg) => { console.error('FAIL', msg); process.exit(1); };
if (SignalVaultClient !== Named) fail('bundled default import is not the client class');
new SignalVaultClient({ apiKey: 'k', anthropicApiKey: 'y' });
${withOpenAI ? "new SignalVaultClient({ apiKey: 'k', openaiApiKey: 'x' });" : `
try { new SignalVaultClient({ apiKey: 'k', openaiApiKey: 'x' }); fail('missing openai not reported'); }
catch (e) { if (!/openai is not installed/.test(e.message)) fail(e.message); }`}
console.log('ok  ', process.env.BUNDLER, 'bundle');
`;

const webpackConfig = `module.exports = {
  mode: 'production', target: 'node', entry: './bundle-entry.mjs',
  output: { path: __dirname, filename: 'out-webpack.cjs' },
  stats: 'errors-only',
};`;

async function bundle(dir, withOpenAI, bundlers) {
  writeFileSync(join(dir, 'bundle-entry.mjs'), bundleEntry(withOpenAI));
  // esbuild's bin is a native executable on most platforms, so it is run directly.
  const esbuild = join(dir, 'node_modules/.bin/esbuild');
  const webpack = join(dir, 'node_modules/webpack-cli/bin/cli.js');
  if (bundlers.includes('esbuild')) {
    run(esbuild, ['bundle-entry.mjs', '--bundle', '--platform=node', '--format=cjs',
      '--outfile=out-esbuild.cjs', '--log-level=error'], dir);
    await runNode('out-esbuild.cjs', dir, { BUNDLER: 'esbuild (cjs)' });
    // esbuild's ESM output needs a require() for Node built-ins used by
    // CommonJS code; this banner is the documented way to provide one.
    run(esbuild, ['bundle-entry.mjs', '--bundle', '--platform=node', '--format=esm',
      '--outfile=out-esbuild.mjs', '--log-level=error',
      "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);"], dir);
    await runNode('out-esbuild.mjs', dir, { BUNDLER: 'esbuild (esm)' });
  }
  if (bundlers.includes('webpack')) {
    writeFileSync(join(dir, 'webpack.config.cjs'), webpackConfig);
    run(process.execPath, [webpack, '--config', 'webpack.config.cjs'], dir);
    await runNode('out-webpack.cjs', dir, { BUNDLER: 'webpack' });
  }
}

// Loaded into every consumer process: resolving any hostname other than
// localhost fails, so a misconfigured test can never reach a real provider
// (provider SDKs always connect by hostname). Connections to IP literals are
// not covered.
const networkGuard = `
const dns = require('node:dns');
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!LOCAL.has(host)) {
    const cb = rest[rest.length - 1];
    return process.nextTick(() => cb(new Error('network guard: blocked lookup of ' + host)));
  }
  return lookup.call(this, host, ...rest);
};
`;

async function runNode(file, cwd, env) {
  const guard = join(cwd, 'network-guard.cjs');
  writeFileSync(guard, networkGuard);
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--require', guard, file], { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${file} in ${cwd} exited ${code}`))));
  });
}

try {
  run(npm, ['run', 'build', '--silent'], root);
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', work], { cwd: root }).toString());
  const tarball = join(work, packed[0].filename);
  const typescript = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
  console.log(`\npackage: ${packed[0].filename}  openai@${openaiVersion}  @anthropic-ai/sdk@${anthropicVersion}\n`);

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mock = `http://127.0.0.1:${server.address().port}`;
  const env = {
    MOCK_URL: mock,
    OPENAI_BASE_URL: `${mock}/openai/v1`,
    ANTHROPIC_BASE_URL: `${mock}/anthropic`,
  };

  // Full install: both providers, runtime + TypeScript checks.
  const full = project('full', [
    tarball, `openai@${openaiVersion}`, `@anthropic-ai/sdk@${anthropicVersion}`, '@types/node@20', `typescript@${typescript}`,
    'esbuild@0', 'webpack@5', 'webpack-cli@6',
  ]);
  writeFileSync(join(full, 'esm.mjs'), esmTest(true));
  writeFileSync(join(full, 'cjs.cjs'), cjsTest(true));
  await runNode('esm.mjs', full, env);
  await runNode('cjs.cjs', full, env);

  const named = "import SignalVaultClient, { SignalVaultClient as Named, SignalVaultBlockedError } from '@signalvaultio/node';";
  writeFileSync(join(full, 'consumer.mts'), tsConsumer(named));
  writeFileSync(join(full, 'consumer.cts'), tsConsumer(named));
  writeFileSync(join(full, 'bundler.ts'), tsConsumer(named));
  const compilerBase = { strict: true, noEmit: true, types: ['node'], lib: ['ES2022', 'DOM'], target: 'ES2022' };
  writeFileSync(join(full, 'tsconfig.node16.json'), JSON.stringify({
    compilerOptions: { ...compilerBase, module: 'node16', moduleResolution: 'node16' },
    files: ['consumer.mts', 'consumer.cts'],
  }));
  writeFileSync(join(full, 'tsconfig.bundler.json'), JSON.stringify({
    compilerOptions: { ...compilerBase, module: 'esnext', moduleResolution: 'bundler' },
    files: ['bundler.ts'],
  }));
  for (const config of ['tsconfig.node16.json', 'tsconfig.bundler.json']) {
    run(process.execPath, [tsc, '-p', config], full);
    console.log(`ok   typescript ${config}`);
  }
  await bundle(full, true, ['esbuild', 'webpack']);

  // Anthropic-only install: openai is an optional peer and must not be required.
  const anthropicOnly = project('anthropic-only', [tarball, `@anthropic-ai/sdk@${anthropicVersion}`, 'webpack@5', 'webpack-cli@6']);
  writeFileSync(join(anthropicOnly, 'esm.mjs'), esmTest(false));
  writeFileSync(join(anthropicOnly, 'cjs.cjs'), cjsTest(false));
  await runNode('esm.mjs', anthropicOnly, env);
  await runNode('cjs.cjs', anthropicOnly, env);
  await bundle(anthropicOnly, false, ['webpack']);

  console.log('\npackage test passed');
} catch (error) {
  console.error('\npackage test FAILED:', error.message);
  process.exitCode = 1;
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
