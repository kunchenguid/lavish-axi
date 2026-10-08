export const SESSION_LINK_NAVIGATION_JS = `(() => {
  function prepareSessionLinkNavigation(event) {
    if (event.defaultPrevented) return;
    const link = event.target?.closest?.("a[href]");
    if (!link || link.getAttribute("download") !== null) return;
    let url;
    try {
      url = new URL(link.getAttribute("href"), document.baseURI);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || !/^\\/session\\/[0-9a-f]{16}\\/?$/i.test(url.pathname)) return;
    link.setAttribute("target", "_blank");
    const rel = (link.getAttribute("rel") || "")
      .split(/\\s+/)
      .filter((token) => token && token.toLowerCase() !== "opener");
    if (!rel.some((token) => token.toLowerCase() === "noopener")) rel.push("noopener");
    link.setAttribute("rel", rel.join(" "));
  }

  document.addEventListener("auxclick", (event) => {
    if (event.button === 1) prepareSessionLinkNavigation(event);
  }, true);
  document.addEventListener("click", prepareSessionLinkNavigation, true);
})();`;
