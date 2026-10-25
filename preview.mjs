// SPDX-License-Identifier: AGPL-3.0-only
import MarkdownIt from 'markdown-it';
import { katex } from '@mdit/plugin-katex';

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
parser.use(katex, { delimiters: 'all', mathFence: true, trust: false, throwOnError: false,
  maxExpand: 1000, maxSize: 30, logger: () => 'ignore' });
// File and remote images would read local material or send requests just by opening a document.
parser.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  return `<span class="image-placeholder">▧ ${parser.utils.escapeHtml(token.content || '图片')}（首版不加载图片）</span>`;
};
parser.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = token.attrGet('href') || '';
  token.attrs = [['title', href], ['class', 'document-link']];
  return self.renderToken(tokens, index, options);
};
for (const name of ['heading_open', 'paragraph_open', 'bullet_list_open', 'ordered_list_open',
  'blockquote_open', 'table_open', 'fence', 'code_block', 'math_block']) {
  const original = parser.renderer.rules[name];
  parser.renderer.rules[name] = (tokens, index, options, env, self) => {
    if (tokens[index].map) tokens[index].attrSet('data-source-line', String(tokens[index].map[0]));
    if (name === 'fence' || name === 'code_block' || name === 'math_block') {
      return `<div data-source-line="${tokens[index].map?.[0] || 0}">${original(tokens, index, options, env, self)}</div>`;
    }
    return original ? original(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };
}
export function renderMarkdown(text) { return parser.render(text); }
