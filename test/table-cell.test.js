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
    closest(selectorList) {
      const tags = selectorList.split(",").map((part) => part.trim());
      let current = el;
      while (current) {
        if (tags.includes(current.tagName.toLowerCase())) return current;
        current = current.parentElement;
      }
      return null;
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

function labels(element) {
  const target = tableCellTarget(element);
  return { rowLabel: target?.rowLabel, columnLabel: target?.columnLabel };
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

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "Visible state" });
});

test("tableCellTarget does not treat a leading data row as column headers", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [node("tbody", {}, [row(["Contacts", "None"]), row(["Media & Apple Music", target])])]);

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "" });
});

test("tableCellTarget stays silent about the column when a grouped header spans it", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [
      node("tr", {}, [node("th", { textContent: "Permission" }), node("th", { colspan: "2", textContent: "State" })]),
    ]),
    node("tbody", {}, [row(["Media & Apple Music", target, node("td", { textContent: "Drive" })])]),
  ]);

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "" });
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

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "Visible state" });
});

// The row's own spans still sum to the header width, so only the rowspan above it reveals that
// this cell renders one column to the right. Positional matching alone would name the column
// "Permission" and the row "4 apps" - the clicked cell's own value passed off as the row's name.
function shiftedByRowSpan(target, rowspan = "2") {
  node("table", {}, [
    node("thead", {}, [row(["Permission", "Visible state"], "th")]),
    node("tbody", {}, [
      node("tr", {}, [node("td", { rowspan, textContent: "Media" }), node("td", { textContent: "None" })]),
      node("tr", {}, [target, node("td", { textContent: "extra" })]),
    ]),
  ]);
  return target;
}

test("tableCellTarget names neither coordinate when a rowspan above shifts the row right", () => {
  const target = shiftedByRowSpan(node("td", { textContent: "4 apps" }));

  assert.deepEqual(labels(target), { rowLabel: "", columnLabel: "" });
});

test("tableCellTarget treats rowspan=0 as spanning to the end of the row group", () => {
  const target = shiftedByRowSpan(node("td", { textContent: "4 apps" }), "0");

  assert.deepEqual(labels(target), { rowLabel: "", columnLabel: "" });
});

test("tableCellTarget keeps a declared scope=row heading even when a rowspan shifts the grid", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [row(["Permission", "Visible state"], "th")]),
    node("tbody", {}, [
      node("tr", {}, [node("td", { rowspan: "2", textContent: "Media" }), node("td", { textContent: "None" })]),
      node("tr", {}, [node("th", { scope: "row", textContent: "Media & Apple Music" }), target]),
    ]),
  ]);

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "" });
});

test("tableCellTarget stays silent about the column when the row does not span the header width", () => {
  const target = node("td", { textContent: "4 apps" });
  node("table", {}, [
    node("thead", {}, [row(["Permission", "Visible state", "Database evidence"], "th")]),
    node("tbody", {}, [row(["Media & Apple Music", target])]),
  ]);

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "" });
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

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "Visible state" });
});

test("tableCellTarget does not label a header-row click with a data row heading", () => {
  const target = node("th", { textContent: "Visible state" });
  node("table", {}, [
    node("thead", {}, [node("tr", {}, [node("th", { textContent: "Permission" }), target])]),
    node("tbody", {}, [row(["Media & Apple Music", "4 apps"])]),
  ]);

  assert.deepEqual(labels(target), { rowLabel: "", columnLabel: "Visible state" });
});

// The clicked cell sits in the upper row of a grouped header, which `tableHeaderRow` does not
// pick as the header row. Its first sibling is another column header, never this "row" 's name.
test("tableCellTarget does not name an upper grouped-header row after its first cell", () => {
  const target = node("th", { colspan: "2", textContent: "State" });
  node("table", {}, [
    node("thead", {}, [
      node("tr", {}, [node("th", { textContent: "Permission" }), target]),
      row(["Permission", "Visible state", "Database evidence"], "th"),
    ]),
    node("tbody", {}, [row(["Media & Apple Music", "4 apps", "Drive"])]),
  ]);

  assert.deepEqual(labels(target), { rowLabel: "", columnLabel: "" });
});

test("tableCellTarget reads an empty rowspan attribute the way a browser does, as 1", () => {
  const target = node("td", { textContent: "Drive" });
  node("table", {}, [
    node("thead", {}, [row(["Permission", "Visible state", "Database evidence"], "th")]),
    node("tbody", {}, [
      node("tr", {}, [
        node("td", { textContent: "Media & Apple Music" }),
        node("td", { rowspan: "", textContent: "4 apps" }),
        target,
      ]),
    ]),
  ]);

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "Database evidence" });
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

test("tableCellTarget reads only its own table when a cell holds a nested table", () => {
  const target = node("td", { textContent: "4 apps" });
  const nested = node("table", {}, [
    node("tbody", {}, [
      node("tr", {}, [node("td", { rowspan: "2", textContent: "nested span" }), node("td", { textContent: "a" })]),
      node("tr", {}, [node("td", { textContent: "b" })]),
    ]),
  ]);
  node("table", {}, [
    node("thead", {}, [row(["Permission", "Visible state"], "th")]),
    node("tbody", {}, [row([node("td", { textContent: "Media & Apple Music" }, [nested]), target])]),
  ]);

  assert.deepEqual(labels(target), { rowLabel: "Media & Apple Music", columnLabel: "Visible state" });
});

test("tableCellTarget ignores elements outside a table", () => {
  const target = node("p", { textContent: "not a cell" });
  node("div", {}, [target]);

  assert.equal(tableCellTarget(target), null);
});
