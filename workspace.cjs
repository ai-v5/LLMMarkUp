// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const SKIP = new Set(['.git', '.codex', '.agents', '.venv', 'node_modules', '__pycache__']);
const isMarkdown = name => /\.(md|markdown)$/i.test(name);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validName(name) {
  return typeof name === 'string' && name.length <= 180 && /\S/.test(name) &&
    !/[\\/<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !name.startsWith('.') &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

class Workspace {
  constructor() { this.root = null; this.opened = new Map(); this.saving = false; }

  async select(folder) {
    const root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory()) throw failure('PATH', '请选择文件夹。');
    this.root = root;
    this.opened.clear();
    return { name: path.basename(root), path: root };
  }

  async resolve(relative = '', file = false) {
    if (!this.root) throw failure('ROOT', '请先打开文件夹。');
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) {
      throw failure('PATH', '文件路径无效。');
    }
    const parts = relative.split(/[\\/]/).filter(Boolean);
    if (parts.some(p => p === '.' || p === '..' || p.includes(':'))) throw failure('PATH', '文件路径无效。');
    let target = this.root;
    for (const part of parts) {
      target = path.join(target, part);
      if ((await fs.lstat(target)).isSymbolicLink()) throw failure('LINK', '暂不打开符号链接或目录联接。');
    }
    if (file && !isMarkdown(target)) throw failure('TYPE', '只支持 .md 和 .markdown 文件。');
    return target;
  }

  async list(relative = '') {
    const target = await this.resolve(relative);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.filter(e => !e.isSymbolicLink() && !SKIP.has(e.name) &&
      (e.isDirectory() || (e.isFile() && isMarkdown(e.name))))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
      .map(e => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file',
        id: relative ? `${relative}/${e.name}` : e.name }));
  }

  async bytes(target) {
    const handle = await fs.open(target, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw failure('TYPE', '目标不是普通文件。');
      if (stat.size > MAX_BYTES) throw failure('SIZE', '首版支持不超过 2 MiB 的 Markdown 文件。');
      // Bounded even if another process grows the file after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw failure('SIZE', '文件超过 2 MiB。');
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }

  async read(id) {
    const target = await this.resolve(id, true);
    const bytes = await this.bytes(target);
    const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes); }
    catch { throw failure('ENCODING', '文件不是有效 UTF-8；为避免损坏，请先用其他工具转换编码。'); }
    if (text.includes('\0')) throw failure('ENCODING', '文件包含空字符，不能作为 Markdown 打开。');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    if (/\r(?!\n)/.test(text) || (eol === '\r\n' && /(?<!\r)\n/.test(text))) {
      throw failure('ENCODING', '文件包含混合或旧式换行；请先统一为 LF 或 CRLF。');
    }
    const version = digest(bytes);
    this.opened.set(id, { version, bom, eol });
    return { id, text: text.replace(/\r\n/g, '\n'), version, eol: eol === '\r\n' ? 'CRLF' : 'LF', bom };
  }

  async changed(id, version) {
    try { return digest(await this.bytes(await this.resolve(id, true))) !== version; }
    catch { return true; }
  }

  async save(id, text, version) {
    if (this.saving) throw failure('BUSY', '正在保存，请稍后再试。');
    this.saving = true;
    let temporary;
    try {
      const target = await this.resolve(id, true);
      const opened = this.opened.get(id);
      if (!opened || opened.version !== version || await this.changed(id, version)) {
        throw failure('CONFLICT', '磁盘文件已变化或被删除。当前编辑已保留，请重新读取后核对；不会覆盖磁盘。');
      }
      if (typeof text !== 'string' || text.includes('\0')) throw failure('TEXT', '文本无效。');
      const normalized = text.replace(/\r\n?/g, '\n').replace(/\n/g, opened.eol);
      const bytes = Buffer.from((opened.bom ? '\uFEFF' : '') + normalized, 'utf8');
      if (bytes.length > MAX_BYTES) throw failure('SIZE', '保存内容超过 2 MiB。');
      const stat = await fs.stat(target);
      temporary = path.join(path.dirname(target), `.mdppt-${crypto.randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', stat.mode);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (await this.changed(id, version)) throw failure('CONFLICT', '保存期间磁盘文件发生变化，已拒绝覆盖。');
      await fs.rename(temporary, target);
      temporary = null;
      const next = digest(bytes);
      this.opened.set(id, { ...opened, version: next });
      return { version: next };
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      this.saving = false;
    }
  }

  async create(name) {
    if (!validName(name) || !isMarkdown(name)) {
      throw failure('NAME', '请输入普通文件名，以 .md 或 .markdown 结尾，不含目录或特殊字符。');
    }
    await this.resolve();
    await fs.writeFile(path.join(this.root, name), '', { flag: 'wx' });
    return this.read(name);
  }

  async createDirectory(parent, name) {
    if (!validName(name)) throw failure('NAME', '请输入普通目录名，不含路径、保留名称或特殊字符。');
    const directory = await this.resolve(parent);
    await fs.mkdir(path.join(directory, name));
    return { id: parent ? `${parent}/${name}` : name };
  }
}
module.exports = { Workspace, MAX_BYTES };
