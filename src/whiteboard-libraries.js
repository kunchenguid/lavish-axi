// Pure helpers for user-supplied Excalidraw libraries (`.excalidrawlib`).
// Shared by the CLI, the server, and the bundled whiteboard frame, so nothing
// here touches the filesystem or a DOM. The directory loader lives in
// `whiteboard-library-store.js`.

export const LIBRARY_DIR_NAME = "excalidraw-libraries";
export const LIBRARY_FILE_EXTENSION = ".excalidrawlib";
export const LIBRARY_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const LIBRARY_TOTAL_MAX_BYTES = 25 * 1024 * 1024;
export const LIBRARY_MAX_ITEMS = 5000;
export const LIBRARY_REF_CUSTOM_DATA_KEY = "lavishLibraryRef";

const ITEM_NAME_MAX_CHARS = 80;
const ICON_DIRECTIVE_RE = /^\s*%%\s*lavish-icon\s+(\S+)\s+(.+?)\s*$/;
const FLOWCHART_HEADER_RE = /^(flowchart|graph)\b/i;

export function libraryIdFromFileName(fileName) {
  return String(fileName || "")
    .replace(/\.excalidrawlib$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collapseWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLibraryRef(ref) {
  return collapseWhitespace(ref).toLowerCase();
}

function liveElements(elements) {
  return (Array.isArray(elements) ? elements : []).filter(
    (element) => element && typeof element === "object" && typeof element.type === "string" && !element.isDeleted,
  );
}

// Unnamed items (common in v1 libraries) are named after their title: the
// largest text that has at least two letters or digits. That skips decoration
// such as braces, single glyphs, and small placeholder copy.
function derivedItemName(item, elements, index) {
  const explicit = collapseWhitespace(item?.name);
  if (explicit) return explicit.slice(0, ITEM_NAME_MAX_CHARS);
  let title = null;
  for (const element of elements) {
    if (element.type !== "text") continue;
    const text = collapseWhitespace(element.text);
    if ((text.match(/[\p{L}\p{N}]/gu) || []).length < 2) continue;
    const fontSize = Number(element.fontSize) || 0;
    if (!title || fontSize > title.fontSize) title = { text, fontSize };
  }
  if (title) return title.text.slice(0, ITEM_NAME_MAX_CHARS);
  return `item-${index + 1}`;
}

/**
 * Parse one `.excalidrawlib` file. v2 files carry `libraryItems` (objects with
 * `elements` and an optional `name`); v1 files carry `library`, an array of
 * element arrays. Item names fall back to the item's text, then to its position.
 * @param {string} text
 * @param {{ id: string }} options
 * @returns {{ id: string, items: { ref: string, name: string, elements: any[] }[] }}
 */
export function parseExcalidrawLibrary(text, { id }) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    throw new Error("not valid JSON");
  }
  let rawItems;
  if (Array.isArray(data?.libraryItems)) rawItems = data.libraryItems;
  else if (Array.isArray(data?.library)) rawItems = data.library.map((elements) => ({ elements }));
  else throw new Error("no libraryItems or library array");

  const items = [];
  const taken = new Set();
  rawItems.forEach((item, index) => {
    const elements = liveElements(item?.elements);
    if (elements.length === 0) return;
    const baseName = derivedItemName(item, elements, index);
    // Reserve every final name, so a generated "Queue #2" never collides with
    // an item that was already called "Queue #2".
    let name = baseName;
    for (let suffix = 2; taken.has(normalizeLibraryRef(name)); suffix += 1) name = `${baseName} #${suffix}`;
    taken.add(normalizeLibraryRef(name));
    items.push({ ref: `${id}/${name}`, name, elements });
  });
  if (items.length === 0) throw new Error("no usable items");
  return { id, items };
}

export function findLibraryItem(libraries, ref) {
  const wanted = normalizeLibraryRef(ref);
  if (!wanted) return null;
  for (const library of Array.isArray(libraries) ? libraries : []) {
    for (const item of Array.isArray(library?.items) ? library.items : []) {
      if (normalizeLibraryRef(item.ref) === wanted) return item;
    }
  }
  return null;
}

function isFlowchartSource(lines) {
  let inFrontmatter = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (index === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false;
      continue;
    }
    if (!line || line.startsWith("%%")) continue;
    return FLOWCHART_HEADER_RE.test(line);
  }
  return false;
}

/**
 * `%% lavish-icon <node-id> <library-id>/<item name>` lines in a flowchart.
 * Mermaid ignores `%%` comment lines, so these never change how plain Mermaid
 * renders the diagram.
 * @param {string} source
 * @returns {{ nodeId: string, ref: string }[]}
 */
export function parseLibraryIconDirectives(source) {
  const lines = String(source || "").split(/\r?\n/);
  if (!isFlowchartSource(lines)) return [];
  const directives = [];
  for (const line of lines) {
    const match = ICON_DIRECTIVE_RE.exec(line);
    if (match && match[2].includes("/")) directives.push({ nodeId: match[1], ref: collapseWhitespace(match[2]) });
  }
  return directives;
}

/**
 * A stable string describing which library items a diagram's directives
 * resolve to, or "" when the diagram has none. Folding it into the
 * whiteboard source hash re-converts an unmodified scene when the referenced
 * items change, while diagrams without directives keep their hashes.
 */
export function libraryIconSignature(source, libraries) {
  const directives = parseLibraryIconDirectives(source);
  if (directives.length === 0) return "";
  return JSON.stringify(
    directives.map(({ nodeId, ref }) => {
      const item = findLibraryItem(libraries, ref);
      return [nodeId, normalizeLibraryRef(ref), item ? JSON.stringify(item.elements) : null];
    }),
  );
}

/**
 * Library panel items for Excalidraw. Every element carries its ref in
 * customData, which Excalidraw keeps when an item is inserted, so edit
 * summaries can name an item the reviewer dropped onto the canvas.
 */
export function toExcalidrawLibraryItems(libraries) {
  const items = [];
  for (const library of Array.isArray(libraries) ? libraries : []) {
    for (const item of Array.isArray(library?.items) ? library.items : []) {
      // Excalidraw inserts an item's elements ungrouped unless the item
      // grouped them itself; a shared group makes a drop move as one icon.
      const extraGroup = item.elements.length > 1 && !sharedGroupId(item.elements) ? [`lavish-item:${item.ref}`] : [];
      items.push({
        id: `lavish:${item.ref}`,
        status: "published",
        created: 0,
        name: item.name,
        elements: item.elements.map((element) => ({
          ...element,
          groupIds: [...(Array.isArray(element.groupIds) ? element.groupIds : []), ...extraGroup],
          customData: { ...element.customData, [LIBRARY_REF_CUSTOM_DATA_KEY]: item.ref },
        })),
      });
    }
  }
  return items;
}

function sharedGroupId(elements) {
  const [first, ...rest] = elements;
  const candidates = Array.isArray(first?.groupIds) ? first.groupIds : [];
  return candidates.find((groupId) => rest.every((element) => element.groupIds?.includes(groupId))) || null;
}
