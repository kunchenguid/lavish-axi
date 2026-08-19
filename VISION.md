# Vision

`lavish-axi` exists so that a person reviewing what an agent rendered can point at it and be understood exactly.
It is operated by the agent and serves the collaboration between that agent and its human user, turning the person's pointing, selecting, drawing, and typing into instructions the agent receives as their own words.
It owns exactly one thing: the review loop between one person and one agent over one local HTML file.

## The artifact stays the author's

The saved HTML file is the source of truth, and serving it adds exactly one script tag and nothing else.
Nothing else is injected, because an artifact must render identically when it is opened directly with Lavish absent.
A rendered Mermaid diagram can be edited as a whiteboard, but the Mermaid source stays authoritative and the edits return as a summary the agent applies to that source.
Export inlines local assets only and makes no outbound request, so exporting can never become fetching.
A change that makes the served artifact differ from the file on disk is refused.

## Interaction beats prose

An artifact earns its format by letting the reader understand and answer through the page itself instead of through a wall of text.
Elements that can be pointed at, diagrams that can be drawn on, and controls that collect an answer are the substance; any one of them, the whiteboard included, is an instance of that and not a feature in its own right.
A page that could have been a paragraph should have been a paragraph.

## An artifact's design is chosen, never defaulted into

An agent picks a design direction deliberately, in a stated priority order, and says which source it used.
The artifact matches the project it is about before it matches anything Lavish would prefer.
Lavish may offer building blocks that are correct by construction, and they stay opt-in, written in by the artifact's author, and reachable when Lavish is not running.
An artifact that arrives styled at random is a defect in Lavish's guidance before it is a defect in the agent.

## Nothing interrupts the human

Time to first interaction is the number that matters, and every check is weighed against the friction it adds for the person waiting.
Detection is passive: Lavish files what it finds where the user can see it, and only the user selecting an issue turns it into work.
No detection wakes the agent, returns a poll, or repairs anything; the single exception is a failure that leaves the human nothing to review, where waiting on them to act is pointless.
Every check fails open, because a false warning on every open costs more than a miss, and a cosmetic finding is never worth a blocked page.
Only a deliberate human action in the browser becomes feedback the agent receives.
A warning is cleared by a fresh artifact load and a check that no longer finds it, never by the user being asked to declare it settled.
A check that blocks the review, edits the artifact, or nags persistently is removed, and machinery that no longer does the job it was built for is deleted rather than kept.

## Every token is spent on purpose

Token efficiency is a first-class concern rather than a later optimization pass.
Output is compact, waiting is a long poll instead of repeated checks, and guidance is disclosed when it is needed rather than all at once.
A surface that costs the agent tokens on every run has to earn them on every run.
Efficiency is never bought with capability: a rule moves behind a command only once agents are shown to follow the pointer, never on the assumption that they will.
Work a capable agent already does is not rebuilt inside Lavish and then explained back to it.

## The instructions are the product

Lavish is a CLI an agent discovers by running it, so its output is an interface and not documentation.
Every behavior contract has exactly one owner surface, and every other surface points at it instead of restating it.
The installable skill is generated from the same runtime guidance, and the build fails when the two drift apart.
When agents behave badly, changing what Lavish tells them is a real fix and is preferred over new machinery.
Guidance steers the agent's judgment and stops short of rigid rules it can satisfy without thinking.
Lavish keeps its own files in its own places and never modifies a file the user or another tool owns without being asked, because that trust is spent once.

## Scope

The review loop runs on the user's machine, and anything that leaves it is opt-in, named, and disclosed at the moment it happens.
Lavish reviews HTML, and it does not adopt Markdown, PDFs, or images by wrapping them in a page that has no saved file behind it.
It is one person and one agent, however many windows or screens that person uses; it is not a place for two people to collaborate with each other.
It is not a hosting service, and publishing goes to a named third party that is never on by default.
It expects to run inside an agent harness, and the long poll is how that harness holds a continuous session; Lavish does not launch, drive, or supervise the agent itself.
It is not an MCP server and it has no marketplace, because the CLI is already the agent interface and an installed copy is already complete.
It does not translate a whiteboard back into Mermaid, and it does not repair artifacts on the user's behalf.

A change aligns when it carries a human's intent to the agent more precisely, when it keeps the artifact portable and the review uninterrupted, and when it lands in the one surface that already owns the contract it touches.
A change should be resisted when it acts on the artifact without the reviewer asking, when it makes the served artifact diverge from the saved file, when it spends the agent's tokens or the human's waiting time without earning them, or when it quietly widens Lavish past one person, one agent, and one local HTML file.
