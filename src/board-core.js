// Pure board-canvas logic shared by the server (prompt normalization), the
// whiteboard frame bundle (scene building and the mark summary), and the
// tests. No DOM, no Node APIs.
//
// A board is shown as an Excalidraw scene: every card is an `embeddable`
// element whose content Hilight renders, and everything else on the canvas is
// the reviewer's own marks. The scene is saved in the whiteboard sidecar store
// under the reserved index `BOARD_SCENE_INDEX`, never in the board file.

export const BOARD_SCENE_INDEX = 999;
export const BOARD_PROMPT_TAG = "board";
export const BOARD_CANVAS_TARGET_TYPE = "board-canvas";
export const BOARD_CARD_TARGET_TYPE = "board-card";
export const CARD_ELEMENT_PREFIX = "card:";
export const LINK_ELEMENT_PREFIX = "link:";
export const CARD_LINK_PREFIX = "https://hilight.invalid/card/";

export const BOARD_LAYOUT = Object.freeze({
  gridGap: 56,
  gridColumns: 3,
  flowColumnGap: 160,
  flowRowGap: 96,
});

export const HTML_CARD_LAYOUT = Object.freeze({
  defaultWidth: 460,
  defaultHeight: 260,
  minWidth: 160,
  maxWidth: 2400,
  minHeight: 100,
  maxHeight: 1200,
  headerHeight: 36,
  borderHeight: 2,
});

export const HTML_CARD_THEMES = Object.freeze({
  light: Object.freeze({
    bg: "#ffffff",
    rgb: Object.freeze([255, 255, 255]),
    ink: "#1c1c1a",
    muted: "#6f6e69",
    line: "#dddcd6",
    accent: "#1f6fe0",
    surface: "#f5f4f0",
  }),
  dark: Object.freeze({
    bg: "#1b1c1e",
    rgb: Object.freeze([27, 28, 30]),
    ink: "#ecebe6",
    muted: "#a3a29c",
    line: "#2c2d30",
    accent: "#6aa8ff",
    surface: "#252629",
  }),
});

/**
 * Place the unplaced cards of one level given their current `w` and `h`. Cards
 * in a flow are laid out left to right by longest-path columns (back edges
 * dropped so retries still read left to right); every other card goes in a row
 * above. Cards with `placed: true` keep their coordinates and floating cards
 * sit below them.
 * @param {any[]} cards
 * @param {any[]} [flows]
 */
