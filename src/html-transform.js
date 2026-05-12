export function injectLavishSdk(html, key) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  const design = shouldInjectDesign(html)
    ? '<link rel="stylesheet" href="/design/daisyui.css" data-lavish-design><script src="/design/tailwindcss-browser.js" data-lavish-design></script><link rel="stylesheet" href="/design/daisyui-themes.css" data-lavish-design>'
    : "";
  const withDesign = injectDesignAssets(html, design);
  if (/<\/body\s*>/i.test(withDesign)) {
    return withDesign.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${withDesign}\n${script}`;
}

function shouldInjectDesign(html) {
  if (/data-lavish-design/i.test(html)) return false;
  return !/<meta\b(?=[^>]*name=["']lavish-design["'])(?=[^>]*content=["']off["'])[^>]*>/i.test(html);
}

function injectDesignAssets(html, design) {
  if (!design) return html;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${design}`);
  }
  return `${html}\n${design}`;
}
