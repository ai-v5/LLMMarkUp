// SPDX-License-Identifier: AGPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Workspace, MAX_BYTES } = require('../workspace.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdppt-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(); await workspace.select(root);
  return { root, workspace };
}
test('lazy directory listing includes Markdown and directories, excludes runtime and links', async t => {
  const { root, workspace } = await fixture(t);
  for (const name of ['章节', 'node_modules', '.git']) await fs.mkdir(path.join(root, name));
  for (const name of ['中文.md', 'UPPER.MARKDOWN', 'notes.txt']) await fs.writeFile(path.join(root, name), '');
  const entries = await workspace.list();
  assert.deepEqual(entries.map(e => e.name), ['章节', '中文.md', 'UPPER.MARKDOWN']);
  assert.deepEqual(await workspace.list('章节'), []);
});
test('save preserves UTF-8 BOM, CRLF and Chinese content', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, '文档.md'), '\uFEFF# 合成示例\r\n正文\r\n');
  const doc = await workspace.read('文档.md');
  assert.equal(doc.text, '# 合成示例\n正文\n'); assert.equal(doc.eol, 'CRLF'); assert.equal(doc.bom, true);
  const next = await workspace.save(doc.id, doc.text + '更新\n', doc.version);
  assert.notEqual(next.version, doc.version);
  assert.equal(await fs.readFile(path.join(root, doc.id), 'utf8'), '\uFEFF# 合成示例\r\n正文\r\n更新\r\n');
  assert.equal(await workspace.changed(doc.id, next.version), false);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
});
test('external changes, stale writes and deletion never overwrite disk', async t => {
  const { root, workspace } = await fixture(t);
  const target = path.join(root, 'a.md'); await fs.writeFile(target, 'before');
  const doc = await workspace.read('a.md');
  await fs.writeFile(target, 'external');
  assert.equal(await workspace.changed(doc.id, doc.version), true);
  await assert.rejects(workspace.save(doc.id, 'mine', doc.version), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'external');
  const latest = await workspace.read(doc.id);
  await workspace.save(doc.id, 'next', latest.version);
  await assert.rejects(workspace.save(doc.id, 'stale', latest.version), { code: 'CONFLICT' });
  await fs.unlink(target);
  await assert.rejects(workspace.save(doc.id, 'mine', latest.version));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});
test('rename failure keeps original file and cleans only its own temporary file', async t => {
  const { root, workspace } = await fixture(t);
  const target = path.join(root, 'a.md'); await fs.writeFile(target, 'before');
  const doc = await workspace.read('a.md');
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('synthetic failure'), { code: 'EPERM' }); };
  try { await assert.rejects(workspace.save(doc.id, 'after', doc.version), { code: 'EPERM' }); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(target, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['a.md']);
});
test('rejects traversal, absolute paths, non-Markdown and symlink escapes', async t => {
  const { root, workspace } = await fixture(t);
  for (const id of ['../a.md', 'x/../a.md', '/a.md', 'C:\\a.md', 'a\0.md']) {
    await assert.rejects(workspace.read(id), { code: 'PATH' });
  }
  await fs.writeFile(path.join(root, 'x.json'), '{}');
  await assert.rejects(workspace.read('x.json'), { code: 'TYPE' });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mdppt-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'a.md'), 'outside');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.read('linked/a.md'), { code: 'LINK' });
  assert.equal((await workspace.list()).some(e => e.name === 'linked'), false);
});
test('refuses invalid UTF-8, null characters, mixed EOL and oversized files', async t => {
  const { root, workspace } = await fixture(t);
  const cases = [Buffer.from([0xff, 0xfe]), Buffer.from('a\0b'), Buffer.from('a\r\nb\nc'), Buffer.from('a\rb')];
  for (const bytes of cases) {
    await fs.writeFile(path.join(root, 'a.md'), bytes);
    await assert.rejects(workspace.read('a.md'), { code: 'ENCODING' });
  }
  await fs.writeFile(path.join(root, 'a.md'), Buffer.alloc(MAX_BYTES + 1, 32));
  await assert.rejects(workspace.read('a.md'), { code: 'SIZE' });
  await fs.writeFile(path.join(root, 'a.md'), 'small');
  const doc = await workspace.read('a.md');
  await assert.rejects(workspace.save(doc.id, '中'.repeat(MAX_BYTES / 2), doc.version), { code: 'SIZE' });
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'small');
});
test('new files use exclusive creation and reject reserved names', async t => {
  const { root, workspace } = await fixture(t);
  await workspace.create('新建.md');
  await fs.writeFile(path.join(root, '新建.md'), 'keep');
  await assert.rejects(workspace.create('新建.md'), { code: 'EEXIST' });
  for (const name of ['CON.md', '../a.md', 'sub/a.md', 'a:stream.md', 'name.txt', '.hidden.md', 'a?.md']) {
    await assert.rejects(workspace.create(name), { code: 'NAME' });
  }
  assert.equal(await fs.readFile(path.join(root, '新建.md'), 'utf8'), 'keep');
});
test('switching roots invalidates opened file versions', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.md'), 'first');
  const doc = await workspace.read('a.md');
  await fs.mkdir(path.join(root, 'other')); await fs.writeFile(path.join(root, 'other', 'a.md'), 'first');
  await workspace.select(path.join(root, 'other'));
  await assert.rejects(workspace.save('a.md', 'wrong', doc.version), { code: 'CONFLICT' });
});

