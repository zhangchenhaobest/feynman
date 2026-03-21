# Feynman

`feynman` is a research-first CLI built on `@mariozechner/pi-coding-agent`.

It keeps the useful parts of a coding agent:
- file access
- shell execution
- persistent sessions
- skills
- custom extensions

But it biases the runtime toward general research work:
- literature review
- source discovery and paper lookup
- source comparison
- research memo writing
- paper and report drafting
- session recall and durable research memory
- recurring and deferred research jobs
- replication planning when relevant

The primary paper backend is `@companion-ai/alpha-hub` and your alphaXiv account.
The rest of the workflow is augmented through a curated `.pi/settings.json` package stack.

## Install

```bash
npm install -g @companion-ai/feynman
```

Then authenticate alphaXiv and start the CLI:

```bash
feynman setup
feynman
```

For local development:

```bash
cd /Users/advaitpaliwal/Companion/Code/feynman
npm install
cp .env.example .env
npm run start
```

Feynman uses Pi under the hood, but the user-facing entrypoint is `feynman`, not `pi`.
When you run `feynman`, it launches the real Pi interactive TUI with Feynman's research extensions, skills, prompts, package stack, memory snapshot, and branded defaults preloaded.

Most users should not need slash commands. The intended default is:
- ask naturally
- let Feynman route into the right workflow
- use slash commands only as explicit shortcuts or overrides

## Commands

Inside the REPL:

- `/help` shows local commands
- `/new` starts a new persisted session
- `/exit` quits
- `/lit-review <topic>` expands the literature-review prompt template
- `/replicate <paper or claim>` expands the replication prompt template
- `/reading-list <topic>` expands the reading-list prompt template
- `/research-memo <topic>` expands the general research memo prompt template
- `/deepresearch <topic>` expands the thorough source-heavy research prompt template
- `/autoresearch <idea>` expands the end-to-end idea-to-paper prompt template
- `/compare-sources <topic>` expands the source comparison prompt template
- `/paper-code-audit <item>` expands the paper/code audit prompt template
- `/paper-draft <topic>` expands the paper-style writing prompt template

Outside the REPL:

- `feynman setup` configures alpha login, web research, and preview deps
- `feynman --alpha-login` signs in to alphaXiv
- `feynman --alpha-status` checks alphaXiv auth
- `feynman --doctor` checks models, auth, preview dependencies, and branded settings
- `feynman --setup-preview` installs `pandoc` automatically on macOS/Homebrew systems when preview support is missing

## Custom Tools

The starter extension adds:

- `alpha_search` for alphaXiv-backed paper discovery
- `alpha_get_paper` for fetching paper reports or raw text
- `alpha_ask_paper` for targeted paper Q&A
- `alpha_annotate_paper` for persistent local notes
- `alpha_list_annotations` for recall across sessions
- `alpha_read_code` for reading a paper repository
- `session_search` for recovering prior Feynman work from stored transcripts
- `preview_file` for browser/PDF review of generated artifacts

Feynman uses `@companion-ai/alpha-hub` directly in-process rather than shelling out to the CLI.

## Curated Pi Stack

Feynman loads a lean research stack from [.pi/settings.json](/Users/advaitpaliwal/Companion/Code/feynman/.pi/settings.json):

- `pi-subagents` for parallel literature gathering and decomposition
- `pi-docparser` for PDFs, Office docs, spreadsheets, and images
- `pi-web-access` for broader web, GitHub, PDF, and media access
- `pi-markdown-preview` for polished Markdown and LaTeX-heavy research writeups
- `@walterra/pi-charts` for charts and quantitative visualizations
- `pi-generative-ui` for interactive HTML-style widgets
- `pi-mermaid` for diagrams in the TUI
- `@aliou/pi-processes` for long-running experiments and log tails
- `pi-zotero` for citation-library workflows
- `@kaiserlich-dev/pi-session-search` for indexed session recall and summarize/resume UI
- `pi-schedule-prompt` for recurring and deferred research jobs
- `@samfp/pi-memory` for automatic preference/correction memory across sessions

The default expectation is source-grounded outputs with explicit `Sources` sections containing direct URLs and durable artifacts written to `outputs/`, `notes/`, `experiments/`, or `papers/`.

## Layout

```text
feynman/
├── extensions/   # Custom research tools
├── papers/       # Polished paper-style drafts and writeups
├── prompts/      # Slash-style prompt templates
├── skills/       # Research workflows
└── src/          # Branded launcher around the embedded Pi TUI
```
