/* global document, window */

// Drives the injected SDK's reveal path in a real browser and reports geometry back through
// body[data-result]. The marker is position:fixed inside a shadow root, so "is it on the element?"
// is only answerable by comparing live rects after the browser has actually scrolled.
(() => {
  const result = { pass: false };

  function frame() {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  // Wait until scrolling stops changing, so the assertion runs against a settled viewport rather
  // than a guessed delay. Capped so a stuck scroll fails loudly instead of hanging the fixture.
  async function settle(maxFrames = 90) {
    let previous = NaN;
    let stable = 0;
    for (let i = 0; i < maxFrames; i += 1) {
      await frame();
      const current = window.scrollY;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) return true;
    }
    return false;
  }

  function marker() {
    const host = document.querySelector(".lavish-annotation-root");
    if (!host || !host.shadowRoot) return null;
    return host.shadowRoot.querySelector(".lavish-reveal-marker");
  }

  // How far the marker's top-left sits from the element it is supposed to be framing.
  function drift(target) {
    const node = marker();
    if (!node) return null;
    const a = node.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    return { dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top) };
  }

  async function main() {
    const target = document.getElementById("target");
    window.scrollTo(0, 0);
    await settle();

    result.startedAtTop = window.scrollY === 0;
    result.targetBelowFold = target.getBoundingClientRect().top > window.innerHeight;

    window.postMessage({ type: "lavish:revealElement", selector: "#target" }, "*");

    result.scrollSettled = await settle();
    result.scrolledBy = Math.round(window.scrollY);
    result.markerPresent = Boolean(marker());

    // The original symptom: after a smooth scroll, is the box actually on the element?
    result.afterScroll = drift(target);

    // Deterministic proof of tracking, independent of how the browser implements smooth
    // scrolling: a one-shot rect read can never survive a scroll that happens after it.
    window.scrollBy(0, 240);
    await settle();
    result.afterFurtherScroll = drift(target);

    result.pass = true;
  }

  // Report over HTTP rather than through --dump-dom: the SDK keeps requestAnimationFrame loops
  // running, so the renderer is never idle and Chrome's --virtual-time-budget never drains.
  main()
    .catch((error) => {
      result.error = String((error && error.stack) || error);
    })
    .then(() => {
      document.body.dataset.result = JSON.stringify(result);
      return fetch("/result", { method: "POST", body: JSON.stringify(result) });
    })
    .catch(() => {});
})();
