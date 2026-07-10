export const PLAYBOOK_ROUTER_INSTRUCTION =
  "MUST open each matching playbook before writing HTML. Match against the use_when trigger; one artifact often combines several playbooks.";

export const PLAYBOOK_ROUTER_HELP =
  "One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.";

export const PLAYBOOKS = [
  {
    id: "diagram",
    use_when: "Map relationships, flows, state, and architecture",
    choose: [
      "Use Mermaid when automatic node placement and edge routing matter more than rich card content.",
      "Use CSS grid, SVG, or positioned HTML when each item needs prose, code, controls, or detailed annotations.",
      "Use a hybrid shape for large systems: a small overview diagram followed by detailed module cards.",
    ],
    structure: [
      "Lead with the question the diagram answers, not with the implementation detail that produced it.",
      "Keep the first visual to the core relationship, then put dense evidence or file references below it.",
      "For complex systems, separate topology from detail so the overview stays readable.",
    ],
    design_rules: [
      "Use page-scoped class names and avoid generic names like .node that can collide with diagram libraries.",
      "Prefer top-down flow for multi-step diagrams unless the flow is genuinely linear and short.",
      "Quote labels that contain punctuation or code-like names, and use explicit line breaks where the renderer supports them.",
      "Initialize Mermaid to match the page theme and re-render when the theme changes: pick the Mermaid theme from the effective page appearance (light or dark) at render time, and use the theme-aware `lavish-axi design` Mermaid snippet rather than hardcoding a single theme, since Mermaid does not restyle an already-rendered SVG when the viewer toggles the page theme.",
    ],
    pitfalls: [
      "Do not cram every file or function into one diagram when a layered explanation would be clearer.",
      "Do not hand-build boxes-and-arrows from div/flexbox for a flow: it does not auto-route edges and reads worse than Mermaid; reach for Mermaid or SVG for richly annotated nodes.",
      "Do not let default diagram colors clash with the page palette or dark mode.",
      "Do not present unverified architecture claims as facts. Cite the files or commands that support them.",
    ],
    lavish_notes: [
      "A Lavish diagram should invite precise annotation: make modules, edges, and captions easy to click and discuss.",
      "When a relationship is uncertain, label it as a question so the user can resolve it in the review loop.",
    ],
  },
  {
    id: "table",
    use_when: "Turn dense records into scan-friendly review surfaces",
    choose: [
      "Use a table when rows share the same fields and the user needs to compare evidence quickly.",
      "Use cards when each record has a different shape or needs a long explanation.",
      "Use summaries above the table when counts, risk levels, or statuses change how the table should be read.",
    ],
    structure: [
      "Start with a short summary of what the rows prove or require.",
      "Group columns by the decision they support: identity, evidence, status, action.",
      "Keep raw details available, but make the primary status visible without reading every cell.",
    ],
    design_rules: [
      "Use semantic table markup when the data is tabular.",
      "Protect long paths, code symbols, URLs, and prose from overflowing on narrow screens.",
      "Use restrained color for status and severity so the table remains readable when printed or skimmed.",
    ],
    pitfalls: [
      "Do not paste a terminal table into HTML and call it done.",
      "Do not hide the important conclusion below a large undifferentiated grid.",
      "Do not use color as the only status signal.",
    ],
    lavish_notes: [
      "A Lavish table should make individual rows easy annotation targets.",
      "If a row implies a follow-up change, include an action control that queues a specific prompt.",
    ],
  },
  {
    id: "comparison",
    use_when: "Show options, tradeoffs, and current vs target behavior",
    choose: [
      "Use before and after when the same system is changing over time.",
      "Use option cards when the user needs to choose between mutually exclusive directions.",
      "Use a scorecard only when the criteria are explicit and comparable.",
    ],
    structure: [
      "Name the decision at the top of the artifact.",
      "Show the concrete behavior or artifact shape for each side, not just abstract pros and cons.",
      "End with a recommendation only when the evidence actually supports one.",
    ],
    design_rules: [
      "Keep corresponding details aligned so differences are visible without hunting.",
      "Use visual hierarchy to separate primary tradeoffs from secondary notes.",
      "Make the cost of each option as visible as the benefit.",
    ],
    pitfalls: [
      "Do not make every option look equally recommended if one is clearly preferred.",
      "Do not compare vague summaries when concrete examples are available.",
      "Do not bury assumptions that would change the recommendation.",
    ],
    lavish_notes: [
      "A Lavish comparison should let the user annotate the exact option or tradeoff they want changed.",
      "If the goal is selection, provide controls that queue the chosen option with rationale.",
    ],
  },
  {
    id: "plan",
    use_when: "Explain a product or technical plan before implementation",
    choose: [
      "Use this when the user needs to inspect a feature approach before implementation begins.",
      "Use it when the user explicitly asked for a PRD, technical design, implementation plan or proposal.",
      "Use a lighter comparison or diagram playbook when the plan is only a single small design choice.",
    ],
    structure: [
      "Start with the goal, the current state, and desired behavior.",
      "Then describe a proposed approach, focusing on high level decisions.",
      "At the end, list any risks you see, and open questions you have, and follow the 'comparison' playbook to provide options for the user to choose from.",
    ],
    design_rules: [
      "Verify each claim against the codebase before presenting it as fact.",
      "When discussing frontend experiences, prefer visually mocking the experience under a consistent design system as the real product over describing it with text.",
      "The plan needs to be self-contained enough that another developer can read it and fully implement the proposal.",
    ],
    pitfalls: [
      "Do not leave resolved open questions in the artifact. Update existing content to reflect the decision and remove the open question.",
      "Do not only focus on ambiguous decisions and omit the actual proposal.",
      "Do not omit failure modes, migration concerns, or backwards compatibility questions.",
    ],
    lavish_notes: ["A Lavish plan should make a plan and its uncertainties easy to annotate before code exists."],
  },
  {
    id: "code",
    use_when: "Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts",
    choose: [
      "Use this whenever an artifact shows source code: a snippet, full file, patch, PR diff, local change set, or before/after code.",
      "Use File for one code file, FileDiff for old/new versions or parsed patch metadata, and CodeView only when several files or diffs need coordinated navigation.",
      "Choose split layout for careful side-by-side review when width allows; choose unified layout when space is tight, changes are mostly additive, or mobile readability matters.",
    ],
    structure: [
      "Place the path, language, and reason to inspect the code immediately before each rendered file or diff.",
      "Keep evidence close to each claim with file paths, line references, or annotations next to the relevant code.",
      "For multi-file changes, group files by user-facing area or task instead of dumping a raw patch in repository order.",
    ],
    design_rules: [
      `Rendering MUST use @pierre/diffs, not hand-rolled <pre> blocks or another diff library. This verified no-build standalone HTML snippet renders one file and one split diff from esm.sh:
\`\`\`html
<div id="file"></div>
<div id="diff"></div>
<script type="module">
  import { File, FileDiff } from "https://esm.sh/@pierre/diffs@1.2.10?bundle";

  const theme = { light: "github-light", dark: "github-dark" };
  const options = { theme, themeType: "dark", overflow: "wrap" };
  const oldFile = {
    name: "src/greeting.ts",
    contents: "export function greet(name: string) {\\n  return \\"Hello \\" + name;\\n}\\n\\nconsole.log(greet(\\"Lavish\\"));\\n",
  };
  const newFile = {
    name: "src/greeting.ts",
    contents: "export function greet(name: string) {\\n  return \\"Hello, \\" + name + \\"!\\";\\n}\\n\\nconsole.log(greet(\\"Lavish\\"));\\n",
  };

  new File(options).render({
    containerWrapper: document.querySelector("#file"),
    file: newFile,
  });

  new FileDiff({ ...options, diffStyle: "split" }).render({
    containerWrapper: document.querySelector("#diff"),
    oldFile,
    newFile,
  });

</script>
\`\`\``,
      "Pick a Shiki theme pair that matches the artifact's DaisyUI or Tailwind direction and light or dark mode; replace the GitHub pair above when the page is not GitHub-like.",
      'Use FileDiff diffStyle: "split" for side-by-side review and diffStyle: "unified" for stacked reading; keep overflow: "wrap" unless horizontal alignment is essential.',
      "Use @pierre/diffs line annotations, selections, and headers when calling out specific lines so notes stay attached to code.",
    ],
    pitfalls: [
      "Do not render code as static screenshots, plain <pre> blocks, or markdown pasted into HTML.",
      "Do not choose an arbitrary default Shiki theme that clashes with the page palette or dark mode.",
      "Do not show huge unrelated files when a focused render range, parsed patch file, or grouped summary would be clearer.",
      "Do not separate a claim from the code lines that prove it.",
    ],
    lavish_notes: [
      "A Lavish code artifact should make each file, hunk, and relevant line easy to annotate precisely.",
      "When a user action should trigger a fix, queue prompts that name the file path, line range, and desired change.",
      "If the artifact combines code with a plan, table, or comparison, read those playbooks too and keep @pierre/diffs responsible for the code surface.",
    ],
  },
  {
    id: "input",
    use_when:
      "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
    choose: [
      "Use this when the user needs to select, tune, triage, annotate, or edit a structured choice.",
      "Use controls for decisions the user can make faster visually than by writing a prompt.",
      "Use plain annotations when the artifact only needs open-ended feedback.",
    ],
    structure: [
      "Make each decision surface visible: what is being chosen, what the options mean, and what happens next.",
      "Keep reversible selection state local in the artifact until the user explicitly submits that question.",
      "Pair each question with a Submit or Queue answer control that sends exactly one prompt for the final answer.",
      "Show selected state separately from queued state so the user trusts what will be sent back.",
    ],
    design_rules: [
      "Native controls - radios, checkboxes, text inputs, selects, textareas, buttons, options, labels, disclosure summaries, and contenteditable regions - are interactive automatically: clicks toggle, focus, and type instead of annotating, so they do not need data-lavish-action. Build choice and option UIs from these whenever you can.",
      "For reversible choices, do not call window.lavish.queuePrompt() from radio change handlers or option click handlers. Those handlers should only update local selected state.",
      "Use a per-question form submit or explicit Queue answer button to read the current values and call window.lavish.queuePrompt() exactly once for the final answer.",
      "Put data-lavish-action only on custom (non-native) elements that should act like a feedback control - typically a styled div or span you made clickable - so Lavish does not annotate it and shows a pointer cursor instead.",
      "Use data-lavish-question on a question wrapper or pass queueKey when multiple pre-send updates should replace the prior unsent answer for the same question.",
      "Pass options such as tag, text, selector, target, data, queueKey, or element when they help the agent understand exactly what the user chose.",
      "Call window.lavish.sendQueuedPrompts() only when the control should immediately send committed feedback instead of waiting for the user to press Send to Agent.",
      "Make queued prompts specific enough that the agent can act without asking a follow-up question.",
      "Keep native browser controls accessible and readable on mobile.",
    ],
    pitfalls: [
      "Do not queue one prompt per radio change, checkbox toggle, dropdown change, or choice-button click when the user can still change their mind.",
      "Do not create controls whose queued prompt is unclear or too vague to execute.",
      "Do not hide the difference between selected locally and queued for the agent.",
      "Do not require interaction for content the user only needs to read.",
    ],
    lavish_notes: [
      "Lavish is strongest when the artifact becomes a focused review surface and not just a static page.",
      'A native single-choice question should submit the final value: `<form data-lavish-question="plan" onsubmit="event.preventDefault(); const choice = new FormData(event.currentTarget).get(\'plan\'); if (choice) window.lavish.queuePrompt(\'Use the \' + choice + \' plan\', { tag: \'choice\', text: \'Plan: \' + choice, element: event.currentTarget, data: { question: \'plan\', answer: choice } });"><label><input type="radio" name="plan" value="Starter"> Starter</label><label><input type="radio" name="plan" value="Pro"> Pro</label><button type="submit">Queue this answer</button></form>`.',
      "A custom choice UI should make option buttons update local state, then use a separate Queue answer button with data-lavish-action to queue the final selected value.",
      "Use window.lavish.queuePrompt for user intent, not internal analytics or UI-only state changes.",
      "End input paths with an obvious way for the user to send feedback back to the agent.",
    ],
  },
  {
    id: "slides",
    use_when: "Create a deliberate presentation when slides are requested",
    choose: [
      "Use slides only when the user asks for a deck, presentation, talk, or paced walkthrough.",
      "Use a scroll page when the user needs reference material, detailed review, or dense evidence.",
      "Use one idea per slide when the artifact has a narrative arc.",
    ],
    structure: [
      "Plan the story before writing the slide markup.",
      "Open with the point, build context, show evidence, and close with the decision or next action.",
      "Vary slide composition so the deck does not feel like repeated cards.",
    ],
    design_rules: [
      "Keep slide text sparse and let visuals carry the explanation.",
      "Use large type, strong alignment, and deliberate whitespace rather than dense paragraphs.",
      "Make navigation and screen-size assumptions explicit in the artifact.",
    ],
    pitfalls: [
      "Do not turn every explainer into slides by default.",
      "Do not paste a scroll-page outline into fixed-size frames without rewriting the narrative.",
      "Do not make consecutive slides with the same spatial composition unless repetition is the point.",
    ],
    lavish_notes: [
      "A Lavish slide deck can still collect feedback, but each prompt should refer to a slide or decision.",
      "Use slides for persuasion or presentation, not for dense code review.",
    ],
  },
];

export function listPlaybooks() {
  return PLAYBOOKS.map(({ id, use_when }) => ({ id, use_when }));
}

export function findPlaybook(id) {
  return PLAYBOOKS.find((playbook) => playbook.id === id) || null;
}

export function playbookIds() {
  return PLAYBOOKS.map((playbook) => playbook.id);
}
