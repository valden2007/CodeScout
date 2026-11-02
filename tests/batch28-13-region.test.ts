import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activate } from '../extension/src/extension';
import { beginScan, isKeyRegionBlocked, markProfileRegionBlocked, resetRuntime, type KeychainProfile } from '../extension/src/keychain';
import { state, flush, makeFakeContext } from './vscode-stub';

const realFetch = globalThis.fetch;

interface CapturedView {
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri: (uri: { toString(): string }) => { toString(): string };
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (cb: (message: never) => void) => { dispose(): void };
  };
  onDidDispose: (cb: () => void) => { dispose(): void };
}

function bootPanel(): { html: () => string } {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
  const view: CapturedView = {
    webview: {
      html: '', options: {}, cspSource: 'vscode-webview://test', asWebviewUri: (uri) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: () => ({ dispose: () => {} })
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
  provider.resolveWebviewView(view);
  return { html: () => view.webview.html };
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-b2813-region-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const value = 1;\n', 'utf8');
  return root;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('микро-батч 28.13: региональная ротация', () => {
  let root = '';

  beforeEach(() => {
    state.reset();
    resetRuntime();
    root = makeWorkspace();
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('метка region действует до нового прогона и снимается при beginScan', () => {
    const profile: KeychainProfile = {
      id: 'geo', label: 'GeoProfile', provider: 'groq',
      model: 'geo-model', keys: [{ id: 'default', label: 'geo-key', secretId: 'keychain.geo.default', enabled: true }]
    };
    beginScan('geo');
    markProfileRegionBlocked(profile);
    expect(isKeyRegionBlocked('geo', 'default')).toBe(true);
    beginScan('geo');
    expect(isKeyRegionBlocked('geo', 'default')).toBe(false);
  });

  async function configureTwoProfiles(): Promise<void> {
    state.set('codescout.keychain', [
      { id: 'geo', label: 'GeoProfile', provider: 'groq', model: 'geo-model', keys: [{ id: 'default', label: 'geo-key', enabled: true }] },
      { id: 'other', label: 'OtherVendor', provider: 'openai', model: 'other-model', keys: [{ id: 'default', label: 'other-key', enabled: true }] }
    ]);
    state.set('codescout.keychain.active', 'geo');
    state.set('codescout.failover.enabled', false);
    state.secrets.set('keychain.geo.default', 'CS_GEO_TEST_KEY');
    state.secrets.set('keychain.other.default', 'CS_OTHER_TEST_KEY');
  }

  it('403 «not available in your country» сразу переключает профиль и повторяет тот же файл', async () => {
    await configureTwoProfiles();
    const requests: Array<{ model: string; prompt: string }> = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return jsonResponse({ data: [] });
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages: Array<{ content: string }> };
      requests.push({ model: body.model, prompt: body.messages[1]?.content ?? '' });
      if (body.model === 'geo-model') return jsonResponse({ error: { message: 'This model is not available in your country' } }, 403);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ issues: [{ line: 1, category: 'bug', severity: 'medium', description: 'ROTATED_PROFILE_FINDING', proof: 'export const value = 1;', confidence: 90 }], summary: 'ok' }) } }] });
    }) as typeof fetch;

    bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    expect(requests.map((request) => request.model)).toEqual(['geo-model', 'other-model']);
    expect(requests[0]?.prompt).toContain('File: src/a.ts');
    expect(requests[1]?.prompt).toContain('File: src/a.ts');
    expect(state.outputLines.some((line) => line.includes('region:') && line.includes('OtherVendor'))).toBe(true);
    expect(state.errorMessages).toEqual([]);
  }, 120000);

  it('если оба профиля гео-заблокированы, останавливается с баннером-списком моделей', async () => {
    await configureTwoProfiles();
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return jsonResponse({ data: [] });
      calls += 1;
      return jsonResponse({ error: { message: 'This model is not available in your country' } }, 403);
    }) as typeof fetch;
    const panel = bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    expect(calls).toBe(2);
    expect(panel.html()).toContain('Гео-блок');
    expect(panel.html()).toContain('гео-блок: GeoProfile/geo-model');
    expect(panel.html()).toContain('гео-блок: OtherVendor/other-model');
    expect(panel.html()).toContain('выберите модель другого вендора');
    expect(state.errorMessages).toEqual([]);
  }, 120000);
});
