import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSupportedPiRuntimeContract } from './pi-runtime-contract.ts';

const packageJson = JSON.stringify({ dependencies: { '@mariozechner/pi-coding-agent': '0.73.1' } });
const runtimeManifest = JSON.stringify({
  package: '@mariozechner/pi-coding-agent',
  version: '0.73.1',
  apiProtocol: 'openai-completions',
});

test('Pi template and tenant runtime require the same pinned OpenAI-compatible contract', () => {
  assert.equal(hasSupportedPiRuntimeContract(packageJson, runtimeManifest), true);
  assert.equal(hasSupportedPiRuntimeContract(packageJson, runtimeManifest.replace('openai-completions', 'anthropic-messages')), false);
  assert.equal(hasSupportedPiRuntimeContract(packageJson, runtimeManifest.replace('0.73.1', '0.73.0')), false);
  assert.equal(hasSupportedPiRuntimeContract('{invalid', runtimeManifest), false);
});
