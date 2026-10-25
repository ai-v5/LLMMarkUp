// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const text = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
const relative = value => text(value) && !path.isAbsolute(value) &&
  !value.split(/[\\/]/).some(part => part === '..' || part === '.' || part.includes(':')) && /\.(md|markdown)$/i.test(value);
const folder = value => text(value) && path.isAbsolute(value);
const scale = value => Number.isFinite(value) && value >= 0.5 && value <= 2 ? value : 1;

function clean(value = {}) {
  const tabs = Array.isArray(value.tabs) ? [...new Set(value.tabs.filter(relative))].slice(0, 50) : [];
  return {
    version: 1,
    folder: folder(value.folder) ? value.folder : null,
    tabs,
    activeId: tabs.includes(value.activeId) ? value.activeId : tabs[0] || null,
    editorTheme: value.editorTheme === 'dark' ? 'dark' : 'light',
    previewTheme: value.previewTheme === 'dark' ? 'dark' : 'light',
    editorScale: scale(value.editorScale),
    previewScale: scale(value.previewScale),
    recentFolders: Array.isArray(value.recentFolders) ? [...new Set(value.recentFolders.filter(folder))].slice(0, 12) : [],
    recentFiles: Array.isArray(value.recentFiles) ? value.recentFiles.filter(item => item && folder(item.folder) && relative(item.id))
      .filter((item, index, items) => items.findIndex(other => other.folder === item.folder && other.id === item.id) === index)
      .slice(0, 12).map(({ folder, id }) => ({ folder, id })) : []
  };
}

class SessionStore {
  constructor(file) { this.file = file; this.state = clean(); this.pending = Promise.resolve(); this.error = false; }
  async load(legacyFile) {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 128 * 1024) throw new Error('Session too large');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!value || value.version !== 1) throw new Error('Unknown session format');
      this.state = clean(value);
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = true;
      else if (legacyFile) {
        try {
          if ((await fs.stat(legacyFile)).size > 128 * 1024) throw new Error('Legacy session too large');
          const value = JSON.parse(await fs.readFile(legacyFile, 'utf8'));
          if (!value || value.version !== 1) throw new Error('Unknown legacy session format');
          const migrated = clean(value);
          await fs.mkdir(path.dirname(this.file), { recursive: true });
          await fs.writeFile(this.file, JSON.stringify(migrated, null, 2) + '\n', { flag: 'wx' });
          this.state = migrated;
        } catch (migrationError) {
          if (migrationError.code === 'EEXIST') return this.load();
          if (migrationError.code !== 'ENOENT') this.error = true;
        }
      }
    }
    return this.snapshot();
  }
  snapshot() { return structuredClone(this.state); }
  update(patch) {
    this.state = clean({ ...this.state, ...patch });
    const serialized = JSON.stringify(this.state, null, 2) + '\n';
    const save = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, serialized, { flag: 'wx' });
        await fs.rename(temporary, this.file);
        this.error = false;
      } finally { await fs.unlink(temporary).catch(() => {}); }
    };
    this.pending = this.pending.catch(() => {}).then(save);
    return this.pending;
  }
  rememberFile(root, id) {
    return this.update({ recentFiles: [{ folder: root, id }, ...this.state.recentFiles.filter(item => item.folder !== root || item.id !== id)] });
  }
  rememberFolder(root) { return this.update({ folder: root,
    ...(this.state.folder !== root ? { tabs: [], activeId: null } : {}),
    recentFolders: [root, ...this.state.recentFolders.filter(item => item !== root)] }); }
  relocateFile(root, from, to = null) {
    const tabs = this.state.folder === root ? this.state.tabs.map(id => id === from ? to : id).filter(Boolean) : this.state.tabs;
    return this.update({ tabs,
      activeId: this.state.folder === root && this.state.activeId === from ? to : this.state.activeId,
      recentFiles: this.state.recentFiles.map(item => item.folder === root && item.id === from ?
        (to ? { folder: root, id: to } : null) : item).filter(Boolean) });
  }
  flush() { return this.pending; }
}
module.exports = { SessionStore };