test('new directories support nested parents without overwriting or escaping', async t => {
  const { root, workspace } = await fixture(t);
  assert.deepEqual(await workspace.createDirectory('', '资料'), { id: '资料' });
  assert.deepEqual(await workspace.createDirectory('资料', '子目录'), { id: '资料/子目录' });
  await fs.writeFile(path.join(root, '资料', 'keep.md'), 'keep');
  await assert.rejects(workspace.createDirectory('', '资料'), { code: 'EEXIST' });
  await assert.rejects(workspace.createDirectory('资料', 'keep.md'), { code: 'EEXIST' });
  for (const name of ['../outside', 'a/b', 'CON', 'nul.txt', 'bad?', '', '   ', '.hidden', 'trailing.']) {
    await assert.rejects(workspace.createDirectory('', name), { code: 'NAME' });
  }
  await assert.rejects(workspace.createDirectory('..', 'outside'), { code: 'PATH' });
  await fs.symlink(path.join(root, '资料'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.createDirectory('link', 'outside'), { code: 'LINK' });
  assert.equal(await fs.readFile(path.join(root, '资料', 'keep.md'), 'utf8'), 'keep');
});

test('context creation and moves preserve bytes and versions without overwriting destinations', async t => {
  const { root, workspace } = await fixture(t);
  await workspace.createDirectory('', '资料');
  const created = await workspace.create('嵌套.md', '资料');
  assert.equal(created.id, '资料/嵌套.md');
  assert.equal(await workspace.directoryId(path.join(root, '资料')), '资料');
  assert.equal(await workspace.directoryId(root), '');
  await assert.rejects(workspace.directoryId(path.dirname(root)), { code: 'PATH' });
  await assert.rejects(workspace.create('嵌套.md', '资料'), { code: 'EEXIST' });
  const bytes = Buffer.from('\uFEFF# 合成移动\r\n');
  await fs.writeFile(path.join(root, '移动.md'), bytes);
  const file = await workspace.read('移动.md');
  await fs.writeFile(path.join(root, '资料', '移动.md'), 'existing');
  await assert.rejects(workspace.move(file.id, '资料', file.version), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(root, '资料', '移动.md'), 'utf8'), 'existing');
  await fs.unlink(path.join(root, '资料', '移动.md'));
  const moved = await workspace.move(file.id, '资料', file.version);
  assert.equal(moved.id, '资料/移动.md'); assert.equal(moved.version, file.version);
  assert.deepEqual(await fs.readFile(path.join(root, '资料', '移动.md')), bytes);
  await assert.rejects(fs.access(path.join(root, '移动.md')));
  await workspace.save(moved.id, 'saved draft\n', moved.version);
  assert.equal(await fs.readFile(path.join(root, '资料', '移动.md'), 'utf8'), '\uFEFFsaved draft\r\n');
  await fs.symlink(path.join(root, '资料'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.directoryId(path.join(root, 'linked')), { code: 'LINK' });
});

test('failed move cleanup, stale mutations and failed recycle calls keep the source intact', async t => {
  const { root, workspace } = await fixture(t);
  await workspace.createDirectory('', 'target');
  await fs.writeFile(path.join(root, 'a.md'), 'original');
  const file = await workspace.read('a.md');
  const unlink = fs.unlink;
  fs.unlink = async target => {
    if (target === path.join(workspace.root, 'a.md')) throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' });
    return unlink(target);
  };
  try { await assert.rejects(workspace.move('a.md', 'target', file.version), { code: 'EACCES' }); }
  finally { fs.unlink = unlink; }
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'original');
  await assert.rejects(fs.access(path.join(root, 'target', 'a.md')));
  await assert.rejects(workspace.trash('a.md', file.version, async () => { throw new Error('synthetic trash failure'); }));
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'original');
  await fs.writeFile(path.join(root, 'a.md'), 'external edit');
  await assert.rejects(workspace.move('a.md', 'target', file.version), { code: 'CONFLICT' });
  let called = false;
  await assert.rejects(workspace.trash('a.md', file.version, async () => { called = true; }), { code: 'CONFLICT' });
  assert.equal(called, false);
  const next = await workspace.read('a.md');
  await workspace.trash('a.md', next.version, target => fs.rename(target, path.join(root, 'target', 'recycled.md')));
  assert.equal(workspace.opened.has('a.md'), false);
  assert.equal(await fs.readFile(path.join(root, 'target', 'recycled.md'), 'utf8'), 'external edit');
});

test('a source replaced during a move is preserved and only the created link is cleaned', async t => {
  const { root, workspace } = await fixture(t);
  await workspace.createDirectory('', 'target');
  await fs.writeFile(path.join(root, 'a.md'), 'original');
  const file = await workspace.read('a.md');
  const link = fs.link;
  fs.link = async (source, destination) => {
    await link(source, destination);
    await fs.writeFile(path.join(root, 'replacement.md'), 'external replacement');
    await fs.rename(path.join(root, 'replacement.md'), source);
  };
  try { await assert.rejects(workspace.move('a.md', 'target', file.version), { code: 'CONFLICT' }); }
  finally { fs.link = link; }
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'external replacement');
  await assert.rejects(fs.access(path.join(root, 'target', 'a.md')));
});

test('a destination replaced during a move is never removed by cleanup', async t => {
  const { root, workspace } = await fixture(t);
  await workspace.createDirectory('', 'target'); await fs.writeFile(path.join(root, 'a.md'), 'original');
  const file = await workspace.read('a.md'); const link = fs.link;
  fs.link = async (source, destination) => {
    await link(source, destination);
    await fs.writeFile(path.join(root, 'replacement.md'), 'external target');
    await fs.rename(path.join(root, 'replacement.md'), destination);
  };
  try { await assert.rejects(workspace.move('a.md', 'target', file.version), { code: 'MOVE_PARTIAL' }); }
  finally { fs.link = link; }
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(root, 'target', 'a.md'), 'utf8'), 'external target');
});
