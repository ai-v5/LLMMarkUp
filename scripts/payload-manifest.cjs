// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const manifestName = 'llmmarkup-payload-manifest.json';
function digest(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const length = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally { fs.closeSync(handle); }
  return hash.digest('hex');
}
function createManifest(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Installation payload cannot contain links.');
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full !== path.join(root, manifestName)) {
        files.push({ path: path.relative(root, full).split(path.sep).join('/'), sha256: digest(full) });
      } else if (!entry.isFile()) throw new Error('Installation payload contains an unsupported file type.');
    }
  }
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const name of ['LLMMarkUp.exe', 'llmmarkup-launcher.exe', 'resources/app.asar']) {
    if (!files.some(item => item.path === name)) throw new Error(`Missing installation payload file: ${name}`);
  }
  fs.writeFileSync(path.join(root, manifestName), JSON.stringify({ schema: 1, product: 'llmmarkup', files }) + '\n');
}
module.exports = { createManifest };
