// Minimal, dependency-free markdown renderer for AI output.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function mdToHtml(md) {
  const lines = esc(md || '').split('\n');
  const out = [];
  let inCode = false;
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      closeList();
      if (!inCode) { out.push('<pre><code>'); inCode = true; }
      else { out.push('</code></pre>'); inCode = false; }
      continue;
    }
    if (inCode) { out.push(raw); continue; }

    const h = raw.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); const lvl = Math.min(h[1].length + 1, 4); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }

    const ol = raw.match(/^\s*\d+[.)]\s+(.*)/);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }

    const ul = raw.match(/^\s*[-*•]\s+(.*)/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }

    closeList();
    if (raw.trim() === '') continue;
    out.push(`<p>${inline(raw)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

export default function Markdown({ text, className = 'ai-output' }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}
