# Lavish Design System

> _For when a rich editor is not rich enough._

This is the brand & design system for **Lavish** — an in-browser agentic editor that opens agent-generated HTML artifacts in a local browser, lets a human pinpoint elements or selected text, annotate them, and ship that feedback back to the agent.

The product feels like a quiet reading room with a brass lamp: dark ink walls, a single warm gold accent, generous type set in a literary serif beside a clean technical sans. Elegant. Minimal. Futuristic. _Lavish._

---

## Sources

This system was reverse-engineered from the public source of truth:

- **Codebase:** [`kunchenguid/lavish-axi`](https://github.com/kunchenguid/lavish-axi) — the CLI + local HTTP server that ships the Lavish Editor UI. The chrome HTML originates in `src/server.js` (`createChromeHtml`), chrome styling and browser behavior originate in `src/chrome.css` and `src/chrome-client.js`, and the in-iframe annotation SDK and its styling originate in `src/artifact-sdk.js` (`createArtifactSdk`). The README, AGENTS.md and CONTRIBUTING.md provided the product narrative.
- **Brand promise** is paraphrased from the repository README: _"HTML is the new markdown. Lavish is the new editor for your HTML artifacts."_

No Figma file or slide deck was provided. Slide templates were therefore **not** generated; if you have a deck, point this skill at it and I'll add a `slides/` folder.

---

## Product context

Lavish is one product wearing two hats:

| Surface                | Audience                                                                  | What it looks like                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI** (`lavish-axi`) | Coding agents (Claude Code, Cursor, etc.) and the developers driving them | A long-polling, AXI-shaped command surface. Output is TOON-serialized. Not visually designed — it's _agent-ergonomic._                                                                                                  |
| **Editor chrome**      | Humans reviewing an agent's HTML artifact                                 | A two-pane browser app: the artifact in an iframe on the left, a conversation panel on the right, a session bar across the top. Click any element or select text in the artifact, queue a prompt, send it to the agent. |

The brand surface this design system serves is **the Editor chrome.** Marketing, docs, decks and screenshots should all feel like they came from the same hand that drew the chrome.

---

## Index

```
.
├── README.md                  ← you are here
├── SKILL.md                   ← skill manifest (read this when invoking as an Agent Skill)
├── colors_and_type.css        ← design tokens: colors, type scale, spacing, radii, shadows
├── fonts/                     ← self-hosted webfonts (EB Garamond, Geist, Geist Mono)
├── assets/                    ← logos, marks, glyphs, background imagery
├── preview/                   ← Design System tab cards (color, type, components…)
├── ui_kits/
│   └── editor/                ← high-fidelity recreation of the Lavish Editor chrome
│       ├── index.html         ← clickable prototype: artifact iframe + chat + annotation card
│       ├── *.jsx              ← React components (TopBar, ChatPanel, ArtifactFrame, …)
│       └── README.md          ← how the kit is composed
```

---

## Content fundamentals

Lavish copy reads like a well-edited reading-room sign — _short, declarative, a little literary._ It is written by people who care about a comma.

**Voice**

- **Second-person, agent-aware.** Most copy addresses the user (_"Tell your agent…"_), but it never forgets there are _two_ readers: a human and an agent. Where it's helpful, the copy explicitly addresses the agent in the same breath (_"agents should normally omit it"_).
- **Confident without bravado.** No exclamation marks. No "🚀". The product asserts what it _is_ in one line — _"For when a rich editor is not rich enough"_ — and lets the rest of the page work.
- **Literary cadence.** Sentences are crafted, not assembled. Words like _artifact_, _snapshot_, _canonical_, _ergonomic_ show up unforced. Avoid SaaS adjectives ("seamless," "powerful," "revolutionary").

**Tone**

- **Calm. Considered. Specific.** When something is technical, name it precisely. When something is a feeling, write it as a feeling.
- **A wink, occasionally.** _"git push no-mistakes."_ _"For when a rich editor is not rich enough."_ A dry, deadpan sense of humor — never goofy.

**Casing**

- **Sentence case for everything user-facing.** Buttons (_"Send to Agent"_, _"End Session"_) are an exception: they use **Title Case** because they read as proper actions, not labels.
- **lowercase command names** (`lavish-axi`, `pnpm run build`) — never SHOUTY, never `Lavish-Axi`.
- The brand mark **Lavish** is Title Case in prose; in product chrome it's set in a slightly heavier weight (`font-weight: 750`) with a touch of tracking (`letter-spacing: .02em`).

**Pronouns**

- Speak to the user as **you**.
- Speak of the agent as **the agent** — third person, no anthropomorphizing pet name.
- _"We"_ is reserved for the team writing docs (rare); never _"our AI."_

**Emoji & ornamentation**

- **No emoji.** Anywhere. Not in headers, not in buttons, not in error toasts.
- **Unicode dingbats sparingly.** An em dash (—), a middle dot (·), a section sign (§) are welcome. ASCII box-drawing diagrams are _on-brand_ (see the README's How It Works diagram).
- **No exclamation marks** except in code (`fn!()`).

**Examples lifted directly from the product**

> _"For when a rich editor is not rich enough."_
> _"HTML is the new markdown. Lavish is the new editor for your HTML artifacts."_
> _"Browser-native review · Precise feedback · Agent-ergonomic interface"_
> _"Session ended. The agent polling loop can stop."_
> _"Write a message for the agent…"_
> _"Tell the agent what to change about this element…"_

If new copy doesn't sit comfortably next to those lines, rewrite it.

---

## Visual foundations

**The mood.** Late-evening reading light. A dark wood desk. One brass lamp. The page you're editing is the only bright thing in the room.

### Colors

- **Ink** — the canvas. `#0f1115` for the artifact frame surround and composer input. `#11141a` for side panels. `#171a21` for the top bar. Never pure black: the warm cream type would feel clinical against it.
- **Cream** — the type. `#f7f3ea`. A paper-warm off-white that reads at low contrast as candlelit, at high contrast as legible. All primary type sits on ink in cream.
- **Brass** — the single accent. `#f4c95d`. Used for the primary CTA, the annotation outline (2px solid, 2px offset), selected-text range highlights (`rgba(244,201,93,.28)` with a `rgba(244,201,93,.45)` stroke), the brand mark moment, and absolutely nothing else. Its ink-on-brass pair is `#17130a` — a deep almost-black that keeps the gold from feeling like a neon button.
- **Sage** — the _agent_ signal. `#172419` background, `#315f3a` border, `#8fe39e` for the working spinner. Used only on agent chat bubbles and the working indicator.
- **Amber** — the _user_ signal. `#25230f` background, `#5d4d1b` border. Used only on user chat bubbles and queued-prompt pills.
- **Rust** — the danger signal. `#f06464`. Reserved for _End Session_ and destructive confirmations.
- **Steels** — the grays. `#2a2f3a` / `#303745` / `#3c4557` for borders, ranked subtle → strong. `#b9c0cf` / `#d8deea` / `#aeb6c6` / `#8c96aa` for muted type, ranked bright → dim.

No gradients. No glassmorphism. No bluish-purple anything.

### Type

Three families do all the work:

- **Display & literary moments → EB Garamond** (serif). The brand mark, marketing headlines, the title of a piece. Italic feels especially right for callouts and pull-quotes — Garamond's italic is one of the most beautiful in the world.
- **Body & UI → Geist Sans** (sans). The repository's chrome uses `ui-sans-serif, system-ui, sans-serif`; Geist is the closest modern foundry sans with the same low-fuss tone. 14px / 1.4 line-height in product chrome, scaled up for marketing.
- **Code & technical → Geist Mono** (mono). Replaces `ui-monospace, SFMono-Regular, Menlo`. Used for selectors, file paths, CLI snippets, anywhere the user is reading literal characters.

The brand mark **Lavish Editor** is set in Geist Sans at `font-weight: 750` with `letter-spacing: .02em`. Bold but not heavy. The serif is for prose — never UI labels.

### Spacing & rhythm

- **8-pt grid** with a `4` and `2` half-step. The chrome uses `6 / 8 / 10 / 12 / 16 / 24 / 32` repeatedly.
- **Top bar height: 56px.** Sticky. The one truly fixed element.
- **Panel gutter: 360px** for the side conversation panel; the artifact takes the rest.
- Composer padding: `12px 16px`. Buttons: `9–10px 12px`.

### Radii

- `8px` — input affordances inside cards (the selector chip, tooltip panels)
- `10px` — buttons, small cards
- `12px` — textareas, large inputs, composer pills' parent
- `14px` — chat bubbles, annotation card
- `999px` — queued-prompt pills only

There is **no `border-radius: 4px`** in this system. We round generously or not at all.

### Borders

Always 1px. Borders are the _only_ way one ink surface separates from another — there are no drop shadows between panels.

### Shadows

Shadows are reserved for _floating_ surfaces:

- **Tooltip / popover:** `0 16px 44px rgba(0,0,0,.35)`
- **Annotation card (lives over the artifact):** `0 20px 70px rgba(0,0,0,.35)`

Never on buttons. Never on cards that sit _inside_ a panel. The aesthetic is _paper on ink,_ not _card stack._

### Backgrounds & imagery

- **No background images in chrome.** The product is the artifact; the chrome gets out of the way.
- **Marketing imagery:** when present, prefer warm-toned photography (candlelight, brass, leather, vellum). Subtle film grain is welcome. No stock-photo handshakes. No 3D blobs.
- **No repeating patterns.** A single hairline rule, occasionally a thin top-border on a section, is plenty.

### Animation

- **Fades over moves.** Opacity and color transitions, 120–180ms, `ease-out`.
- **One exception:** the agent-working spinner — a steady `0.8s linear` rotation. Borrowed directly from the product.
- **No bounce. No spring. No elastic.** Lavish does not boing.

### States

- **Hover (interactive surfaces):** raise opacity, never lighten. On already-bright elements (the brass CTA), shift the background toward `#ffd877`. On muted text, lift cream to `#fffbf3`.
- **Press:** drop opacity to ~0.85; no scale, no shadow shift.
- **Disabled:** `opacity: .55; cursor: not-allowed;` — directly from the product.
- **Focus:** a 2px brass outline, 2px offset. Identical to the annotation hover/select outline — focus and "this element is being annotated" use the _same_ visual language because they mean the same thing: _attention is here._

### Transparency & blur

Almost never. The annotation card is solid `#11141a` over the artifact — not a translucent veil. The only acceptable blur is the artifact iframe being momentarily hidden during a session-ended flash.

### Cards

A "card" in Lavish is a slab of `#11141a` or `#1c212b` with a 1px border (`#303745`) and a generous radius (`12–14px`). **No shadow.** No left-color-accent stripe. The content is the card; the chrome is the frame.

### Layout rules

- The top bar is fixed at 56px, full-width, sticky.
- The side conversation panel is a fixed 360px wide on the right.
- The artifact takes the remainder.
- The annotation card is positioned relative to the clicked element or selected text range via `getBoundingClientRect()` and clamped 12px from any viewport edge.
- The chat input lives at the bottom of the side panel; pills (queued prompts) sit _above_ the textarea, never inside it.

---

## Iconography

**Lavish ships almost no icons.** Read that twice.

The product chrome you've seen has exactly **one** glyph: the spinner. Buttons are _labeled_, not iconified — "Send to Agent," "End Session," "Annotation: On." The annotation card opens with `<h2>Annotate &lt;div&gt;</h2>` for elements or `Annotate text` for selected text — the _target name_ is the icon. This is intentional and on-brand: in a literary product, words are the iconography.

When iconography is genuinely needed (marketing, an empty state, a settings menu in a future surface), follow these rules:

1. **Stroke, not fill.** 1.5px stroke, round joins, round caps.
2. **20×20 viewBox** for inline UI icons; **24×24** for larger ones.
3. **Currentcolor only.** Icons inherit the parent's color so they tint cream on ink, brass on the CTA, sage on agent bubbles.
4. **Lucide as the substitute set.** The codebase does **not** ship its own icon font or SVG sprite, so this system uses [Lucide](https://lucide.dev) at the CDN as the closest aesthetic match (thin, geometric, monoline). **Flagged substitution — see Caveats.**
5. **No emoji. No Unicode dingbat icons** in the chrome. The em dash and middle dot are fine in prose; ✅ ✨ 🔥 are not on brand and will never be.
6. **The brand mark** is wordmark only — _Lavish Editor_ set in Geist Sans 750 with `.02em` tracking. There is no symbol. (`assets/lavish-wordmark.svg`.)

To use Lucide via CDN:

```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<i data-lucide="square-pen"></i>
<script>
  lucide.createIcons();
</script>
```

If you reach for an icon and can't justify it in one sentence, delete it.

---

## Caveats (please read)

1. **Font substitution.** The repo uses system fonts (`ui-sans-serif`, `ui-monospace`). For the brand surface I've upgraded to **Geist Sans** + **Geist Mono** (both Google Fonts) and added **EB Garamond** as the literary serif. These are aesthetic _additions_ — if you prefer to stay system-only, swap the `--font-sans` and `--font-mono` variables in `colors_and_type.css` and remove the `@import`. If you have licensed faces you'd rather use (e.g. _Söhne_, _GT America_, _Berkeley Mono_), drop them into `fonts/` and update the same variables.
2. **No icon font in the repo.** I'm substituting **Lucide** (CDN). If you want a different set (Phosphor, Heroicons, Tabler), say the word.
3. **No Figma / no slides.** I built only what the codebase justifies. Hand me a Figma URL or a deck and I'll add `slides/` and a marketing kit.
4. **The product surface I've recreated is the Editor chrome.** The CLI is intentionally not "designed" — it's TOON output and tables — so it lives only in `README.md`, not in `ui_kits/`.

**Your turn:** open the Design System tab to flip through every card, then open `ui_kits/editor/index.html` to play with the clickable chrome. **Tell me what feels off.** Specifically: the gold, the serif/sans pairing, the chat-bubble palette, and whether the agent-as-sage / user-as-amber metaphor lands. Those four decisions cascade into everything else.
