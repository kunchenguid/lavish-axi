export function injectLavishSdk(html, key) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  const match = html.match(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  if (match) {
    const index = match.index;
    return html.slice(0, index) + script + html.slice(index);
  }
  return `${html}\n${script}`;
}
