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

export function tableColumnSpan(cell) {
  const attribute = cell?.getAttribute ? cell.getAttribute("colspan") : null;
  const raw = Number(attribute ?? cell?.colSpan);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1;
}

// `rowspan="0"` is valid HTML - it spans to the end of the row group - and browsers report
// `cell.rowSpan === 0` for it, so anything but a plain 1 pushes later rows sideways. An empty or
// blank attribute is not a zero: browsers parse it as 1, so defer to the parsed DOM property.
export function tableCellSpansRows(cell) {
  const attribute = cell?.getAttribute ? cell.getAttribute("rowspan") : null;
  const declared = attribute === null || String(attribute).trim() === "" ? cell?.rowSpan : attribute;
  const raw = Number(declared);
  return Number.isFinite(raw) && raw !== 1;
}

// A rowspan anywhere means a row's DOM order is no longer its rendered column order, and a
// per-row walk cannot model that. Both coordinates are then unprovable, not just the column.
export function tableHasRowSpan(table) {
  for (const row of tableRowsIn(table)) {
    for (const cell of tableRowCells(row)) {
      if (tableCellSpansRows(cell)) return true;
    }
  }
  return false;
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
// a label only when the clicked cell's grid range provably matches exactly one header cell: a row
// whose spans do not sum to the header's is not the same grid, and a cell straddling a grouped
// header names nothing. The caller rules out rowspan-shifted grids before calling.
export function tableColumnLabel(headerRow, cells, index) {
  if (!headerRow) return "";
  const headerCells = tableRowCells(headerRow);
  const width = (cell) => tableColumnSpan(cell);
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
  const cell = element?.closest?.("td,th");
  const row = cell?.closest?.("tr");
  const table = row?.closest?.("table");
  if (!cell || !row || !table) return null;

  const cells = tableRowCells(row);
  const index = cells.indexOf(cell);
  if (index < 0) return null;

  const headerRow = tableHeaderRow(table);
  const shifted = tableHasRowSpan(table);
  const declaredHeading = cells.find(
    (candidate) =>
      tableTagName(candidate) === "th" && String(candidate.getAttribute?.("scope") || "").toLowerCase() === "row",
  );
  // No row inside the header section names a record, so none of them gets a row label - not just
  // the leaf row `tableHeaderRow` picks. In a grouped header the first cell of an upper row is a
  // sibling column header, and naming the click after it reads as a row name that does not exist.
  // Below the header, `scope="row"` is an author declaration and survives a shifted grid, but
  // taking the first DOM cell is a positional guess that a rowspan above this row invalidates -
  // it can even name the clicked cell after itself.
  const inHeaderSection = headerRow === row || Boolean(cell.closest?.("thead"));
  const rowHeading = inHeaderSection ? null : declaredHeading || (shifted ? null : cells[0]);

  return {
    type: "table-cell",
    selector: String(selectorFor(cell) || "").slice(0, 240),
    rowLabel: tableText(rowHeading),
    columnLabel: shifted ? "" : tableColumnLabel(headerRow, cells, index),
    text: tableText(cell),
  };
}
