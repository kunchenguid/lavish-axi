export const SHARE_DISABLED_MESSAGE =
  "Hosted sharing is disabled in this installation; use `lavish-axi export` for a portable local copy.";

/**
 * @param {string} _html
 * @param {Record<string, unknown>} [_options]
 * @returns {Promise<never>}
 */
export async function publishToHtmlApp(_html, _options = {}) {
  throw new Error(SHARE_DISABLED_MESSAGE);
}
