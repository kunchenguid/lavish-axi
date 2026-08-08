/* global document, window */

// Drives the injected SDK's annotation badges in a real browser: badges are position:fixed inside
// a shadow root, so "does the dot stay on its element?" is only answerable from live rects.
(() => {
  const result = { pass: false };

  function frame() {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  async function settle(maxFrames = 240) {
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

  function badges() {
    const host = document.querySelector(".lavish-annotation-root");
    if (!host || !host.shadowRoot) return [];
    return [...host.shadowRoot.querySelectorAll(".lavish-annotation-badge")];
  }

  function drift(target) {
    const node = badges()[0];
    if (!node) return null;
    const a = node.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    return { dx: Math.abs(a.left - (b.right - 6)), dy: Math.abs(a.top - (b.top - 6)) };
  }

  // Repositioning is event-driven and bounded, so give it a fixed number of frames to converge
  // rather than guessing a settling delay. A badge that never tracks its element never converges,
  // so the reported drift stays the real one and the assertion still fails on a regression.
  async function settledDrift(target, maxFrames = 120) {
    let last = drift(target);
    for (let i = 0; i < maxFrames; i += 1) {
      if (last && last.dx <= 1 && last.dy <= 1) return last;
      await frame();
      last = drift(target);
    }
    return last;
  }

  async function main() {
    const target = document.getElementById("target");
    window.scrollTo(0, 0);
    await settle();

    window.postMessage({ type: "lavish:setAnnotationTargets", targets: [{ id: "ann-1", selector: "#target" }] }, "*");
    await frame();

    result.badgeCount = badges().length;
    result.initial = await settledDrift(target);

    window.scrollBy(0, 300);
    await settle();
    result.afterScroll = await settledDrift(target);

    // Let the post-scroll settle window lapse first, so the next stage cannot be carried by frames
    // that the scroll already scheduled.
    for (let i = 0; i < 45; i += 1) await frame();

    // Resize the annotated element itself, which moves the badge's anchor with no scroll or window
    // resize event to react to - only observing the element catches this.
    target.style.width = "240px";
    result.afterLayoutShift = await settledDrift(target);

    result.pass = true;
  }

  main()
    .catch((error) => {
      result.error = String((error && error.stack) || error);
    })
    .then(() => fetch("/result", { method: "POST", body: JSON.stringify(result) }))
    .catch(() => {});
})();
