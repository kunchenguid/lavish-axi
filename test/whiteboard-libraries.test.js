import assert from "node:assert/strict";
import test from "node:test";

import {
  findLibraryItem,
  libraryIconSignature,
  libraryIdFromFileName,
  parseExcalidrawLibrary,
  parseLibraryIconDirectives,
  toExcalidrawLibraryItems,
} from "../src/whiteboard-libraries.js";

const square = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, ...extra });
const label = (id, text) => ({ id, type: "text", x: 0, y: 12, width: 40, height: 20, text });

test("libraryIdFromFileName slugs the basename without its extension", () => {
  assert.equal(libraryIdFromFileName("AWS Architecture Icons.excalidrawlib"), "aws-architecture-icons");
  assert.equal(libraryIdFromFileName("system_design.excalidrawlib"), "system-design");
  assert.equal(libraryIdFromFileName("--Odd!!Name--.excalidrawlib"), "odd-name");
  assert.equal(libraryIdFromFileName("....excalidrawlib"), "");
});

test("parseExcalidrawLibrary reads v2 items with names and refs", () => {
  const library = parseExcalidrawLibrary(
    JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [
        { id: "a", status: "published", name: "AWS Lambda", elements: [square("s1")] },
        { id: "b", status: "published", name: "  Amazon   DynamoDB ", elements: [square("s2")] },
      ],
    }),
    { id: "aws" },
  );
  assert.equal(library.id, "aws");
  assert.deepEqual(
    library.items.map((item) => [item.ref, item.name]),
    [
      ["aws/AWS Lambda", "AWS Lambda"],
      ["aws/Amazon DynamoDB", "Amazon DynamoDB"],
    ],
  );
  assert.equal(library.items[0].elements[0].id, "s1");
});

test("parseExcalidrawLibrary reads v1 element arrays and derives names", () => {
  const library = parseExcalidrawLibrary(
    JSON.stringify({
      type: "excalidrawlib",
      version: 1,
      library: [[square("s1"), label("t1", "Load\nBalancer")], [square("s2")], [square("s3")], []],
    }),
    { id: "sys" },
  );
  assert.deepEqual(
    library.items.map((item) => item.name),
    ["Load Balancer", "item-2", "item-3"],
  );
});

test("parseExcalidrawLibrary names unnamed items after their title text", () => {
  const text = (value, fontSize) => ({
    id: value,
    type: "text",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    text: value,
    fontSize,
  });
  const library = parseExcalidrawLibrary(
    JSON.stringify({
      library: [
        [square("a"), text("{", 29), text("}", 29), text("Document DB", 18)],
        [square("b"), text("Key", 6), text("Key", 6), text("Value", 6), text("Cache", 22)],
        [square("c"), text("Mobile", 16), text("Lorem ipsum dolor sit amet,\nconsectetur adipiscing elit", 2.5)],
        [
          square("d"),
          text("Web Application", 16.5),
          ...["G", "o", "o", "g", "l", "e"].map((letter) => text(letter, 13.7)),
        ],
        [square("e"), text("7", 10), text("Archive", 17)],
        [square("f"), text("?", 20)],
      ],
    }),
    { id: "sys" },
  );
  assert.deepEqual(
    library.items.map((item) => item.name),
    ["Document DB", "Cache", "Mobile", "Web Application", "Archive", "item-6"],
  );
});

test("parseExcalidrawLibrary de-duplicates names case-insensitively and drops deleted elements", () => {
  const library = parseExcalidrawLibrary(
    JSON.stringify({
      libraryItems: [
        { name: "Queue", elements: [square("a")] },
        { name: "queue", elements: [square("b"), square("gone", { isDeleted: true })] },
        { name: "Ghost", elements: [square("c", { isDeleted: true })] },
      ],
    }),
    { id: "sys" },
  );
  assert.deepEqual(
    library.items.map((item) => item.ref),
    ["sys/Queue", "sys/queue #2"],
  );
  assert.deepEqual(
    library.items[1].elements.map((element) => element.id),
    ["b"],
  );
});

test("parseExcalidrawLibrary rejects malformed files with a reason", () => {
  assert.throws(() => parseExcalidrawLibrary("{", { id: "x" }), /not valid JSON/);
  assert.throws(() => parseExcalidrawLibrary('{"elements":[]}', { id: "x" }), /no libraryItems or library array/);
  assert.throws(() => parseExcalidrawLibrary('{"libraryItems":[]}', { id: "x" }), /no usable items/);
});

