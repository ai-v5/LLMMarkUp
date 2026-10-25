// SPDX-License-Identifier: AGPL-3.0-only
import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist', { recursive: true });
const result = await build({ entryPoints: ['renderer.js'], bundle: true, outfile: 'dist/renderer.js',
  platform: 'browser', format: 'iife', minify: true, sourcemap: false, target: 'chrome145',
  legalComments: 'eof', metafile: true });
for (const file of ['index.html', 'styles.css']) await copyFile(file, `dist/${file}`);
await copyFile('node_modules/katex/dist/katex.min.css', 'dist/katex.min.css');
await cp('node_modules/katex/dist/fonts', 'dist/fonts', { recursive: true });
// Include the actual bundled libraries' notices, including transitive dependencies.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).filter(file => file.includes('node_modules/'))) {
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name && !packages.has(metadata.name)) {
        let license;
        for (const name of (await readdir(directory)).filter(name => /^licen[cs]e(?:[.-]|$)/i.test(name))) {
          try { license = await readFile(path.join(directory, name), 'utf8'); break; } catch {}
        }
        if (!license) throw new Error(`Missing third-party license: ${metadata.name}`);
        packages.set(metadata.name, `${metadata.name} ${metadata.version}\n${license}`);
      }
      if (metadata.name) break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', [...packages.values()].sort().join('\n\n--------------------\n\n') +
  '\n\n--------------------\n\n' + await readFile('licenses/KaTeX-FONTS-OFL.txt', 'utf8'), 'utf8');
