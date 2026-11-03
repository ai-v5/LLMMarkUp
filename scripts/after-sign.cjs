// SPDX-License-Identifier: AGPL-3.0-only
const { createManifest } = require('./payload-manifest.cjs');
module.exports = async context => {
  if (context.electronPlatformName === 'win32') createManifest(context.appOutDir);
};