test("findLibraryItem matches refs case-insensitively with collapsed whitespace", () => {
  const libraries = [
    parseExcalidrawLibrary(JSON.stringify({ libraryItems: [{ name: "AWS Lambda", elements: [square("a")] }] }), {
      id: "aws",
    }),
  ];
  assert.equal(findLibraryItem(libraries, "aws/aws   lambda")?.name, "AWS Lambda");
  assert.equal(findLibraryItem(libraries, "AWS/AWS Lambda")?.name, "AWS Lambda");
  assert.equal(findLibraryItem(libraries, "aws/Lambda"), null);
  assert.equal(findLibraryItem(libraries, "other/AWS Lambda"), null);
});

test("parseLibraryIconDirectives reads flowchart icon comments only", () => {
  const source = [
    "%%{init: {'theme': 'dark'}}%%",
    "flowchart LR",
    "  %% lavish-icon api aws/AWS Lambda",
    "  %%lavish-icon   db   aws/Amazon DynamoDB  ",
    "  %% lavish-icon broken",
    "  %% a normal comment",
    "  api[Orders API] --> db[(Orders)]",
  ].join("\n");
  assert.deepEqual(parseLibraryIconDirectives(source), [
    { nodeId: "api", ref: "aws/AWS Lambda" },
    { nodeId: "db", ref: "aws/Amazon DynamoDB" },
  ]);
  assert.deepEqual(parseLibraryIconDirectives("graph TD\n%% lavish-icon a x/y\na-->b"), [{ nodeId: "a", ref: "x/y" }]);
  assert.deepEqual(parseLibraryIconDirectives("sequenceDiagram\n%% lavish-icon a x/y\na->>b: hi"), []);
  assert.deepEqual(parseLibraryIconDirectives("---\ntitle: T\n---\nflowchart TD\n%% lavish-icon a x/y\na-->b"), [
    { nodeId: "a", ref: "x/y" },
  ]);
});

test("libraryIconSignature is empty without directives and tracks referenced items", () => {
  const make = (width) => [
    parseExcalidrawLibrary(JSON.stringify({ libraryItems: [{ name: "Lambda", elements: [square("a", { width })] }] }), {
      id: "aws",
    }),
  ];
  assert.equal(libraryIconSignature("flowchart TD\n a-->b", make(10)), "");
  const source = "flowchart TD\n%% lavish-icon a aws/Lambda\n a-->b";
  assert.notEqual(libraryIconSignature(source, make(10)), "");
  assert.equal(libraryIconSignature(source, make(10)), libraryIconSignature(source, make(10)));
  assert.notEqual(libraryIconSignature(source, make(10)), libraryIconSignature(source, make(20)));
  assert.notEqual(libraryIconSignature(source, make(10)), libraryIconSignature(source, []));
});

test("toExcalidrawLibraryItems stamps every element with its library ref", () => {
  const libraries = [
    parseExcalidrawLibrary(JSON.stringify({ libraryItems: [{ name: "Lambda", elements: [square("a")] }] }), {
      id: "aws",
    }),
  ];
  const [item] = toExcalidrawLibraryItems(libraries);
  assert.equal(item.name, "Lambda");
  assert.equal(item.status, "published");
  assert.equal(item.id, "lavish:aws/Lambda");
  assert.deepEqual(item.elements[0].customData, { lavishLibraryRef: "aws/Lambda" });
  assert.equal(libraries[0].items[0].elements[0].customData, undefined);
});

test("toExcalidrawLibraryItems groups multi-element items that are not grouped already", () => {
  const libraries = [
    parseExcalidrawLibrary(
      JSON.stringify({
        libraryItems: [
          { name: "Loose", elements: [square("a"), square("b")] },
          { name: "Grouped", elements: [square("c", { groupIds: ["g"] }), square("d", { groupIds: ["g"] })] },
          { name: "Single", elements: [square("e")] },
        ],
      }),
      { id: "sys" },
    ),
  ];
  const [loose, grouped, single] = toExcalidrawLibraryItems(libraries);
  assert.deepEqual(
    loose.elements.map((element) => element.groupIds),
    [["lavish-item:sys/Loose"], ["lavish-item:sys/Loose"]],
  );
  assert.deepEqual(
    grouped.elements.map((element) => element.groupIds),
    [["g"], ["g"]],
  );
  assert.deepEqual(single.elements[0].groupIds, []);
});