export function placeLevelCards(cards, flows = []) {
  const placed = cards.filter((card) => card.placed);
  const floating = cards.filter((card) => !card.placed);
  let originY = placed.length ? Math.max(...placed.map((card) => card.y + card.h)) + BOARD_LAYOUT.gridGap * 2 : 0;
  const originX = placed.length ? Math.min(...placed.map((card) => card.x)) : 0;
  const byId = new Map(floating.map((card) => [card.id, card]));
  // Each flow gets its own horizontal band, in the order the flows are
  // written; a card shared by two flows sits in the first flow's band.
  const bands = [];
  const bandOf = new Map();
  const edges = [];
  for (const flow of flows) {
    const band = [];
    for (const step of flow.steps || []) {
      const from = step.from?.card;
      const to = step.to?.card;
      if (!from || !to || from === to || !byId.has(from) || !byId.has(to)) continue;
      edges.push([from, to]);
      for (const id of [from, to]) {
        if (bandOf.has(id)) continue;
        bandOf.set(id, bands.length);
        band.push(id);
      }
    }
    if (band.length) bands.push(band);
  }
  const order = bands.flat();
  const others = floating.filter((card) => !bandOf.has(card.id));
  // Three columns reads well for a handful of cards; past nine the grid grows with the square
  // root, so a large board stays roughly square and Fit can still show all of it.
  const columns = Math.max(BOARD_LAYOUT.gridColumns, Math.ceil(Math.sqrt(others.length)));
  for (let index = 0; index < others.length; index += columns) {
    const row = others.slice(index, index + columns);
    let x = originX;
    for (const card of row) {
      card.x = x;
      card.y = originY;
      x += card.w + BOARD_LAYOUT.gridGap;
    }
    originY +=
      Math.max(...row.map((card) => card.h)) + (order.length ? BOARD_LAYOUT.flowRowGap * 1.5 : BOARD_LAYOUT.gridGap);
  }
  if (!order.length) return;
  // Longest-path columns over the flow graph without its back edges, so a
  // flow that loops back (a retry) still reads left to right. Columns are
  // shared by every band, so a step's column means the same thing in each.
  const next = new Map(order.map((id) => [id, []]));
  for (const [from, to] of edges) next.get(from).push(to);
  const forward = [];
  const state = new Map();
  const visit = (id) => {
    state.set(id, 1);
    for (const to of next.get(id)) {
      if (state.get(to) === 1) continue;
      forward.push([id, to]);
      if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const id of order) if (!state.has(id)) visit(id);
  const rank = new Map(order.map((id) => [id, 0]));
  for (let pass = 0; pass < order.length; pass += 1) {
    let changed = false;
    for (const [from, to] of forward) {
      if (rank.get(to) < rank.get(from) + 1) {
        rank.set(to, rank.get(from) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columnWidth = [];
  for (const id of order) {
    const column = rank.get(id);
    columnWidth[column] = Math.max(columnWidth[column] || 0, byId.get(id).w);
  }
  const columnX = [];
  let x = originX;
  for (let column = 0; column < columnWidth.length; column += 1) {
    columnX[column] = x;
    if (columnWidth[column]) x += columnWidth[column] + BOARD_LAYOUT.flowColumnGap;
  }
  let y = originY;
  for (const band of bands) {
    const columnY = new Map();
    let bottom = y;
    for (const id of band) {
      const card = byId.get(id);
      const column = rank.get(id);
      card.x = columnX[column];
      card.y = columnY.get(column) ?? y;
      columnY.set(column, card.y + card.h + BOARD_LAYOUT.flowRowGap);
      bottom = Math.max(bottom, card.y + card.h);
    }
    y = bottom + BOARD_LAYOUT.flowRowGap * 1.5;
  }
}

function escapeAttrValue(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function cardAttrString(attrs, skipNames = null) {
  return (Array.isArray(attrs) ? attrs : [])
    .filter(
      (pair) =>
        Array.isArray(pair) &&
        /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(String(pair[0])) &&
        (!skipNames || !skipNames.has(String(pair[0]).toLowerCase())),
    )
    .map(([name, value]) => ` ${name}="${escapeAttrValue(value)}"`)
    .join("");
}

function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const CARD_BASE_STYLE = `:root,:root[data-hilight-theme="light"]{color-scheme:light;--hilight-card-bg:${HTML_CARD_THEMES.light.bg};--hilight-card-ink:${HTML_CARD_THEMES.light.ink};--hilight-card-muted:${HTML_CARD_THEMES.light.muted};--hilight-card-line:${HTML_CARD_THEMES.light.line};--hilight-card-accent:${HTML_CARD_THEMES.light.accent};--hilight-card-surface:${HTML_CARD_THEMES.light.surface}}
:root[data-hilight-theme="dark"]{color-scheme:dark;--hilight-card-bg:${HTML_CARD_THEMES.dark.bg};--hilight-card-ink:${HTML_CARD_THEMES.dark.ink};--hilight-card-muted:${HTML_CARD_THEMES.dark.muted};--hilight-card-line:${HTML_CARD_THEMES.dark.line};--hilight-card-accent:${HTML_CARD_THEMES.dark.accent};--hilight-card-surface:${HTML_CARD_THEMES.dark.surface}}
:root[data-hilight-palette="light"]{color-scheme:light;--hilight-card-bg:${HTML_CARD_THEMES.light.bg};--hilight-card-ink:${HTML_CARD_THEMES.light.ink};--hilight-card-muted:${HTML_CARD_THEMES.light.muted};--hilight-card-line:${HTML_CARD_THEMES.light.line};--hilight-card-accent:${HTML_CARD_THEMES.light.accent};--hilight-card-surface:${HTML_CARD_THEMES.light.surface}}
:root[data-hilight-palette="dark"]{color-scheme:dark;--hilight-card-bg:${HTML_CARD_THEMES.dark.bg};--hilight-card-ink:${HTML_CARD_THEMES.dark.ink};--hilight-card-muted:${HTML_CARD_THEMES.dark.muted};--hilight-card-line:${HTML_CARD_THEMES.dark.line};--hilight-card-accent:${HTML_CARD_THEMES.dark.accent};--hilight-card-surface:${HTML_CARD_THEMES.dark.surface}}
:where(html,body){background:transparent;color:var(--hilight-card-ink)}
:where(body){margin:0;font:14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
:where(a){color:var(--hilight-card-accent)}
:where(hr){border:0;border-top:1px solid var(--hilight-card-line)}
:where(code,pre){font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:where(:not(pre)>code){background:var(--hilight-card-surface);padding:1px 5px;border-radius:4px;font-size:0.9em}
:where(pre){background:var(--hilight-card-surface);padding:10px 12px;border-radius:8px;overflow-x:auto}
:where(blockquote){margin:0.75em 0;padding-left:12px;border-left:3px solid var(--hilight-card-line);color:var(--hilight-card-muted)}
:where(table){border-collapse:collapse;width:100%}
:where(th,td){border-bottom:1px solid var(--hilight-card-line);padding:6px 8px;text-align:left}
:where(img,svg,video,canvas){max-width:100%}`;

// Layout-only reset: keeps author backgrounds intact so an author-styled light
// or dark card never loses its surface while keeping its text colour. Matches
// both `<section>` and `[data-card]` cards and uses `flow-root` so inner
// margins stay inside the card box when measuring its height.
const CARD_LAYOUT_RESET = `html,body{margin:0!important;padding:0!important;max-width:none!important;width:auto!important;min-height:0!important;height:auto!important}
[data-hilight-board]{display:block!important;margin:0!important;padding:0!important;max-width:none!important;width:auto!important;min-height:0!important;height:auto!important;border:0!important;box-shadow:none!important}
[data-hilight-board]>section,[data-hilight-board]>[data-card]{display:flow-root!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;padding:2px 16px 16px!important;width:auto!important;height:auto!important;max-width:none!important;min-height:0!important;overflow:visible!important}
[data-hilight-board]>section>:first-child,[data-hilight-board]>[data-card]>:first-child{margin-top:0!important}
[data-hilight-board]>section>:last-child,[data-hilight-board]>[data-card]>:last-child{margin-bottom:0!important}
html[data-hilight-theme="dark"][data-hilight-palette="light"] [data-hilight-board]>section,html[data-hilight-theme="dark"][data-hilight-palette="light"] [data-hilight-board]>[data-card],html[data-hilight-theme="light"][data-hilight-palette="dark"] [data-hilight-board]>section,html[data-hilight-theme="light"][data-hilight-palette="dark"] [data-hilight-board]>[data-card]{padding-top:12px!important}
html[data-hilight-surface="light"],html[data-hilight-surface="light"] body{background-color:${HTML_CARD_THEMES.light.bg}!important;color-scheme:light!important}
html[data-hilight-surface="dark"],html[data-hilight-surface="dark"] body{background-color:${HTML_CARD_THEMES.dark.bg}!important;color-scheme:dark!important}`;

const HTML_SKIP_ATTRS = new Set(["data-hilight-theme", "data-hilight-surface", "data-hilight-palette", "style"]);
const BODY_SKIP_ATTRS = new Set(["style"]);

function cardRuntimeScript(cardId, theme, token) {
  return `(()=>{try{
var root=document.documentElement;
var token=${inlineJson(String(token || ""))};
var cardId=${inlineJson(String(cardId || ""))};
var activeTheme=${inlineJson(theme === "dark" ? "dark" : "light")};
var BACKDROPS={light:[255,255,255,255],dark:[27,28,30,255]};
var ctx=null;
var mirroredBg=false;
var lastHeight=0;
var lastSurface="";
var raf=0;
function toRgba(color){
  if(!color||color==="transparent")return[0,0,0,0];
  var m=/^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,\\/]\\s*([\\d.]+%?))?\\s*\\)$/i.exec(color);
  if(m){
    var a=m[4]===undefined?1:m[4].endsWith("%")?parseFloat(m[4])/100:parseFloat(m[4]);
    return[Number(m[1]),Number(m[2]),Number(m[3]),Math.round(Math.max(0,Math.min(1,a))*255)];
  }
  if(!ctx){var c=document.createElement("canvas");c.width=1;c.height=1;ctx=c.getContext("2d",{willReadFrequently:true});}
  if(!ctx)return[0,0,0,0];
  ctx.clearRect(0,0,1,1);
  ctx.fillStyle="rgba(0,0,0,0)";
  ctx.fillStyle=color;
  ctx.fillRect(0,0,1,1);
  var d=ctx.getImageData(0,0,1,1).data;
  return[d[0],d[1],d[2],d[3]];
}
function composite(fg,bg){
  var fa=fg[3]/255,ba=bg[3]/255,a=fa+ba*(1-fa);
  if(a<=0)return[0,0,0,0];
  return[(fg[0]*fa+bg[0]*ba*(1-fa))/a,(fg[1]*fa+bg[1]*ba*(1-fa))/a,(fg[2]*fa+bg[2]*ba*(1-fa))/a,Math.round(a*255)];
}
function lum(c){
  var out=0,w=[0.2126,0.7152,0.0722];
  for(var i=0;i<3;i++){var s=c[i]/255;out+=w[i]*(s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4));}
  return out;
}
function contrast(a,b){
  var l1=lum(a),l2=lum(b);
  return(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
}
function cardHost(){
  return document.querySelector("[data-hilight-board]>section,[data-hilight-board]>[data-card]")||document.body;
}
function ensureContrast(){
  root.removeAttribute("data-hilight-surface");
  root.removeAttribute("data-hilight-palette");
  if(mirroredBg){root.style.removeProperty("background-color");mirroredBg=false;}
  var main=document.querySelector("[data-hilight-board]");
  var host=cardHost();
  var backdrop=BACKDROPS[activeTheme]||BACKDROPS.light;
  var chain=[];
  [root,document.body,main,host].forEach(function(n){if(n&&chain.indexOf(n)<0)chain.push(n);});
  var authorBg=[0,0,0,0];
  var opaqueStr="";
  var rootOrBodyOpaque=false;
  for(var i=0;i<chain.length;i++){
    var raw=getComputedStyle(chain[i]).backgroundColor;
    var rgba=toRgba(raw);
    if(rgba[3]>=128){
      opaqueStr=raw;
      if(chain[i]===root||chain[i]===document.body)rootOrBodyOpaque=true;
    }
    authorBg=composite(rgba,authorBg);
  }
  if(authorBg[3]>=128){
    var effBg=composite(authorBg,backdrop);
    var surface=lum(effBg)>0.35?"light":"dark";
    root.setAttribute("data-hilight-palette",surface);
    if(!rootOrBodyOpaque&&opaqueStr){root.style.backgroundColor=opaqueStr;mirroredBg=true;}
    return surface;
  }
  var totalChars=0,lowChars=0,darkLow=0,lightLow=0,sampled=0;
  if(host){
    var walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);
    var node;
    while((node=walker.nextNode())&&sampled<60){
      var text=(node.nodeValue||"").trim();
      if(!text)continue;
      var el=node.parentElement;
      if(!el)continue;
      var tag=el.tagName;
      if(tag==="SCRIPT"||tag==="STYLE"||tag==="NOSCRIPT"||tag==="TEMPLATE"||el.closest("svg"))continue;
      var cs=getComputedStyle(el);
      if(cs.display==="none"||cs.visibility==="hidden")continue;
      var ownSurface=false;
      for(var cur=el;cur&&cur!==host;cur=cur.parentElement){
        if(toRgba(getComputedStyle(cur).backgroundColor)[3]>=128){ownSurface=true;break;}
      }
      if(ownSurface)continue;
      sampled++;
      var fg=composite(toRgba(cs.color),backdrop);
      var len=text.length;
      totalChars+=len;
      if(contrast(fg,backdrop)<3){
        lowChars+=len;
        if(lum(fg)<0.35)darkLow+=len;else lightLow+=len;
      }
    }
    if(totalChars===0){
      var hostFg=composite(toRgba(getComputedStyle(host).color),backdrop);
      if(contrast(hostFg,backdrop)<3){
        var fallback=lum(hostFg)<0.35?"light":"dark";
        root.setAttribute("data-hilight-surface",fallback);
        root.setAttribute("data-hilight-palette",fallback);
        return fallback;
      }
    }else if(lowChars/totalChars>=0.5){
      var flipped=darkLow>=lightLow?"light":"dark";
      root.setAttribute("data-hilight-surface",flipped);
      root.setAttribute("data-hilight-palette",flipped);
      return flipped;
    }
  }
  return "inherit";
}
function measure(){
  raf=0;
  var surface=ensureContrast();
  var host=cardHost();
  if(!host)return;
  var rectH=host.getBoundingClientRect().height;
  var h=Math.ceil(Math.max(rectH,host.scrollHeight))+2;
  if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1)h+=16;
  if(h<=0)return;
  if(Math.abs(h-lastHeight)<1&&surface===lastSurface)return;
  lastHeight=h;
  lastSurface=surface;
  if(token&&window.parent&&window.parent!==window){
    window.parent.postMessage({type:"hilight-board:cardMetrics",token:token,cardId:cardId,height:h,surface:surface},"*");
  }
}
function schedule(){
  if(raf)return;
  raf=window.requestAnimationFrame(measure);
}
window.addEventListener("message",function(event){
  if(event.source!==window.parent)return;
  var msg=event.data||{};
  if(msg.type==="hilight-board:cardTheme"&&msg.token===token){
    activeTheme=msg.theme==="dark"?"dark":"light";
    root.setAttribute("data-hilight-theme",activeTheme);
    measure();
  }
});
measure();
window.addEventListener("load",measure);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(schedule,function(){});
var host=cardHost();
if(host&&typeof ResizeObserver==="function")new ResizeObserver(schedule).observe(host);
if(typeof MutationObserver==="function"){
  if(document.head)new MutationObserver(schedule).observe(document.head,{childList:true,subtree:true});
  new MutationObserver(function(muts){
    for(var i=0;i<muts.length;i++){
      if(!String(muts[i].attributeName||"").startsWith("data-hilight-")){schedule();break;}
    }
  }).observe(root,{attributes:true});
}
}catch(_e){}})();`;
}

/**
 * Build the sandboxed `srcdoc` document for one HTML card on a board canvas.
 * Injects theme-aware zero-specificity defaults before the board's `<head>`,
 * keeps author backgrounds intact while resetting outer layout chrome, and
 * embeds a self-contained runtime that guards text contrast and reports the
 * card's measured content height to the parent board frame.
 * @param {any} card
 * @param {any} model
 * @param {string} base
 * @param {{ theme?: "light" | "dark", token?: string }} [options]
 */
export function buildHtmlCardSrcdoc(card, model, base, { theme = "light", token = "" } = {}) {
  const activeTheme = theme === "dark" ? "dark" : "light";
  const htmlAttrs = cardAttrString(model?.html_attrs, HTML_SKIP_ATTRS);
  const bodyAttrs = cardAttrString(model?.body_attrs, BODY_SKIP_ATTRS);
  const mainAttrs = cardAttrString(model?.main_attrs);
  const sectionAttrs = cardAttrString(card?.attrs);
  return `<!doctype html><html${htmlAttrs} data-hilight-theme="${activeTheme}"><head><meta charset="utf-8"><base href="${escapeAttrValue(base || "")}" target="_blank"><style data-hilight-card-base>${CARD_BASE_STYLE}</style>
${model?.head || ""}
<style data-hilight-card-reset>${CARD_LAYOUT_RESET}</style></head><body${bodyAttrs}><main${mainAttrs}><section${sectionAttrs}>${card?.html || ""}</section></main><script data-hilight-card-runtime>${cardRuntimeScript(card?.id || "", activeTheme, token)}</script></body></html>`;
}

// Code-card geometry, shared with the frame's renderer so a mark drawn over a
// code card can be mapped back to the source lines under it.
// Geometry of a code card, shared by the server (card size), the renderer, and
// the mark summary (which source line sits under a mark). Code is 13px
// monospace; `char` is a slightly generous advance so a row never overflows.
export const CODE_CARD_LAYOUT = Object.freeze({
  header: 52,
  padTop: 8,
  padBottom: 12,
  line: 20,
  gutter: 48,
  padRight: 16,
  char: 8,
  minCols: 48,
  maxCols: 100,
  tab: 4,
});

// A card's note (its overview) wraps under the title. Its height is estimated
// from the text with a generous character width, then fixed on the card, so the
// server's card size, the rendered note, and every line position below it agree.
export const NOTE_LAYOUT = Object.freeze({ padTop: 7, padBottom: 7, line: 20, padX: 14, char: 7.3, maxRows: 4 });

/**
 * How many rows a note wraps to in a card of this width (0 for no note).
 * @param {string} note
 * @param {number} width
 */
export function noteRows(note, width) {
  const words = String(note || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 0;
  const cols = Math.max(12, Math.floor((Number(width) - NOTE_LAYOUT.padX * 2) / NOTE_LAYOUT.char));
  let rows = 1;
  let used = 0;
  for (const word of words) {
    let length = word.length;
    if (used && used + 1 + length > cols) {
      rows += 1;
      used = 0;
    }
    while (length > cols) {
      rows += 1;
      length -= cols;
    }
    used += (used ? 1 : 0) + length;
  }
  return Math.min(rows, NOTE_LAYOUT.maxRows);
}

/** Height of a code card's note strip, from the card's note and width. */
export function codeNoteHeight(card) {
  const rows = noteRows(card?.note, card?.w || 0);
  return rows ? NOTE_LAYOUT.padTop + rows * NOTE_LAYOUT.line + NOTE_LAYOUT.padBottom : 0;
}

/** Offset of a code card's first code row from the card's top edge. */
export function codeBodyTop(card) {
  return CODE_CARD_LAYOUT.header + codeNoteHeight(card) + CODE_CARD_LAYOUT.padTop;
}

/** Horizontal space a code card needs besides its code columns. */
export function codeChromeWidth() {
  return CODE_CARD_LAYOUT.gutter + CODE_CARD_LAYOUT.padRight + 2;
}

function expandTabs(line) {
  let out = "";
  for (const char of String(line)) {
    if (char === "\t") out += " ".repeat(CODE_CARD_LAYOUT.tab - (out.length % CODE_CARD_LAYOUT.tab));
    else out += char;
  }
  return out.replace(/\s+$/, "");
}

/**
 * How many code columns a card shows: its longest line, kept between the
 * column limits. A width from the file is a ceiling, never a reason to grow.
 * @param {string[]} lines
 * @param {number | null} [maxWidth]
 */
export function codeColumns(lines, maxWidth = null) {
  const longest = Math.max(0, ...(lines || []).map((line) => expandTabs(line).length));
  let cols = Math.min(Math.max(longest, CODE_CARD_LAYOUT.minCols), CODE_CARD_LAYOUT.maxCols);
  if (Number.isFinite(maxWidth) && maxWidth > 0) {
    const ceiling = Math.floor((maxWidth - codeChromeWidth()) / CODE_CARD_LAYOUT.char);
    cols = Math.min(cols, Math.max(ceiling, 16));
  }
  return cols;
}

/** Card width for a number of code columns. */
export function codeCardWidth(cols) {
  return Math.ceil(codeChromeWidth() + cols * CODE_CARD_LAYOUT.char);
}

/**
 * Split source lines into the rows a code card draws. A line longer than
 * `cols` wraps, preferring a space near the end of the row; continuation rows
 * keep the line's indent plus two and are flagged so the card can mark them.
 * Character counts decide the rows, so the server's card height, the drawn rows,
 * and the line under a mark always agree.
 * @param {string[]} lines
 * @param {number} cols
 * @returns {{ index: number, cont: boolean, text: string }[]}
 */
export function codeRows(lines, cols) {
  const width = Number.isFinite(cols) && cols > 0 ? Math.max(8, Math.floor(cols)) : Infinity;
  const rows = [];
  (lines || []).forEach((raw, index) => {
    const line = expandTabs(raw);
    if (line.length <= width) {
      rows.push({ index, cont: false, text: line });
      return;
    }
    const indent = Math.min((/^ */.exec(line)?.[0].length || 0) + 2, Math.floor(width / 2));
    let rest = line;
    let room = width;
    let prefix = "";
    while (rest.length > room) {
      let cut = rest.lastIndexOf(" ", room - 1) + 1;
      if (cut <= Math.floor(room * 0.6)) cut = room;
      rows.push({ index, cont: prefix !== "", text: prefix + rest.slice(0, cut) });
      rest = rest.slice(cut);
      prefix = " ".repeat(indent);
      room = width - indent;
    }
    if (rest.length) rows.push({ index, cont: prefix !== "", text: prefix + rest });
  });
  return rows;
}

const NEAR_PX = 48;
const MAX_SUMMARY_LINES = 40;
const MAX_TEXT = 200;
const STAT_KEYS = ["arrows", "notes", "shapes", "freehand", "images", "moved", "removed"];

export function cardElementId(cardId) {
  return CARD_ELEMENT_PREFIX + String(cardId);
}

export function cardIdOfElement(element) {
  const id = element?.customData?.hilightCard;
  return typeof id === "string" && id ? id : null;
}

export function isCardElement(element) {
  return cardIdOfElement(element) !== null;
}

// Connectors the agent declared with `data-to`. They are drawn from the file
// on every load, locked, and never reported back as the reviewer's marks.
export function isLinkElement(element) {
  return Boolean(element?.customData?.hilightLink) || String(element?.id || "").startsWith(LINK_ELEMENT_PREFIX);
}

// Flow colours: one accent per flow, distinct from the reviewer's blue ink, the
// amber of stale code, and the grey card chrome.
export const FLOW_COLORS = Object.freeze(["#7048e8", "#2f9e44", "#d6336c", "#1098ad", "#9c6644", "#ae3ec9"]);

/** The colour of the n-th flow of a board. */
export function flowColor(index) {
  const n = Number.isInteger(index) && index >= 0 ? index : 0;
  return FLOW_COLORS[n % FLOW_COLORS.length];
}

// How far an endpoint on code lines sits inside its card, the clearance a
// route keeps from every card, the price of a bend, and how far apart
// overlapping segments of different arrows are pushed.
const LINK_TIP = 12;
const ROUTE_MARGIN = 20;
const BEND_COST = 60;
const NUDGE = 6;
const EDGE_PAD = 18;
const MAX_LINE_NUMBER = 9_999_999;

/**
 * Line numbers in a step or token: `120` or `120-124`, an optional `L`.
 * @param {string} text
 */
export function parseLineSpan(text) {
  const match = /^L?(\d{1,7})(?:-L?(\d{1,7}))?$/i.exec(String(text || ""));
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (start < 1 || end < start || end > MAX_LINE_NUMBER) return null;
  return { start, end };
}

/**
 * One endpoint: `card` or `card:120` or `card:120-124`. Null when malformed.
 * @param {string} text
 * @returns {{ card: string, lines: { start: number, end: number } | null } | null}
 */
export function parseEndpoint(text) {
  const value = String(text || "").trim();
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const lines = parseLineSpan(value.slice(colon + 1));
    if (!lines) return null;
    return { card: value.slice(0, colon), lines };
  }
  if (!value || /[\s:>]/.test(value)) return null;
  return { card: value, lines: null };
}

/**
 * One legacy `data-to` token: `target[:lines]`, optionally prefixed with the
 * source card's own lines, `88>target:120`. Null when malformed.
 * @param {string} token
 */
export function parseLinkToken(token) {
  let text = String(token || "").trim();
  let from = null;
  const arrow = text.indexOf(">");
  if (arrow >= 0) {
    from = parseLineSpan(text.slice(0, arrow));
    if (!from) return null;
    text = text.slice(arrow + 1);
  }
  const target = parseEndpoint(text);
  return target ? { card: target.card, lines: target.lines, from } : null;
}

/**
 * Where lines of a code card sit, as offsets from the card's top edge. Lines
 * are numbered as when the card was pinned, so an anchor follows code that
 * moved. Null when the card has no such lines.
 * @param {any} card the card model
 * @param {{ start: number, end: number } | null} span
 */
export function codeLineSpan(card, span) {
  const code = card?.code;
  if (!span || !code || !Array.isArray(code.lines) || !code.lines.length) return null;
  const base = Number.isInteger(code.pinned_start) ? code.pinned_start : code.start;
  const first = span.start - base;
  if (first < 0 || first >= code.lines.length) return null;
  const last = Math.min(span.end - base, code.lines.length - 1);
  const rows = codeRows(code.lines, code.cols);
  const firstRow = rows.findIndex((row) => row.index === first);
  let lastRow = firstRow;
  rows.forEach((row, index) => {
    if (row.index === last) lastRow = index;
  });
  if (firstRow < 0) return null;
  const top = codeBodyTop(card);
  return {
    first,
    last,
    top: top + firstRow * CODE_CARD_LAYOUT.line,
    bottom: top + (lastRow + 1) * CODE_CARD_LAYOUT.line,
  };
}

/**
 * A step's identity across edits of the board file: its flow's name and the
 * cards at both ends. Step keys are positional, so they cannot tell a new step
 * from a moved one, and line spans are left out because re-pinning a step to
 * code that moved is not adding an arrow.
 */
export function stepSignature(step) {
  return `${step?.flowName || ""}|${step?.from?.card || ""}>${step?.to?.card || ""}`;
}

/** A saved signature in today's form. Older scenes saved `card:start-end` ends. */
function currentStepSignature(signature) {
  return String(signature).replace(/:(\d+-\d+)?(?=>|$)/g, "");
}

// Below this canvas size (a half-screen laptop, a preview pane) a board opens on where to start at a
// readable zoom instead of trying to show a whole row.
export const SMALL_CANVAS = Object.freeze({ width: 900, height: 620 });

/** @param {{ width: number, height: number }} size */
export function isSmallCanvas(size) {
  return size.width < SMALL_CANVAS.width || size.height < SMALL_CANVAS.height;
}

/** Within 20% in both directions: the same window, give or take a panel. */
export function similarCanvasSize(size, other) {
  return (
    Math.abs(size.width - other.width) <= other.width * 0.2 &&
    Math.abs(size.height - other.height) <= other.height * 0.2
  );
}

/**
 * The saved view to open a level at, or null to work the opening view out
 * again. A saved view belongs to the window size it was saved in: in a window
 * of a clearly different size, or a small one when the view does not say its
 * size (saved before sizes were kept), it would open at the wrong zoom, such as
 * a full-screen fit shown at 26% in a half-screen window.
 * @param {unknown} saved `{ zoom: { value } | number, scrollX, scrollY, width?, height? }`
 * @param {{ width: number, height: number }} size the canvas now
 */
export function usableSavedView(saved, size) {
  if (!saved || typeof saved !== "object") return null;
  const view = /** @type {any} */ (saved);
  const zoom = typeof view.zoom === "object" ? view.zoom?.value : view.zoom;
  if (!(zoom > 0) || !Number.isFinite(view.scrollX) || !Number.isFinite(view.scrollY)) return null;
  const sized = view.width > 0 && view.height > 0;
  if (sized ? !similarCanvasSize(size, view) : isSmallCanvas(size)) return null;
  return {
    zoom,
    scrollX: view.scrollX,
    scrollY: view.scrollY,
    width: sized ? view.width : size.width,
    height: sized ? view.height : size.height,
  };
}

/**
 * What the agent added since the reviewer last looked: the cards and flow
 * steps a saved `known` list does not name. With no `known` (a first open, or
 * a scene saved before this existed) nothing is new.
 * @param {{ cards: { id: string }[], flows?: any[] }} model
 * @param {unknown} known `{ cards: string[], steps: string[] }` from the saved scene
 */
export function freshSince(model, known) {
  const cards = new Set();
  const steps = new Set();
  const record = /** @type {any} */ (known);
  if (!record || !Array.isArray(record.cards) || !Array.isArray(record.steps)) return { cards, steps };
  const knownCards = new Set(record.cards.map(String));
  const knownSteps = new Set(record.steps.map(currentStepSignature));
  for (const card of model.cards) if (!knownCards.has(card.id)) cards.add(card.id);
  for (const step of flowSteps(model.flows)) {
    const signature = stepSignature(step);
    if (!knownSteps.has(signature)) steps.add(signature);
  }
  return { cards, steps };
}

/**
 * Where each of the board's own top-floating controls (the new-card toast) goes: its resting
 * top, or `gap` below the lowest floating bar it would otherwise overlap, such as Excalidraw's
 * Draw toolbar or an earlier floater of ours. Never on top of one. With the bar gone, it is back
 * at rest. Rects are `{ left, right, top, bottom }` in the board's own coordinates; a floater's
 * own `top` is ignored, since only its width and height decide where it may go.
 *
 * @param {{ left: number, right: number, top: number, bottom: number }[]} floaters
 * @param {{ left: number, right: number, top: number, bottom: number }[]} bars
 * @param {{ rest?: number, gap?: number }} [options]
 * @returns {number[]} each floater's top
 */
export function stackTopFloaters(floaters, bars, { rest = 12, gap = 8 } = {}) {
  const placed = [];
  return floaters.map((floater) => {
    const height = floater.bottom - floater.top;
    const blockers = [...bars, ...placed];
    let top = rest;
    // Moving below one bar can land on another, so settle until nothing is in the way. Top only
    // grows, so this ends.
    for (let moved = true; moved; ) {
      moved = false;
      for (const bar of blockers) {
        const acrossX = bar.left < floater.right && bar.right > floater.left;
        const acrossY = bar.top < top + height + gap && bar.bottom + gap > top;
        if (acrossX && acrossY && bar.bottom + gap > top) {
          top = bar.bottom + gap;
          moved = true;
        }
      }
    }
    placed.push({ left: floater.left, right: floater.right, top, bottom: top + height });
    return top;
  });
}

/**
 * The `known` list to save: everything on the board except what is still new,
 * so an unacknowledged addition is new again after a reload.
 * @param {{ cards: { id: string }[], flows?: any[] }} model
 * @param {{ cards: Set<string>, steps: Set<string> }} fresh
 */
export function knownAfter(model, fresh) {
  return {
    cards: model.cards.map((card) => card.id).filter((id) => !fresh.cards.has(id)),
    steps: [...new Set(flowSteps(model.flows).map(stepSignature))].filter((signature) => !fresh.steps.has(signature)),
  };
}

/** Every step of the given flows, flattened, each with its flow's colour. */
export function flowSteps(flows) {
  const steps = [];
  for (const flow of Array.isArray(flows) ? flows : []) {
    (Array.isArray(flow.steps) ? flow.steps : []).forEach((step, index) => {
      if (!step?.from?.card || !step?.to?.card) return;
      steps.push({
        ...step,
        flow: flow.id,
        flowName: String(flow.name || ""),
        color: flow.color || flowColor(0),
        key: `${flow.id}.${index + 1}`,
      });
    });
  }
  return steps;
}

/**
 * The lines each code card has a flow arrow starting or ending on, as line
 * indices into the card's shown lines with the flow's colour, so the card can
 * highlight both ends of every arrow.
 * @param {any[]} cards
 * @param {any[]} flows
 * @returns {Map<string, Map<number, string>>}
 */
export function linkLandings(cards, flows) {
  const byId = new Map((cards || []).map((card) => [card.id, card]));
  /** @type {Map<string, Map<number, string>>} */
  const landings = new Map();
  for (const step of flowSteps(flows)) {
    for (const end of [step.from, step.to]) {
      const card = byId.get(end.card);
      const span = card && end.lines ? codeLineSpan(card, end.lines) : null;
      if (!span) continue;
      if (!landings.has(card.id)) landings.set(card.id, new Map());
      const lines = landings.get(card.id);
      for (let index = span.first; index <= span.last; index += 1) if (!lines.has(index)) lines.set(index, step.color);
    }
  }
  return landings;
}

function tidyPoints(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    const before = out[out.length - 2];
    if (
      last &&
      before &&
      ((before[0] === last[0] && last[0] === point[0]) || (before[1] === last[1] && last[1] === point[1]))
    ) {
      out[out.length - 1] = point;
      continue;
    }
    out.push(point);
  }
  return out;
}

const SIDE_NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

function makePort(side, edge, inside) {
  const [nx, ny] = SIDE_NORMAL[side];
  return {
    side,
    dir: [nx, ny],
    tip: inside ? [edge[0] - nx * LINK_TIP, edge[1] - ny * LINK_TIP] : edge,
    out: [edge[0] + nx * ROUTE_MARGIN, edge[1] + ny * ROUTE_MARGIN],
  };
}

// Where a connector may leave or enter a card. On code lines it starts or
// stops inside the card, on that line, through the left or right side; for a
// whole card it meets an edge, preferring the stretch it shares with the other card.
function cardPorts(rect, lineY, other) {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (lineY !== null) return [makePort("left", [rect.x, lineY], true), makePort("right", [right, lineY], true)];
  const ys = [rect.y + rect.h / 2];
  const low = Math.max(rect.y, other.y) + EDGE_PAD;
  const high = Math.min(bottom, other.y + other.h) - EDGE_PAD;
  if (high >= low) ys.unshift((low + high) / 2);
  const xs = [rect.x + rect.w / 2];
  const left = Math.max(rect.x, other.x) + EDGE_PAD;
  const rightEnd = Math.min(right, other.x + other.w) - EDGE_PAD;
  if (rightEnd >= left) xs.unshift((left + rightEnd) / 2);
  return [
    ...ys.flatMap((y) => [makePort("left", [rect.x, y], false), makePort("right", [right, y], false)]),
    ...xs.flatMap((x) => [makePort("top", [x, rect.y], false), makePort("bottom", [x, bottom], false)]),
  ];
}

function inflate(rect) {
  return {
    x1: rect.x - ROUTE_MARGIN,
    y1: rect.y - ROUTE_MARGIN,
    x2: rect.x + rect.w + ROUTE_MARGIN,
    y2: rect.y + rect.h + ROUTE_MARGIN,
  };
}

const EPS = 0.01;

function insideAny(boxes, x, y) {
  return boxes.some((box) => x > box.x1 + EPS && x < box.x2 - EPS && y > box.y1 + EPS && y < box.y2 - EPS);
}

function gridCoordinates(values) {
  const sorted = [...new Set(values.map((value) => Math.round(value * 100) / 100))].sort((a, b) => a - b);
  const out = [...sorted];
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] - sorted[index - 1] > ROUTE_MARGIN * 2) out.push((sorted[index] + sorted[index - 1]) / 2);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

class MinHeap {
  constructor() {
    /** @type {any[]} */
    this.items = [];
  }
  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].f <= items[index].f) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        if (left < items.length && items[left].f < items[best].f) best = left;
        if (right < items.length && items[right].f < items[best].f) best = right;
        if (best === index) break;
        [items[best], items[index]] = [items[index], items[best]];
        index = best;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function dirIndex([dx, dy]) {
  return DIRS.findIndex((dir) => dir[0] === dx && dir[1] === dy);
}

/**
 * A right-angled route from one of `starts` to one of `goals` that keeps
 * clear of every rect in `obstacles` (all cards of the level, the two it
 * connects included: it leaves and enters them only through its ports).
 * Fewest bends first, then shortest. Null when no route exists.
 * @param {any[]} starts ports
 * @param {any[]} goals ports
 * @param {{ x: number, y: number, w: number, h: number }[]} obstacles
 * @returns {number[][] | null}
 */
export function routeAround(starts, goals, obstacles) {
  const boxes = obstacles.map(inflate);
  const usable = (port) => !insideAny(boxes, port.out[0], port.out[1]);
  const from = starts.filter(usable);
  const to = goals.filter(usable);
  if (!from.length || !to.length) return null;
  const allX = boxes.flatMap((box) => [box.x1, box.x2]);
  const allY = boxes.flatMap((box) => [box.y1, box.y2]);
  const portXs = [...from, ...to].map((port) => port.out[0]);
  const portYs = [...from, ...to].map((port) => port.out[1]);
  const pad = ROUTE_MARGIN * 3;
  const xs = gridCoordinates([
    ...allX,
    ...portXs,
    Math.min(...allX, ...portXs) - pad,
    Math.max(...allX, ...portXs) + pad,
  ]);
  const ys = gridCoordinates([
    ...allY,
    ...portYs,
    Math.min(...allY, ...portYs) - pad,
    Math.max(...allY, ...portYs) + pad,
  ]);
  const xIndex = new Map(xs.map((value, index) => [Math.round(value * 100) / 100, index]));
  const yIndex = new Map(ys.map((value, index) => [Math.round(value * 100) / 100, index]));
  const nodeOf = ([x, y]) => [xIndex.get(Math.round(x * 100) / 100), yIndex.get(Math.round(y * 100) / 100)];
  const cols = xs.length;
  const free = new Uint8Array(cols * ys.length);
  for (let j = 0; j < ys.length; j += 1) {
    for (let i = 0; i < cols; i += 1) free[j * cols + i] = insideAny(boxes, xs[i], ys[j]) ? 0 : 1;
  }
  const edgeFree = (i, j, ni, nj) => !insideAny(boxes, (xs[i] + xs[ni]) / 2, (ys[j] + ys[nj]) / 2);
  const goalAt = new Map();
  for (const port of to) {
    const [i, j] = nodeOf(port.out);
    if (i === undefined || j === undefined) continue;
    goalAt.set(j * cols + i, [...(goalAt.get(j * cols + i) || []), port]);
  }
  const goalNodes = [...goalAt.keys()].map((key) => [xs[key % cols], ys[Math.floor(key / cols)]]);
  const heuristic = (i, j) => Math.min(...goalNodes.map(([gx, gy]) => Math.abs(gx - xs[i]) + Math.abs(gy - ys[j])));
  const heap = new MinHeap();
  const best = new Map();
  const parent = new Map();
  for (const port of from) {
    const [i, j] = nodeOf(port.out);
    if (i === undefined || j === undefined) continue;
    const d = dirIndex(port.dir);
    const key = (j * cols + i) * 4 + d;
    const g = Math.abs(port.out[0] - port.tip[0]) + Math.abs(port.out[1] - port.tip[1]);
    if (g < (best.get(key) ?? Infinity)) {
      best.set(key, g);
      parent.set(key, { start: port });
      heap.push({ f: g + heuristic(i, j), g, i, j, d, key });
    }
  }
  let found = null;
  while (heap.size) {
    const item = heap.pop();
    if (item.done) {
      found = item;
      break;
    }
    if (item.g > (best.get(item.key) ?? Infinity)) continue;
    const node = item.j * cols + item.i;
    for (const port of goalAt.get(node) || []) {
      const inward = dirIndex([-port.dir[0], -port.dir[1]]);
      const outward = dirIndex(port.dir);
      if (item.d === outward) continue;
      const g =
        item.g +
        (item.d === inward ? 0 : BEND_COST) +
        Math.abs(port.out[0] - port.tip[0]) +
        Math.abs(port.out[1] - port.tip[1]);
      heap.push({ f: g, g, done: true, key: item.key, port });
    }
    for (let d = 0; d < 4; d += 1) {
      const [dx, dy] = DIRS[d];
      if (d === dirIndex([-DIRS[item.d][0], -DIRS[item.d][1]])) continue;
      const ni = item.i + dx;
      const nj = item.j + dy;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= ys.length || !free[nj * cols + ni]) continue;
      if (!edgeFree(item.i, item.j, ni, nj)) continue;
      const g = item.g + Math.abs(xs[ni] - xs[item.i]) + Math.abs(ys[nj] - ys[item.j]) + (d === item.d ? 0 : BEND_COST);
      const key = (nj * cols + ni) * 4 + d;
      if (g >= (best.get(key) ?? Infinity)) continue;
      best.set(key, g);
      parent.set(key, { key: item.key });
      heap.push({ f: g + heuristic(ni, nj), g, i: ni, j: nj, d, key });
    }
  }
  if (!found) return null;
  const middle = [];
  let key = found.key;
  let start = null;
  while (key !== undefined) {
    const node = Math.floor(key / 4);
    middle.unshift([xs[node % cols], ys[Math.floor(node / cols)]]);
    const link = parent.get(key);
    if (link?.start) {
      start = link.start;
      break;
    }
    key = link?.key;
  }
  if (!start) return null;
  return tidyPoints([start.tip, ...middle, found.port.tip]);
}

/**
 * A plain right-angled path for when no clear route exists (cards packed too
 * tightly): out of the source's facing side, across, into the target.
 * @returns {number[][]}
 */
export function connectorPoints(a, b, { fromY = null, toY = null } = {}) {
  const dir = b.x + b.w / 2 >= a.x + a.w / 2 ? 1 : -1;
  const sx = dir > 0 ? a.x + a.w : a.x;
  const ex = dir > 0 ? b.x : b.x + b.w;
  const sy = fromY ?? a.y + a.h / 2;
  const ey = toY ?? b.y + b.h / 2;
  const start = fromY !== null ? sx - dir * LINK_TIP : sx;
  const end = toY !== null ? ex + dir * LINK_TIP : ex;
  const mx = (sx + ex) / 2;
  return tidyPoints([
    [start, sy],
    [mx, sy],
    [mx, ey],
    [end, ey],
  ]);
}

// Push apart interior segments of different arrows that run along the same
// line, so overlapping flows stay readable. The end segments stay put: they
// sit on code lines.
function nudgeOverlaps(routes) {
  const segments = [];
  routes.forEach((points, route) => {
    for (let index = 1; index < points.length - 2; index += 1) {
      const [x1, y1] = points[index];
      const [x2, y2] = points[index + 1];
      const vertical = x1 === x2;
      segments.push({
        route,
        index,
        vertical,
        at: vertical ? x1 : y1,
        low: vertical ? Math.min(y1, y2) : Math.min(x1, x2),
        high: vertical ? Math.max(y1, y2) : Math.max(x1, x2),
      });
    }
  });
  const groups = new Map();
  for (const segment of segments) {
    const key = `${segment.vertical ? "v" : "h"}${Math.round(segment.at)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(segment);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.route - b.route || a.low - b.low);
    const lanes = [];
    for (const segment of group) {
      let lane = lanes.findIndex((items) =>
        items.every((other) => other.route === segment.route || other.high <= segment.low || other.low >= segment.high),
      );
      if (lane < 0) lane = lanes.push([]) - 1;
      lanes[lane].push(segment);
      segment.lane = lane;
    }
    if (lanes.length < 2) continue;
    for (const segment of group) {
      const shift = (segment.lane - (lanes.length - 1) / 2) * NUDGE;
      const points = routes[segment.route];
      const axis = segment.vertical ? 0 : 1;
      points[segment.index][axis] += shift;
      points[segment.index + 1][axis] += shift;
    }
  }
}

function elementRect(element) {
  return { x: element.x, y: element.y, w: element.width, h: element.height };
}

function lineY(element, card, span, scrollTop = 0) {
  const info = card && span ? codeLineSpan(card, span) : null;
  if (!info) return null;
  // A reviewer can shrink a card and scroll its code; a line scrolled out of
  // sight pins the arrow to the edge of the code it went past.
  const top = codeBodyTop(card) + 10;
  const y = (info.top + info.bottom) / 2 - (Number(scrollTop) || 0);
  return element.y + Math.max(Math.min(top, element.height - 10), Math.min(y, element.height - 10));
}

/**
 * Arrow elements for the flows of one level: each step starts and ends on its
 * code lines (or a card edge) and routes around every other card. They are
 * recomputed whenever a card moves or resizes, and carry no bindings, so
 * Excalidraw never reshapes them.
 * @param {any[]} cards the level's cards
 * @param {any[]} cardElements their scene elements
 * @param {any[]} flows the board's flows (other levels' steps are skipped)
 * @param {{ scrollOf?: (cardId: string) => number, emphasis?: Set<string> }} [options]
 *   how far each code card is scrolled, and the step signatures to draw heavier
 */
export function createLinkElements(cards, cardElements, flows = [], { scrollOf = () => 0, emphasis = new Set() } = {}) {
  const byCard = new Map(
    cardElements.filter((element) => !element.isDeleted).map((element) => [cardIdOfElement(element), element]),
  );
  const models = new Map(cards.map((card) => [card.id, card]));
  const obstacles = [...byCard.values()].map(elementRect);
  const routes = [];
  const meta = [];
  const seen = new Set();
  for (const step of flowSteps(flows)) {
    const fromElement = byCard.get(step.from.card);
    const toElement = byCard.get(step.to.card);
    if (!fromElement || !toElement || fromElement === toElement) continue;
    const id = `${LINK_ELEMENT_PREFIX}${step.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const a = elementRect(fromElement);
    const b = elementRect(toElement);
    const fromY = lineY(fromElement, models.get(step.from.card), step.from.lines, scrollOf(step.from.card));
    const toY = lineY(toElement, models.get(step.to.card), step.to.lines, scrollOf(step.to.card));
    const route =
      routeAround(cardPorts(a, fromY, b), cardPorts(b, toY, a), obstacles) || connectorPoints(a, b, { fromY, toY });
    routes.push(route.map((point) => [...point]));
    meta.push({ id, step, level: models.get(step.from.card)?.level ?? "" });
  }
  nudgeOverlaps(routes);
  return routes.map((absolute, index) => {
    const { id, step, level } = meta[index];
    const [x0, y0] = absolute[0];
    const points = absolute.map(([x, y]) => [x - x0, y - y0]);
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return {
      id,
      type: "arrow",
      x: x0,
      y: y0,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points,
      angle: 0,
      strokeColor: step.color,
      backgroundColor: "transparent",
      fillStyle: "solid",
      // Thick enough to read the flow's colour on a zoomed-out board; a step the
      // reviewer has not seen yet is heavier still.
      strokeWidth: emphasis.has(stepSignature(step)) ? 6 : 3,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      roundness: null,
      elbowed: false,
      locked: true,
      startArrowhead: "dot",
      endArrowhead: "triangle",
      startBinding: null,
      endBinding: null,
      boundElements: [],
      groupIds: [],
      frameId: null,
      isDeleted: false,
      customData: { hilightLink: step.key, boardLevel: level },
    };
  });
}

/** A signature of the cards' geometry, to tell when connectors need redrawing. */
export function cardGeometryKey(cardElements) {
  return cardElements
    .filter((element) => !element.isDeleted)
    .map((element) => `${element.id}:${element.x},${element.y},${element.width},${element.height}`)
    .sort()
    .join("|");
}

export function elementLevel(element) {
  const level = element?.customData?.boardLevel;
  return typeof level === "string" ? level : "";
}

function sameRect(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function fileRect(card) {
  return { x: card.x, y: card.y, w: card.w, h: card.h };
}

/** A fresh card element at the card's position in the file. */
export function createCardElement(card) {
  return {
    id: cardElementId(card.id),
    type: "embeddable",
    x: card.x,
    y: card.y,
    width: card.w,
    height: card.h,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    roundness: { type: 3 },
    locked: false,
    link: CARD_LINK_PREFIX + encodeURIComponent(card.id),
    boundElements: [],
    groupIds: [],
    frameId: null,
    isDeleted: false,
    customData: { hilightCard: card.id, boardLevel: card.level, fileRect: fileRect(card) },
  };
}

function shiftArrow(arrow, startDelta, endDelta) {
  if (!Array.isArray(arrow.points) || arrow.points.length < 2) return arrow;
  const last = arrow.points.length - 1;
  const points = arrow.points.map((point, index) => {
    if (index === 0) return [0, 0];
    if (index === last) {
      return [point[0] + endDelta.x - startDelta.x, point[1] + endDelta.y - startDelta.y];
    }
    return [point[0] - startDelta.x, point[1] - startDelta.y];
  });
  return { ...arrow, x: arrow.x + startDelta.x, y: arrow.y + startDelta.y, points };
}

function baselineRect(element) {
  return element?.customData?.autoRect || element?.customData?.fileRect || null;
}

/**
 * Build one level's scene from the board model and the saved elements of that
 * level. The file decides which cards exist and what they show. A card keeps
 * the reviewer's position only while the file still places it where it was
 * when the reviewer moved it; when the agent moves a card in the file, the
 * file wins and arrows bound to the card follow it.
 * @param {any[]} cards cards of this level from the board model
 * @param {any[]} saved saved elements of this level (cards and marks)
 */
export function reconcileLevelElements(cards, saved, flows = []) {
  const savedById = new Map((Array.isArray(saved) ? saved : []).map((element) => [element.id, element]));
  const liveCardIds = new Set(cards.map((card) => cardElementId(card.id)));
  const deltas = new Map();
  /** @type {any[]} */
  const cardElements = [];
  for (const card of cards) {
    const id = cardElementId(card.id);
    const previous = savedById.get(id);
    const element = createCardElement(card);
    if (previous && sameRect(previous.customData?.fileRect, fileRect(card))) {
      element.x = Number(previous.x);
      element.y = Number(previous.y);
      element.width = Number(previous.width) || element.width;
      element.height = Number(previous.height) || element.height;
      element.isDeleted = Boolean(previous.isDeleted);
      if (previous.customData?.autoRect) {
        element.customData = { ...element.customData, autoRect: previous.customData.autoRect };
      }
    } else if (previous && !previous.isDeleted) {
      deltas.set(id, { x: element.x - Number(previous.x), y: element.y - Number(previous.y) });
    }
    cardElements.push(element);
  }
  const zero = { x: 0, y: 0 };
  const marks = [];
  for (const element of Array.isArray(saved) ? saved : []) {
    if (isCardElement(element) || String(element.id || "").startsWith(CARD_ELEMENT_PREFIX)) continue;
    if (isLinkElement(element)) continue;
    let next = element;
    const start = element.startBinding?.elementId;
    const end = element.endBinding?.elementId;
    if (start || end) {
      const startDelta = (start && deltas.get(start)) || zero;
      const endDelta = (end && deltas.get(end)) || zero;
      if (startDelta !== zero || endDelta !== zero) next = shiftArrow(next, startDelta, endDelta);
      if (start && start.startsWith(CARD_ELEMENT_PREFIX) && !liveCardIds.has(start)) {
        next = { ...next, startBinding: null };
      }
      if (end && end.startsWith(CARD_ELEMENT_PREFIX) && !liveCardIds.has(end)) next = { ...next, endBinding: null };
    }
    marks.push(next);
  }
  const links = createLinkElements(cards, cardElements, flows);
  const bound = new Map();
  for (const mark of [...links, ...marks]) {
    if (mark.isDeleted) continue;
    for (const binding of [mark.startBinding, mark.endBinding]) {
      const target = binding?.elementId;
      if (!target || !liveCardIds.has(target)) continue;
      if (!bound.has(target)) bound.set(target, []);
      const list = bound.get(target);
      if (!list.some((entry) => entry.id === mark.id)) list.push({ id: mark.id, type: "arrow" });
    }
  }
  for (const element of cardElements) element.boundElements = bound.get(element.id) || [];
  return [...cardElements, ...links, ...marks];
}

/**
 * Apply measured rendered heights to auto-sized HTML cards on one level and
 * reflow unplaced, reviewer-unmoved cards around the updated boxes. Reviewer
 * manual moves/resizes and explicit `data-h` heights are preserved, and
 * `customData.fileRect` stays untouched while `customData.autoRect` tracks the
 * Hilight-chosen rect so `summarizeBoardMarks` never reports auto-sizing as a
 * reviewer edit.
 * @param {any[]} cards cards belonging to the level
 * @param {any[]} elements current scene elements on the level
 * @param {any[]} flows board flows (other levels are ignored)
 * @param {Map<string, number> | Record<string, number>} measuredHeights cardId -> total desired card height
 * @returns {{ elements: any[], changed: boolean }}
 */
export function applyHtmlCardMeasurements(cards, elements, flows = [], measuredHeights = new Map()) {
  const heights = measuredHeights instanceof Map ? measuredHeights : new Map(Object.entries(measuredHeights || {}));
  const byElementId = new Map((Array.isArray(elements) ? elements : []).map((element) => [element.id, element]));
  const levelId = cards[0]?.level ?? "";
  const levelFlows = (Array.isArray(flows) ? flows : []).filter((flow) => (flow?.level ?? "") === levelId);

  /** @type {Map<string, { userMoved: boolean, userResized: boolean, targetH: number, element: any }>} */
  const info = new Map();
  const virtualCards = [];
  for (const card of cards) {
    const element = byElementId.get(cardElementId(card.id));
    if (!element || element.isDeleted) continue;
    const base = baselineRect(element);
    const userMoved = Boolean(
      base && (Math.round(element.x) !== Math.round(base.x) || Math.round(element.y) !== Math.round(base.y)),
    );
    const userResized = Boolean(
      base && (Math.round(element.width) !== Math.round(base.w) || Math.round(element.height) !== Math.round(base.h)),
    );
    let targetH = Math.round(element.height);
    if (card.kind === "html" && card.auto_h === true && !userResized && heights.has(card.id)) {
      const measured = Number(heights.get(card.id));
      if (Number.isFinite(measured) && measured > 0) {
        const clamped = Math.min(
          Math.max(Math.round(measured), HTML_CARD_LAYOUT.minHeight),
          HTML_CARD_LAYOUT.maxHeight,
        );
        if (Math.abs(clamped - element.height) >= 2) targetH = clamped;
      }
    }
    info.set(card.id, { userMoved, userResized, targetH, element });
    virtualCards.push({
      ...card,
      x: card.placed ? card.x : Math.round(element.x),
      y: card.placed ? card.y : Math.round(element.y),
      w: Math.round(element.width),
      h: targetH,
    });
  }
  if (!virtualCards.length) return { elements, changed: false };

  placeLevelCards(virtualCards, levelFlows);
  const layoutById = new Map(virtualCards.map((card) => [card.id, card]));

  let changed = false;
  const deltas = new Map();
  const updatedById = new Map();
  for (const card of cards) {
    const entry = info.get(card.id);
    const nextLayout = layoutById.get(card.id);
    if (!entry || !nextLayout) continue;
    const { element, userMoved, userResized, targetH } = entry;
    const nextX = !card.placed && !userMoved ? nextLayout.x : element.x;
    const nextY = !card.placed && !userMoved ? nextLayout.y : element.y;
    const nextW = element.width;
    const nextH = card.kind === "html" && card.auto_h === true && !userResized ? targetH : element.height;
    const posChanged = Math.abs(nextX - element.x) >= 1 || Math.abs(nextY - element.y) >= 1;
    const sizeChanged = Math.abs(nextH - element.height) >= 1;
    if (!posChanged && !sizeChanged) continue;
    changed = true;
    if (posChanged) {
      deltas.set(element.id, { x: nextX - element.x, y: nextY - element.y });
    }
    const prevBase = baselineRect(element);
    const autoRect = {
      x: !card.placed && !userMoved ? Math.round(nextX) : Math.round(prevBase ? prevBase.x : nextX),
      y: !card.placed && !userMoved ? Math.round(nextY) : Math.round(prevBase ? prevBase.y : nextY),
      w: Math.round(prevBase ? prevBase.w : nextW),
      h: !userResized ? Math.round(nextH) : Math.round(prevBase ? prevBase.h : nextH),
    };
    updatedById.set(element.id, {
      ...element,
      x: nextX,
      y: nextY,
      height: nextH,
      version: (Number(element.version) || 0) + 1,
      versionNonce: ((Number(element.versionNonce) || 0) + 1) >>> 0,
      customData: { ...(element.customData || {}), autoRect },
    });
  }
  if (!changed) return { elements, changed: false };

  const zero = { x: 0, y: 0 };
  const nextElements = elements.map((element) => {
    if (updatedById.has(element.id)) return updatedById.get(element.id);
    if (!element.isDeleted && !isCardElement(element) && !isLinkElement(element)) {
      const start = element.startBinding?.elementId;
      const end = element.endBinding?.elementId;
      if (start || end) {
        const startDelta = (start && deltas.get(start)) || zero;
        const endDelta = (end && deltas.get(end)) || zero;
        if (startDelta !== zero || endDelta !== zero) {
          const shifted = shiftArrow(element, startDelta, endDelta);
          return {
            ...shifted,
            version: (Number(element.version) || 0) + 1,
            versionNonce: ((Number(element.versionNonce) || 0) + 1) >>> 0,
          };
        }
      }
    }
    return element;
  });
  return { elements: nextElements, changed: true };
}

/** Tag reviewer-made elements with the level they were drawn on. */
export function tagLevel(elements, level) {
  return elements.map((element) =>
    elementLevel(element) === level && element.customData?.boardLevel !== undefined
      ? element
      : { ...element, customData: { ...(element.customData || {}), boardLevel: level } },
  );
}

function clip(text, max = MAX_TEXT) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function bounds(element) {
  const x = Number(element.x) || 0;
  const y = Number(element.y) || 0;
  if (Array.isArray(element.points) && element.points.length) {
    const xs = element.points.map((point) => x + Number(point[0]));
    const ys = element.points.map((point) => y + Number(point[1]));
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  }
  return { x1: x, y1: y, x2: x + (Number(element.width) || 0), y2: y + (Number(element.height) || 0) };
}

function area(rect) {
  return Math.max(0, rect.x2 - rect.x1) * Math.max(0, rect.y2 - rect.y1);
}

function intersection(a, b) {
  return {
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  };
}

function distance(rect, point) {
  const dx = Math.max(rect.x1 - point.x, 0, point.x - rect.x2);
  const dy = Math.max(rect.y1 - point.y, 0, point.y - rect.y2);
  return Math.hypot(dx, dy);
}

function center(rect) {
  return { x: (rect.x1 + rect.x2) / 2, y: (rect.y1 + rect.y2) / 2 };
}

function cardName(card) {
  return card.title ? `card #${card.id} "${clip(card.title, 80)}"` : `card #${card.id}`;
}

/**
 * Map a vertical span of a code card (scene coordinates) to source lines.
 * @param {any} card model card with code.start/end
 * @param {{ y: number, h: number }} cardRect current rect of the card element
 * @param {number} y1
 * @param {number} y2
 * @param {number} [scrollTop] the card's internal scroll offset
 */
export function codeLinesUnder(card, cardRect, y1, y2, scrollTop = 0) {
  const code = card?.code;
  if (!code || !Array.isArray(code.lines) || !code.lines.length) return null;
  const rows = codeRows(code.lines, code.cols);
  const top = cardRect.y + codeBodyTop(card);
  const first = Math.floor((Math.max(y1, top) - top + scrollTop) / CODE_CARD_LAYOUT.line);
  const last = Math.floor((Math.min(y2, cardRect.y + cardRect.h) - top + scrollTop) / CODE_CARD_LAYOUT.line);
  if (last < 0 || first > rows.length - 1 || last < first) return null;
  const from = rows[Math.max(0, first)].index;
  const to = rows[Math.min(rows.length - 1, last)].index;
  return { start: code.start + from, end: code.start + to, path: code.path };
}

function describeSpot(card, rect, mark, scrollTops) {
  if (card.kind === "code") {
    const lines = codeLinesUnder(card, rect, mark.y1, mark.y2, scrollTops?.[card.id] || 0);
    if (lines) {
      const range = lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}-${lines.end}`;
      return `${range} of ${lines.path} in ${cardName(card)}`;
    }
  }
  return cardName(card);
}

/**
 * Turn the reviewer's canvas marks into short sentences the agent can act on.
 * @param {{ cards: any[], levels: any[] }} board the model the scene was built from
 * @param {any[]} elements every element of every level (cards and marks)
 * @param {{ scrollTops?: Record<string, number> }} [options]
 */
export function summarizeBoardMarks(board, elements, { scrollTops = {} } = {}) {
  const cardsById = new Map((board?.cards || []).map((card) => [card.id, card]));
  const levels = Array.isArray(board?.levels) && board.levels.length ? board.levels : [{ id: "", title: "" }];
  const levelTitle = new Map(levels.map((level) => [level.id, level.title]));
  /** @type {Record<string, number>} */
  const stats = Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
  const lines = [];
  const all = Array.isArray(elements) ? elements : [];
  const textByContainer = new Map();
  for (const element of all) {
    if (element.type === "text" && element.containerId && !element.isDeleted) {
      textByContainer.set(element.containerId, clip(element.text || element.originalText));
    }
  }
  const levelIds = [...new Set([...levels.map((level) => level.id), ...all.map(elementLevel)])];
  for (const level of levelIds) {
    const prefix = level
      ? `[in board #${level}${levelTitle.get(level) ? ` "${clip(levelTitle.get(level), 60)}"` : ""}] `
      : "";
    const scene = all.filter((element) => elementLevel(element) === level);
    /** @type {{ card: any, rect: any, raw: any }[]} */
    const cards = [];
    for (const element of scene) {
      const id = cardIdOfElement(element);
      const card = id ? cardsById.get(id) : null;
      if (!card) continue;
      if (element.isDeleted) {
        lines.push(`${prefix}Removed ${cardName(card)} from the board`);
        stats.removed++;
        continue;
      }
      const rect = bounds(element);
      cards.push({ card, rect, raw: { y: rect.y1, h: rect.y2 - rect.y1 } });
      const before = baselineRect(element);
      if (before) {
        const moved = Math.round(element.x) !== before.x || Math.round(element.y) !== before.y;
        const resized = Math.round(element.width) !== before.w || Math.round(element.height) !== before.h;
        if (moved || resized) {
          const parts = [];
          if (moved) parts.push(`to x=${Math.round(element.x)} y=${Math.round(element.y)}`);
          if (resized) parts.push(`resized to ${Math.round(element.width)}x${Math.round(element.height)}`);
          lines.push(`${prefix}Moved ${cardName(card)} ${parts.join(", ")}`);
          stats.moved++;
        }
      }
    }
    const cardAt = (point) => {
      let best = null;
      let bestDistance = Infinity;
      for (const entry of cards) {
        const d = distance(entry.rect, point);
        if (d < bestDistance) {
          best = entry;
          bestDistance = d;
        }
      }
      return best ? { ...best, distance: bestDistance } : null;
    };
    const where = (rect) => {
      const point = center(rect);
      const hit = cardAt(point);
      if (!hit) return "on the empty canvas";
      if (hit.distance === 0) return `on ${describeSpot(hit.card, hit.raw, rect, scrollTops)}`;
      if (hit.distance <= NEAR_PX * 3) return `next to ${cardName(hit.card)}`;
      return `in empty space nearest ${cardName(hit.card)}`;
    };
    const covered = (rect) =>
      cards.filter((entry) => {
        const overlap = area(intersection(entry.rect, rect));
        return overlap > 0 && overlap >= 0.6 * area(entry.rect);
      });
    const freehand = new Map();
    for (const element of scene) {
      if (element.isDeleted || isCardElement(element) || isLinkElement(element)) continue;
      if (element.type === "text" && element.containerId) continue;
      const rect = bounds(element);
      if (element.type === "arrow" || element.type === "line") {
        stats.arrows++;
        const label = textByContainer.get(element.id);
        const points = Array.isArray(element.points) ? element.points : [[0, 0]];
        const startPoint = { x: element.x + points[0][0], y: element.y + points[0][1] };
        const lastPoint = points[points.length - 1];
        const endPoint = { x: element.x + lastPoint[0], y: element.y + lastPoint[1] };
        const end = (binding, point) => {
          const id = binding?.elementId;
          const bound = id ? cards.find((entry) => cardElementId(entry.card.id) === id) : null;
          if (bound) return describeSpot(bound.card, bound.raw, { y1: point.y, y2: point.y }, scrollTops);
          if (id) {
            const target = scene.find((item) => item.id === id);
            const text = target ? textByContainer.get(target.id) || clip(target.text) : "";
            if (text) return `the note "${text}"`;
          }
          const hit = cardAt(point);
          if (hit && hit.distance <= NEAR_PX) {
            return describeSpot(hit.card, hit.raw, { y1: point.y, y2: point.y }, scrollTops);
          }
          return null;
        };
        const from = end(element.startBinding, startPoint);
        const to = end(element.endBinding, endPoint);
        const kind = element.type === "line" ? "Line" : "Arrow";
        let sentence;
        if (from && to) sentence = `${kind} from ${from} to ${to}`;
        else if (to) sentence = `${kind} pointing at ${to}`;
        else if (from) sentence = `${kind} from ${from} into empty space`;
        else sentence = `${kind} ${where(rect)}`;
        lines.push(`${prefix}${sentence}${label ? `, labeled "${label}"` : ""}`);
        continue;
      }
      if (element.type === "text") {
        stats.notes++;
        lines.push(`${prefix}Note "${clip(element.text || element.originalText)}" ${where(rect)}`);
        continue;
      }
      if (element.type === "freedraw") {
        const point = center(rect);
        const hit = cardAt(point);
        const key = hit && hit.distance === 0 ? describeSpot(hit.card, hit.raw, rect, scrollTops) : where(rect);
        freehand.set(key, (freehand.get(key) || 0) + 1);
        stats.freehand++;
        continue;
      }
      if (element.type === "image") {
        stats.images++;
        lines.push(`${prefix}Pasted an image ${where(rect)}`);
        continue;
      }
      if (["rectangle", "ellipse", "diamond"].includes(element.type)) {
        const label = textByContainer.get(element.id);
        if (label) {
          stats.notes++;
          lines.push(`${prefix}Sticky note "${label}" ${where(rect)}`);
          continue;
        }
        stats.shapes++;
        const verb = element.type === "ellipse" ? "Circled" : "Boxed";
        const around = covered(rect);
        if (around.length) {
          lines.push(`${prefix}${verb} ${around.map((entry) => cardName(entry.card)).join(", ")}`);
        } else {
          const hit = cardAt(center(rect));
          if (hit && hit.distance === 0) {
            lines.push(`${prefix}${verb} ${describeSpot(hit.card, hit.raw, rect, scrollTops)}`);
          } else {
            lines.push(`${prefix}Drew a ${element.type} ${where(rect)}`);
          }
        }
      }
    }
    for (const [spot, count] of freehand) {
      const target =
        spot.startsWith("on ") || spot.startsWith("next to") || spot.startsWith("in ") ? spot : `on ${spot}`;
      lines.push(`${prefix}Freehand mark${count === 1 ? "" : "s"} ${target}`);
    }
  }
  const overflow = lines.length - MAX_SUMMARY_LINES;
  const bounded = overflow > 0 ? [...lines.slice(0, MAX_SUMMARY_LINES), `...and ${overflow} more marks`] : lines;
  return { lines: bounded, stats };
}

/**
 * Which lines of `live` are not in `pinned` (by longest common subsequence),
 * and how many pinned lines are gone. Used to mark what changed on a stale
 * code card without changing its line layout.
 * @param {string[]} pinned
 * @param {string[]} live
 */
export function diffCodeLines(pinned, live) {
  const a = (Array.isArray(pinned) ? pinned : []).map((line) => String(line).replace(/[ \t]+$/, ""));
  const b = (Array.isArray(live) ? live : []).map((line) => String(line).replace(/[ \t]+$/, ""));
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const kept = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(j);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  const changed = [];
  for (let index = 0; index < b.length; index++) if (!kept.has(index)) changed.push(index);
  return { changed, removed: a.length - kept.size };
}

function boundedInt(value, max = 10_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), max);
}

// Fixed-shape copies of the board prompt targets, so a hostile POST cannot put
// arbitrary structure in state.json or in front of the agent.
export function normalizeBoardCanvasTarget(target) {
  const stats = target?.stats && typeof target.stats === "object" && !Array.isArray(target.stats) ? target.stats : {};
  return {
    type: BOARD_CANVAS_TARGET_TYPE,
    revision: String(target?.revision || "").slice(0, 64),
    scenePath: String(target?.scenePath || ""),
    previewPath: String(target?.previewPath || ""),
    stats: Object.fromEntries(STAT_KEYS.map((key) => [key, boundedInt(stats[key])])),
  };
}

export function normalizeBoardCardTarget(target) {
  const kind = ["html", "code", "board"].includes(target?.kind) ? target.kind : "html";
  /** @type {Record<string, unknown>} */
  const normalized = {
    type: BOARD_CARD_TARGET_TYPE,
    card: String(target?.card || "").slice(0, 200),
    kind,
    title: clip(target?.title, 160),
  };
  if (kind === "code") {
    normalized.code = String(target?.code || "").slice(0, 500);
    normalized.status = ["fresh", "unpinned", "moved", "stale", "missing", "invalid"].includes(target?.status)
      ? target.status
      : "unpinned";
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Trackpad and wheel: one intent per wheel event, so a precision trackpad, a
// mouse wheel and a pinch all move the canvas the same way in every browser.

export const WHEEL = Object.freeze({
  line: 16, // px per line when a browser reports wheel deltas in lines
  maxPan: 400, // px per event: a wheel-delta spike never jumps the board
  maxZoomDelta: 25, // a pinch or ctrl+wheel step, clamped the same way
  zoomRate: 0.01, // zoom changes by e^(-delta * rate), so steps feel the same at any zoom
  minZoom: 0.1,
  maxZoom: 30,
});

const clampAbs = (value, max) => Math.max(-max, Math.min(max, Number.isFinite(value) ? value : 0));

/**
 * What one wheel event means for the canvas. Pinch (ctrlKey on every desktop
 * browser) and ctrl or cmd + wheel zoom; everything else pans, with shift
 * turning a vertical mouse wheel sideways.
 * @param {{ deltaX?: number, deltaY?: number, deltaMode?: number, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean }} event
 * @param {{ pageHeight?: number }} [options]
 * @returns {{ kind: "zoom", factor: number } | { kind: "pan", dx: number, dy: number }}
 */
export function wheelIntent(event, { pageHeight = 800 } = {}) {
  const unit = event.deltaMode === 1 ? WHEEL.line : event.deltaMode === 2 ? Math.max(1, pageHeight) : 1;
  let dx = (Number(event.deltaX) || 0) * unit;
  let dy = (Number(event.deltaY) || 0) * unit;
  if (event.ctrlKey || event.metaKey) {
    const delta = clampAbs(dy || dx, WHEEL.maxZoomDelta);
    return { kind: "zoom", factor: Math.exp(-delta * WHEEL.zoomRate) };
  }
  if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
  return { kind: "pan", dx: clampAbs(dx, WHEEL.maxPan), dy: clampAbs(dy, WHEEL.maxPan) };
}

/**
 * The view after zooming by `factor` around a viewport point, keeping the
 * scene point under it still. Views are Excalidraw's: a scene point (x, y)
 * shows at ((x + scrollX) * zoom, (y + scrollY) * zoom).
 * @param {{ zoom: number, scrollX: number, scrollY: number }} view
 * @param {number} factor
 * @param {{ x: number, y: number }} point viewport coordinates inside the canvas
 */
export function zoomAround(view, factor, point) {
  const zoom = Math.max(WHEEL.minZoom, Math.min(WHEEL.maxZoom, view.zoom * factor));
  return {
    zoom,
    scrollX: point.x / zoom - (point.x / view.zoom - view.scrollX),
    scrollY: point.y / zoom - (point.y / view.zoom - view.scrollY),
  };
}

/**
 * Whether a scroll container can still move by (dx, dy): the board pans only
 * once the code under the pointer has nothing left to scroll that way.
 * @param {{ scrollTop: number, scrollLeft: number, scrollHeight: number, scrollWidth: number, clientHeight: number, clientWidth: number }} box
 */
export function canScrollBy(box, dx, dy) {
  const room = (offset, size, view, delta) =>
    delta < 0 ? offset > 0.5 : delta > 0 ? offset + view < size - 0.5 : false;
  return (
    (Math.abs(dy) >= Math.abs(dx) && room(box.scrollTop, box.scrollHeight, box.clientHeight, dy)) ||
    (Math.abs(dx) > Math.abs(dy) && room(box.scrollLeft, box.scrollWidth, box.clientWidth, dx))
  );
}
