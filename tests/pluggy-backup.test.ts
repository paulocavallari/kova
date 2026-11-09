import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, restoreBackup } from '../src/lib/backup';
import { getState, replaceState } from '../src/lib/store';
import { initialState } from '../src/lib/defaults';
import type { PluggyConn, State } from '../src/lib/types';

const SECRET = 'super-secret-value-123';

function conn(id: string, secret = SECRET): PluggyConn {
  return {
    id,
    name: `API ${id}`,
    clientId: `client-${id}`,
    clientSecret: secret,
    itemIds: ['item-1'],
    baseUrl: 'https://api.pluggy.ai',
    enabled: true,
    auto: true,
  };
}

function fixture(conns: PluggyConn[]): State {
  const s = initialState('pt');
  return { ...s, pluggy: conns };
}

test('buildBackup omits clientSecret without mutating the live state', async () => {
  const state = fixture([conn('a'), conn('b', 'other-secret')]);
  const json = await buildBackup(state);
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes('other-secret'));
  assert.equal(state.pluggy?.[0].clientSecret, SECRET);
  assert.equal(state.pluggy?.[1].clientSecret, 'other-secret');
  const parsed = JSON.parse(json);
  assert.equal(parsed.state.pluggy.length, 2);
  assert.equal('clientSecret' in parsed.state.pluggy[0], false);
  assert.equal(parsed.state.pluggy[0].clientId, 'client-a');
});

test('legacy state without pluggy still exports and restores', async () => {
  const state = fixture([]);
  const json = await buildBackup(state);
  assert.equal(JSON.parse(json).state.pluggy.length, 0);
  replaceState(fixture([]));
  const r = await restoreBackup(json);
  assert.equal(r.accounts, state.accounts.length);
  assert.equal(getState().pluggy?.length, 0);
});

test('restore keeps the local secret by connection id when the backup omits it', async () => {
  replaceState(fixture([conn('a', SECRET)]));
  const exported = await buildBackup(fixture([conn('a', '')]));
  const back = JSON.parse(exported);
  back.state.pluggy[0].clientSecret = '';
  await restoreBackup(JSON.stringify(back));
  assert.equal(getState().pluggy?.[0].clientSecret, SECRET);
  assert.equal(getState().pluggy?.[0].enabled, true);
});

test('restore of a connection with no local secret disables it until re-entry', async () => {
  replaceState(fixture([]));
  const exported = await buildBackup(fixture([conn('new', '')]));
  const back = JSON.parse(exported);
  back.state.pluggy[0].clientSecret = '';
  await restoreBackup(JSON.stringify(back));
  assert.equal(getState().pluggy?.[0].clientSecret, '');
  assert.equal(getState().pluggy?.[0].enabled, false);
});

test('restore still refuses files that are not Kova backups', async () => {
  await assert.rejects(() => restoreBackup(JSON.stringify({ hello: true })), /NOT_KOVA/);
  await assert.rejects(() => restoreBackup(''), /EMPTY/);
  await assert.rejects(() => restoreBackup('{oops'), /BROKEN/);
});
