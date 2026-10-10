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
    const originalTarget = link.getAttribute("target");
    const originalRel = link.getAttribute("rel");
    link.setAttribute("target", "_blank");
    const rel = (link.getAttribute("rel") || "")
      .split(/\\s+/)
      .filter((token) => token && token.toLowerCase() !== "opener");
    if (!rel.some((token) => token.toLowerCase() === "noopener")) rel.push("noopener");
    const navigationRel = rel.join(" ");
    link.setAttribute("rel", navigationRel);
    // Native activation consumes these attributes before the next task. Restore
    // them afterwards, without overwriting changes made by the page's handlers.
    setTimeout(() => {
      if (link.getAttribute("target") === "_blank") {
        if (originalTarget === null) link.removeAttribute("target");
        else link.setAttribute("target", originalTarget);
      }
      if (link.getAttribute("rel") === navigationRel) {
        if (originalRel === null) link.removeAttribute("rel");
        else link.setAttribute("rel", originalRel);
      }
    }, 0);
  }

  document.addEventListener("auxclick", (event) => {
    if (event.button === 1) prepareSessionLinkNavigation(event);
  }, true);
  document.addEventListener("click", prepareSessionLinkNavigation, true);
})();`;
