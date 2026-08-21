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

// The attribute string is not the rendered span. HTML's rules for parsing a non-negative integer
// stop at the first non-digit, so `rowspan="2x"` really does span two rows even though `Number`
// reads it as `NaN` - reporting no span there would emit labels for a grid that is actually
// shifted. Take the span the browser already parsed whenever there is one, parse the attribute the
// same way when there is not, and let a value that parses to nothing fall back to the attribute's
// default, exactly as a browser does.
export function tableSpanValue(cell, name, parsed) {
  if (typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0) return parsed;
  const digits = /^[\t\n\f\r ]*(\d+)/.exec(String(cell?.getAttribute?.(name) ?? ""));
  return digits ? Number(digits[1]) : null;
}

export function tableColumnSpan(cell) {
  const span = tableSpanValue(cell, "colspan", cell?.colSpan);
  return span !== null && span >= 1 ? span : 1;
}

// `rowspan="0"` is valid HTML - it spans to the end of the row group - and browsers report
// `cell.rowSpan === 0` for it. A finite span shifts only the following rows it actually reaches.
export function tableCellSpansRows(cell, rowDistance = 1) {
  const span = tableSpanValue(cell, "rowspan", cell?.rowSpan);
  const renderedSpan = span === null || span < 0 ? 1 : span;
  return renderedSpan === 0 || renderedSpan > rowDistance;
}

// A rowspan is clipped to its own row group, so the group is the widest span of rows one can
// shift. Rows outside it - a `<th rowspan="2">` grouped header in `<thead>`, say - leave this row
// laid out from column 0.
export function tableRowGroup(table, row) {
  let ancestor = row?.parentElement || null;
  while (ancestor && ancestor !== table) {
    const tag = tableTagName(ancestor);
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") return ancestor;
    ancestor = ancestor.parentElement;
  }
  return table;
}

// A span starting in an earlier row of this row's own group means its DOM order is no longer its
// rendered column order, and a per-row walk cannot model that. A finite span shifts only rows
// within its declared range, while rowspan=0 reaches the end of the group; a row that cannot be
// placed in its own group at all is unprovable the same way.
export function tableRowIsShifted(table, row) {
  if (!table || !row) return true;
  const rows = tableRowsIn(tableRowGroup(table, row));
  const index = rows.indexOf(row);
  if (index < 0) return true;
  for (let i = 0; i < index; i += 1) {
    for (const cell of tableRowCells(rows[i])) {
      if (tableCellSpansRows(cell, index - i)) return true;
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
  const shifted = tableRowIsShifted(table, row);
  // A shifted header row cannot name columns either, even when the clicked row is laid out
  // straight: its own cells are no longer in column order, so nothing can be matched against them.
  const gridShifted = shifted || (headerRow ? tableRowIsShifted(table, headerRow) : false);
  const declaredHeading = cells.find(
    (candidate) =>
      tableTagName(candidate) === "th" && String(candidate.getAttribute?.("scope") || "").toLowerCase() === "row",
  );
  // No header row names a record, so none of them gets a row label - not just the one row
  // `tableHeaderRow` picks. In a grouped header the first cell of any other header row is a
  // sibling column header, and naming the click after it reads as a row name that does not exist.
  // A row of nothing but `th` is that signal without a `<thead>`, which browsers never insert.
  // `scope="row"` is an author declaration and outranks both this and a shifted row, but taking
  // the first DOM cell is a positional guess that a rowspan reaching into this row invalidates -
  // it can even name the clicked cell after itself.
  const allHeaderCells = cells.every((candidate) => tableTagName(candidate) === "th");
  const inHeaderSection = headerRow === row || Boolean(cell.closest?.("thead"));
  const rowHeading = inHeaderSection ? null : declaredHeading || (allHeaderCells || shifted ? null : cells[0]);

  return {
    type: "table-cell",
    selector: String(selectorFor(cell) || "").slice(0, 240),
    rowLabel: tableText(rowHeading),
    columnLabel: gridShifted ? "" : tableColumnLabel(headerRow, cells, index),
    text: tableText(cell),
  };
}
