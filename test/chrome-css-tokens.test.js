import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chromeCss = await readFile(new URL("../src/chrome.css", import.meta.url), "utf8");

const NAMED_COLORS =
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
  burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod
  darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
  firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
  lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue
  saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/);

const COLOR_LITERAL = new RegExp(
  [
    String.raw`#[0-9a-f]{3,8}\b`,
    String.raw`(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(`,
    String.raw`var\(--(?:ink|steel|brass|cream|sage|amber|rust)-`,
    String.raw`(?<![\w-])(?:${NAMED_COLORS.join("|")})(?![\w-])`,
  ].join("|"),
  "i",
);

// The first `:root { ... }` block owns the palette and the role tokens built on it.
function splitRootBlock(css) {
  const start = css.indexOf(":root {");
  assert.notEqual(start, -1, "chrome.css must open with a :root token block");
  const end = css.indexOf("\n}", start);
  return { root: css.slice(start, end + 2), rules: css.slice(end + 2) };
}

test("chrome.css rules read colors from role tokens, never the raw palette or a color literal", () => {
  const { rules } = splitRootBlock(chromeCss);
  const offenders = [];
  for (const [, selector, body] of rules.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const declaration of body.split(";")) {
      if (COLOR_LITERAL.test(declaration)) {
        offenders.push(`${selector.trim().replace(/\s+/g, " ")} { ${declaration.trim()}; }`);
      }
    }
  }
  // The artifact frame shows the browser's default page color until the artifact paints its
  // own; that is the artifact's canvas, not chrome styling, so it stays literal.
  assert.deepEqual(offenders, [".frame { background: #fff; }", "iframe { background: white; }"]);
});

test("body.lavish takes color-scheme from the --color-scheme root token", () => {
  const { root, rules } = splitRootBlock(chromeCss);
  assert.match(root, /--color-scheme:\s*dark;/);
  assert.match(rules, /body\.lavish\s*\{\s*color-scheme:\s*var\(--color-scheme\);/);
});
