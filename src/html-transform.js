export function injectLavishSdk(html, key) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}
