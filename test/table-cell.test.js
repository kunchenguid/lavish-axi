import assert from "node:assert/strict";
import test from "node:test";

import { tableCellTarget } from "../src/table-cell.js";

function node(tag, attrs = {}, children = []) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? String(attrs[name]) : null;
    },
  };
  if (attrs.textContent) el.textContent = attrs.textContent;
  for (const child of children) {
    child.parentElement = el;
    el.children.push(child);
  }
  return el;
}

function row(cells, tag = "td") {
  return node(
    "tr",
    {},
    cells.map((cell) => (typeof cell === "string" ? node(tag, { textContent: cell }) : cell)),
  );
}

test("tableCellTarget names a filtered table cell by row and column instead of visible position", () => {
  const target = node("td", { textContent: "Drive, Neovide, Cursor, Alacritty" });
  node("table", {}, [
    node("thead", {}, [row(["Permission / setting", "Visible state", "Database evidence"], "th")]),
    node("tbody", {}, [row(["Contacts", "None", "No grants"]), row(["Media & Apple Music", "4 apps", target])]),
  ]);

  assert.deepEqual(
    tableCellTarget(target, () => "table > tbody > tr:nth-of-type(2) > td:nth-of-type(3)"),
    {
      type: "table-cell",
      selector: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(3)",
      rowLabel: "Media & Apple Music",
      columnLabel: "Database evidence",
      text: "Drive, Neovide, Cursor, Alacritty",
    },
  );
});

test("tableCellTarget reads header cells from the first row when the table has no thead", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("tbody", {}, [row(["Permission", "Visible state"], "th"), row(["Media & Apple Music", target])]),
  ]);

  assert.partialDeepStrictEqual(tableCellTarget(target), {
    rowLabel: "Media & Apple Music",
    columnLabel: "Visible state",
  });
});

test("tableCellTarget does not treat a leading data row as column headers", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [node("tbody", {}, [row(["Contacts", "None"]), row(["Media & Apple Music", target])])]);

  assert.partialDeepStrictEqual(tableCellTarget(target), {
    rowLabel: "Media & Apple Music",
    columnLabel: "",
  });
});

test("tableCellTarget stays silent about the column when a grouped header spans it", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [
      node("tr", {}, [node("th", { textContent: "Permission" }), node("th", { colspan: "2", textContent: "State" })]),
    ]),
    node("tbody", {}, [row(["Media & Apple Music", target, node("td", { textContent: "Drive" })])]),
  ]);

  assert.partialDeepStrictEqual(tableCellTarget(target), {
    rowLabel: "Media & Apple Music",
    columnLabel: "",
  });
});

test("tableCellTarget names the column from the leaf header row under a grouped header", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [
      node("tr", {}, [node("th", { textContent: "Permission" }), node("th", { colspan: "2", textContent: "State" })]),
      row(["Permission", "Visible state", "Database evidence"], "th"),
    ]),
    node("tbody", {}, [row(["Media & Apple Music", target, node("td", { textContent: "Drive" })])]),
  ]);

  assert.partialDeepStrictEqual(tableCellTarget(target), { columnLabel: "Visible state" });
});

test("tableCellTarget stays silent about the column when a rowspan shifts the grid", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [row(["Permission", "Visible state"], "th")]),
    node("tbody", {}, [
      node("tr", {}, [node("td", { rowspan: "2", textContent: "Media" }), node("td", { textContent: "None" })]),
      node("tr", {}, [target]),
    ]),
  ]);

  assert.partialDeepStrictEqual(tableCellTarget(target), { columnLabel: "" });
});

test("tableCellTarget stays silent about the column when the row does not span the header width", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [row(["Permission", "Visible state", "Database evidence"], "th")]),
    node("tbody", {}, [row(["Media & Apple Music", target])]),
  ]);

  assert.partialDeepStrictEqual(tableCellTarget(target), { columnLabel: "" });
});

test("tableCellTarget prefers an explicit scope=row heading over the first cell", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [row(["Index", "Permission", "Visible state"], "th")]),
    node("tbody", {}, [
      node("tr", {}, [
        node("td", { textContent: "7" }),
        node("th", { scope: "row", textContent: "Media & Apple Music" }),
        target,
      ]),
    ]),
  ]);

  assert.partialDeepStrictEqual(tableCellTarget(target), {
    rowLabel: "Media & Apple Music",
    columnLabel: "Visible state",
  });
});

test("tableCellTarget does not label a header-row click with a data row heading", () => {
  const target = node("th", { textContent: "Visible state" });
  node("table", {}, [
    node("thead", {}, [node("tr", {}, [node("th", { textContent: "Permission" }), target])]),
    node("tbody", {}, [row(["Media & Apple Music", "4 apps"])]),
  ]);

  assert.partialDeepStrictEqual(tableCellTarget(target), {
    rowLabel: "",
    columnLabel: "Visible state",
  });
});

test("tableCellTarget bounds every derived string it puts on the wire", () => {
  const long = "x".repeat(1000);
  const target = node("td", { textContent: long });
  node("table", {}, [node("thead", {}, [row(["Permission", long], "th")]), node("tbody", {}, [row([long, target])])]);

  const result = tableCellTarget(target, () => long);

  assert.equal(result.rowLabel.length, 240);
  assert.equal(result.columnLabel.length, 240);
  assert.equal(result.text.length, 240);
  assert.equal(result.selector.length, 240);
});

test("tableCellTarget ignores elements outside a table", () => {
  const target = node("p", { textContent: "not a cell" });
  node("div", {}, [target]);

  assert.equal(tableCellTarget(target), null);
});
