// Semantic naming for annotated table cells. Positional selectors stay the locator, but a
// filtered or sorted table makes their row numbers read wrong to a reviewer, so an annotation
// also carries the visible row and column names.
//
// Every helper here is serialized wholesale into the artifact SDK bundle by `createSdkJs`, so
// each one may reference only its own arguments, browser globals, or its sibling exports.

export function tableTagName(element) {
  return String(element?.tagName || element?.nodeName || "").toLowerCase();
}

export function tableText(element) {
  return String(element?.innerText || element?.textContent || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export function closestTableAncestor(element, names) {
  let current = element;
  while (current && current.nodeType === 1) {
    if (names.has(tableTagName(current))) return current;
    current = current.parentElement;
  }
  return null;
}

// Rows of one table only. Descending into a cell would both walk the whole document subtree and
// collect a nested table's rows, which would then be read as this table's header or spans.
export function tableRowsIn(element) {
  const rows = [];
  for (const child of Array.from(element?.children || [])) {
    const tag = tableTagName(child);
    if (tag === "td" || tag === "th" || tag === "table") continue;
    if (tag === "tr") rows.push(child);
    else rows.push(...tableRowsIn(child));
  }
  return rows;
}

export function tableRowCells(row) {
  return Array.from(row?.children || []).filter((cell) => {
    const tag = tableTagName(cell);
    return tag === "td" || tag === "th";
  });
}

export function tableCellSpan(cell, name) {
  const attribute = cell?.getAttribute ? cell.getAttribute(name) : null;
  const raw = Number(attribute ?? (name === "colspan" ? cell?.colSpan : cell?.rowSpan));
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1;
}

// Browsers auto-insert <tbody> but never <thead>, so a hand-written table commonly keeps its
// header cells in the first <tr>. Adopt that row only when it is unambiguously a header - every
// cell a <th> - rather than guessing that the first data row names the columns.
export function tableHeaderRow(table) {
  const head = Array.from(table?.children || []).find((child) => tableTagName(child) === "thead");
  if (head) return tableRowsIn(head).at(-1) || null;
  const first = tableRowsIn(table)[0];
  const cells = tableRowCells(first);
  return cells.length > 0 && cells.every((cell) => tableTagName(cell) === "th") ? first : null;
}

// A confidently wrong column name reads as authoritative and is worse than none, so this returns
// a label only when the clicked cell's grid range provably matches exactly one header cell:
// rowspan anywhere shifts the grid in ways a per-row walk cannot model, a row whose spans do not
// sum to the header's is not the same grid, and a cell straddling a grouped header names nothing.
export function tableColumnLabel(table, headerRow, cells, index) {
  if (!headerRow) return "";
  for (const row of tableRowsIn(table)) {
    for (const cell of tableRowCells(row)) {
      if (tableCellSpan(cell, "rowspan") > 1) return "";
    }
  }

  const headerCells = tableRowCells(headerRow);
  const width = (cell) => tableCellSpan(cell, "colspan");
  const headerWidth = headerCells.reduce((sum, cell) => sum + width(cell), 0);
  const rowWidth = cells.reduce((sum, cell) => sum + width(cell), 0);
  if (headerWidth === 0 || headerWidth !== rowWidth) return "";

  let start = 0;
  for (let i = 0; i < index; i += 1) start += width(cells[i]);
  const end = start + width(cells[index]);

  let cursor = 0;
  for (const header of headerCells) {
    const next = cursor + width(header);
    if (cursor === start && next === end) return tableText(header);
    if (start < next) return "";
    cursor = next;
  }
  return "";
}

export function tableCellTarget(element, selectorFor = (_element) => "") {
  const cell = closestTableAncestor(element, new Set(["td", "th"]));
  const row = closestTableAncestor(cell?.parentElement, new Set(["tr"]));
  const table = closestTableAncestor(row?.parentElement, new Set(["table"]));
  if (!cell || !row || !table) return null;

  const cells = tableRowCells(row);
  const index = cells.indexOf(cell);
  if (index < 0) return null;

  const headerRow = tableHeaderRow(table);
  // A click in the header row itself has no data row to name; labelling it with the first
  // column's header would present a header as if it were a record.
  const rowHeading =
    headerRow === row
      ? null
      : cells.find(
          (candidate) =>
            tableTagName(candidate) === "th" && String(candidate.getAttribute?.("scope") || "").toLowerCase() === "row",
        ) || cells[0];

  return {
    type: "table-cell",
    selector: String(selectorFor(cell) || "").slice(0, 240),
    rowLabel: tableText(rowHeading),
    columnLabel: tableColumnLabel(table, headerRow, cells, index),
    text: tableText(cell),
  };
}
