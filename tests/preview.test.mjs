// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../preview.mjs';

test('renders headings, Chinese, tables, lists, code and source anchors', () => {
  const html = renderMarkdown('# 合成标题\n\n**粗体**\n\n| a | b |\n| - | - |\n| 甲 | 乙 |\n\n- item\n\n```js\nconst a = 1;\n```');
  for (const pattern of [/<h1 data-source-line="0">合成标题/, /<strong>粗体<\/strong>/, /<table/, /<td>甲/, /<ul/, /language-js/, /const a = 1;/]) assert.match(html, pattern);
});
test('raw HTML, scripts and event handlers stay inert text', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="file:///ignored"></iframe>');
  assert.doesNotMatch(html, /<(script|img|iframe)\b/);
  assert.match(html, /&lt;script&gt;/);
});
test('images never become resource requests and links cannot navigate', () => {
  const html = renderMarkdown('![<unsafe>](https://example.invalid/image.png)\n\n[web](https://example.invalid/) [local](file:///ignored) [bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<(img|iframe)\b|\b(src|href)=/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /首版不加载图片/);
});

test('renders complex LaTeX with dollar, bracket and math-fence delimiters', () => {
  const source = String.raw`行内 $\nabla\cdot\mathbf{E}=\frac{\rho}{\varepsilon_0}$ 与 \(e^{i\pi}+1=0\)。

$$
\begin{aligned}
\mathcal{L}(\theta) &= \sum_{i=1}^{n}\log p_\theta(x_i) \\
\int_{-\infty}^{\infty} e^{-x^2}\,dx &= \sqrt{\pi}
\end{aligned}
$$

\[
A=\begin{pmatrix} a & b \\ c & d \end{pmatrix},\quad
f(x)=\begin{cases}x^2 & x\ge 0 \\ -x & x<0\end{cases}
\]

` + '```math\n\\frac{\\partial^2 f}{\\partial x^2}\\tag{1}\n```';
  const html = renderMarkdown(source);
  assert.equal((html.match(/class="katex"/g) || []).length, 5);
  assert.match(html, /<math/); assert.match(html, /class="katex-display"/);
  assert.match(html, /data-source-line="2"/);
  assert.doesNotMatch(html, /class="katex-error"/);
});

test('math does not execute code, fetch resources or alter code literals', () => {
  const html = renderMarkdown(String.raw`$\href{https://example.invalid/}{link}$

$\includegraphics{file:///ignored}$

$\htmlClass{evil}{x}$

` + '`$x^2$`\n\n```tex\n$$x^2$$\n```');
  assert.doesNotMatch(html, /<(img|iframe|script)\b|\b(?:src|href)=|class="evil"/);
  assert.match(html, /<code>\$x\^2\$<\/code>/);
  assert.match(html, /\$\$x\^2\$\$/);
});

test('invalid formula stays visible and macros do not leak between documents', () => {
  assert.match(renderMarkdown('$\\frac{broken$'), /katex-error/);
  assert.doesNotMatch(renderMarkdown('$x^2$'), /katex-error/);
  assert.doesNotMatch(renderMarkdown(String.raw`$\gdef\localmacro{42}\localmacro$`), /katex-error/);
  assert.match(renderMarkdown(String.raw`$\localmacro$`), /<mtext>\\localmacro<\/mtext>/);
  assert.match(renderMarkdown('价格 100 美元，符号 \\$ 保留。'), /\$/);
});
