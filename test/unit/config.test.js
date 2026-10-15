import test from 'node:test';
import assert from 'node:assert/strict';
import { config, env, environments, selectEnv } from '../../play/js/config.js';

test('?env=emu picks the emulator on any host', () => {
  assert.equal(selectEnv({ hostname: 'kiresakura.github.io', search: '?env=emu' }), 'emu');
  assert.equal(selectEnv({ hostname: '192.168.1.20', search: '?env=emu' }), 'emu');
  assert.equal(selectEnv({ hostname: 'localhost', search: '?env=emu' }), 'emu');
});

test('?env=prod picks the production project on any host', () => {
  assert.equal(selectEnv({ hostname: 'localhost', search: '?env=prod' }), 'prod');
  assert.equal(selectEnv({ hostname: '127.0.0.1', search: '?env=prod' }), 'prod');
  assert.equal(selectEnv({ hostname: '', search: '?env=prod' }), 'prod');
  assert.equal(selectEnv({ hostname: 'localhost', search: '?env=prod&slot=p1' }), 'prod');
  assert.equal(selectEnv({ hostname: 'localhost', search: '?slot=p2&env=prod' }), 'prod');
});

test('without ?env= local hosts and no host pick the emulator', () => {
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]', '']) {
    assert.equal(selectEnv({ hostname, search: '' }), 'emu', hostname);
    assert.equal(selectEnv({ hostname, search: '?slot=p1' }), 'emu', hostname);
  }
  assert.equal(selectEnv(), 'emu');
  assert.equal(selectEnv({}), 'emu');
});

test('without ?env= any other host picks the production project', () => {
  for (const hostname of ['kiresakura.github.io', '192.168.1.20', 'localhost.example', '127.0.0.2']) {
    assert.equal(selectEnv({ hostname, search: '' }), 'prod', hostname);
  }
});

test('an unknown ?env= value falls back to the host rule', () => {
  assert.equal(selectEnv({ hostname: 'localhost', search: '?env=staging' }), 'emu');
  assert.equal(selectEnv({ hostname: 'localhost', search: '?env=PROD' }), 'emu');
  assert.equal(selectEnv({ hostname: 'localhost', search: '?env=' }), 'emu');
  assert.equal(selectEnv({ hostname: 'kiresakura.github.io', search: '?env=Emu' }), 'prod');
});

test('Node tests run against the emulator', () => {
  assert.equal(env, 'emu');
  assert.equal(config, environments.emu);
  assert.deepEqual(config.emulator, { host: '127.0.0.1', authPort: 9099, databasePort: 9000 });
});

test('only the emulator settings use a demo project', () => {
  assert.match(environments.emu.firebase.projectId, /^demo-/);
  assert.doesNotMatch(environments.prod.firebase.projectId, /^demo-/);
  assert.equal(environments.prod.emulator, null);
  assert.match(environments.prod.firebase.databaseURL, /^https:\/\/[a-z0-9-]+\.asia-southeast1\.firebasedatabase\.app$/);
  for (const key of ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId']) {
    assert.equal(typeof environments.prod.firebase[key], 'string', key);
    assert.ok(environments.prod.firebase[key].length > 0, key);
  }
});
