// SPDX-License-Identifier: AGPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../session.cjs');

test('session survives restart with tabs, selection, recent history and independent preferences', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmmarkup-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'profile', 'studio-session.json');
  const first = new SessionStore(file);
  await first.load();
  await first.rememberFolder(root); await first.rememberFile(root, 'a.md'); await first.rememberFile(root, 'sub/b.md');
  await first.update({ tabs: ['a.md', 'sub/b.md'], activeId: 'sub/b.md', editorTheme: 'dark', previewTheme: 'light', previewScale: 0.75,
    documentContents: 'synthetic content must never enter configuration' });
  const second = new SessionStore(file); const state = await second.load();
  assert.equal(state.folder, root); assert.deepEqual(state.tabs, ['a.md', 'sub/b.md']);
  assert.equal(state.activeId, 'sub/b.md'); assert.equal(state.editorTheme, 'dark');
  assert.equal(state.previewTheme, 'light'); assert.equal(state.previewScale, 0.75);
  assert.deepEqual(state.recentFiles[0], { folder: root, id: 'sub/b.md' });
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /synthetic content/);
  await second.rememberFolder(path.join(root, 'other'));
  assert.deepEqual(second.state.tabs, []); assert.equal(second.state.activeId, null);
});

test('rapid preference changes are ordered; malformed paths and configuration cannot become file contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmmarkup-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json'); const store = new SessionStore(file);
  await Promise.all([store.update({ previewScale: 0.5 }), store.update({ previewScale: 1.5 }), store.update({ previewScale: 0.8,
    tabs: ['../escape.md', '/absolute.md', 'valid.md', 'valid.md', 'config.json'], activeId: '../escape.md',
    recentFiles: [{ folder: root, id: '../escape.md' }, { folder: root, id: 'valid.md' }] })]);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.previewScale, 0.8); assert.deepEqual(saved.tabs, ['valid.md']); assert.equal(saved.activeId, 'valid.md');
  assert.equal(saved.recentFiles.length, 1);
  await fs.writeFile(file, '{broken'); const broken = new SessionStore(file);
  assert.equal((await broken.load()).folder, null); assert.equal(broken.error, true);
});

test('legacy preferences migrate once without changing the source or overwriting existing settings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmmarkup-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyFile = path.join(root, 'legacy-session.json');
  const file = path.join(root, 'new-profile', 'studio-session.json');
  const legacy = JSON.stringify({ version: 1, folder: root, tabs: ['old.md'], activeId: 'old.md',
    editorTheme: 'dark', previewTheme: 'light', previewScale: 0.75, documentContents: 'must not migrate' });
  await fs.writeFile(legacyFile, legacy);
  const migrated = new SessionStore(file);
  assert.equal((await migrated.load(legacyFile)).activeId, 'old.md');
  assert.equal(migrated.state.previewScale, 0.75);
  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /must not migrate/);
  await migrated.update({ previewScale: 1.25 });
  const reopened = new SessionStore(file);
  assert.equal((await reopened.load(legacyFile)).previewScale, 1.25);
  const invalidFile = path.join(root, 'invalid-profile', 'studio-session.json');
  await fs.writeFile(legacyFile, '{broken');
  const invalid = new SessionStore(invalidFile);
  assert.equal((await invalid.load(legacyFile)).folder, null);
  assert.equal(invalid.error, true);
  await assert.rejects(fs.access(invalidFile));
});
