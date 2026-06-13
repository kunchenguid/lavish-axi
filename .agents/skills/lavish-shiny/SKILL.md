---
name: lavish-shiny
description: Launch a Shiny app from the project folder and use Lavish Editor to interactively annotate Shiny app components, letting the agent modify R/Shiny code based on user comments.
argument-hint: <what part of the Shiny app to review or modify>
author: Antigravity
metadata:
  hermes:
    tags: [r, shiny, review, interactive, annotation]
    category: productivity
---

# Lavish Shiny

Lavish Shiny helps agents interactively review and iterate on R Shiny applications. By launching a local Shiny app and proxying it through Lavish, the user can visually annotate elements and send feedback directly to the agent. The agent then modifies the R source code (`app.R`, `ui.R`, `server.R`) to update the app.

You do not need lavish-axi installed globally - invoke it with `npx -y lavish-axi shiny <app-dir>`.
If lavish-axi output shows a follow-up command starting with `lavish-axi`, run it as `npx -y lavish-axi ...` instead.

**Important**: Do NOT use the regular `lavish` skill for Shiny apps. Always use `lavish-axi shiny`, never `lavish-axi <file.html>` or `lavish-axi design`. The `lavish` skill creates static HTML artifacts; `lavish-shiny` proxies a live running Shiny app.

## When to use

Use this skill when:

- The user asks to build, modify, or debug an R Shiny application.
- The user wants to visually review and annotate layout, styling, inputs, or outputs of a Shiny app.
- The user has already launched a Shiny app (e.g., from RStudio or via `Rscript`) and wants to annotate it.

## Workflow

There are two modes. Choose based on whether the Shiny app is already running:

### Attached mode (app already running)

Use this when the user says the app is already running on a URL (e.g., `http://127.0.0.1:8080`). No R environment check is needed.

1. **Launch Lavish session**: Run `npx -y lavish-axi shiny <app-dir> --url <url>` where `<app-dir>` is the project directory containing the R source files and `<url>` is the running app URL.
2. **Poll for annotations**: Run `npx -y lavish-axi poll <app-dir>`. The poll stays silent and waits for user annotations - leave it running, never kill it.
3. Continue from step 4 below.

### Managed mode (agent launches the app)

Use this when the user does not have a running Shiny app. The CLI will spawn and manage the R process.

1. **Verify R environment**: Confirm R and the `shiny` package are installed.
2. **Launch Shiny app in Lavish**: Run `npx -y lavish-axi shiny <app-dir>`.
3. **Poll for annotations**: Run `npx -y lavish-axi poll <app-dir>`. The poll stays silent and waits for user annotations - leave it running, never kill it.
4. Continue from step 4 below.

### Common steps (both modes)

4. **Receive feedback**: When the user clicks "Send to Agent", the poll returns:
   - `prompts`: User annotations with element selectors, tags, and comments.
   - `dom_snapshot`: A snapshot of the app's DOM tree at the time of annotation.
5. **Apply code modifications**: Locate the corresponding R components in the code and edit them:
   - Output annotations (e.g. `plotOutput("myPlot")` / `renderPlot()`)
   - Input annotations (e.g. `sliderInput("range")`)
   - Layout elements (e.g. `sidebarPanel()`, `tabsetPanel()`)
6. **Live reload**: Saving changes to `.R`, `.css`, or `.js` files will automatically reload the app in the user's browser.
7. **Reply & Wait**: Run `npx -y lavish-axi poll <app-dir> --agent-reply "Applied the changes!"` to show your message in the browser and wait for further annotations.
8. **End session**: Run `npx -y lavish-axi end <app-dir>` when the review session is complete.

## Mapping DOM Elements to R Source

When you receive feedback, use the DOM context to locate the R code:

- **Input elements**: Look for class `shiny-input-container`. The element's `id` or child `input`/`select`/`textarea` `id` directly maps to the input ID in `ui.R` (e.g., `<input id="dataset">` -> `selectInput("dataset", ...)`).
- **Output elements**: Look for classes like `shiny-plot-output`, `shiny-text-output`, `shiny-html-output`, or `shiny-bound-output`. The element's `id` maps to:
  - `*Output("id")` in `ui.R`
  - `output$id <- render*()` in `server.R`
- **Layout structures**: Standard Shiny layout wrappers have Bootstrap classes:
  - `container-fluid` -> `fluidPage()`
  - `row` -> `fluidRow()` or layout container
  - `col-sm-4` -> `sidebarPanel()` or `column(4, ...)`
  - `tabbable` -> `tabsetPanel()`
  - `tab-pane` -> `tabPanel()`

## R Shiny Guidelines

- **Separate UI and Server**: Keep layout and styling declarations in the UI portion/file, and reactive computations, data processing, and rendering in the Server portion/file.
- **Reactivity Best Practices**: Avoid placing heavy computations directly inside render functions without `reactive()` or `eventReactive()`.
- **CSS and styling**: Place custom CSS under `www/` folder (e.g. `www/custom.css`) and reference it using `tags$head(tags$link(rel = "stylesheet", type = "text/css", href = "custom.css"))`.
