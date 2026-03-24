<p align="center">
  <a href="https://feynman.is">
    <img src="assets/hero.png" alt="Feynman CLI" width="800" />
  </a>
</p>
<p align="center">The open source AI research agent.</p>
<p align="center">
  <a href="https://feynman.is/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-feynman.is-0d9668?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@companion-ai/feynman"><img alt="npm" src="https://img.shields.io/npm/v/@companion-ai/feynman?style=flat-square" /></a>
  <a href="https://github.com/getcompanion-ai/feynman/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/getcompanion-ai/feynman?style=flat-square" /></a>
</p>

---

### Installation

```bash
curl -fsSL https://feynman.is/install | bash
```

```powershell
# Windows
irm https://feynman.is/install.ps1 | iex
```

```bash
# npm fallback
npm install -g @companion-ai/feynman
```

Then run `feynman setup` to configure your model and get started.

---

### What you type → what happens

```
$ feynman "what do we know about scaling laws"
→ Searches papers and web, produces a cited research brief

$ feynman deepresearch "mechanistic interpretability"
→ Multi-agent investigation with parallel researchers, synthesis, verification

$ feynman lit "RLHF alternatives"
→ Literature review with consensus, disagreements, open questions

$ feynman audit 2401.12345
→ Compares paper claims against the public codebase

$ feynman replicate "chain-of-thought improves math"
→ Asks where to run, then builds a replication plan
```

---

### Workflows

Ask naturally or use slash commands as shortcuts.

| Command | What it does |
| --- | --- |
| `/deepresearch <topic>` | Source-heavy multi-agent investigation |
| `/lit <topic>` | Literature review from paper search and primary sources |
| `/review <artifact>` | Simulated peer review with severity and revision plan |
| `/audit <item>` | Paper vs. codebase mismatch audit |
| `/replicate <paper>` | Replication plan with environment selection |
| `/compare <topic>` | Source comparison matrix |
| `/draft <topic>` | Paper-style draft from research findings |
| `/autoresearch <idea>` | Autonomous experiment loop |
| `/watch <topic>` | Recurring research watch |

---

### Agents

Four bundled research agents, dispatched automatically.

- **Researcher** — gather evidence across papers, web, repos, docs
- **Reviewer** — simulated peer review with severity-graded feedback
- **Writer** — structured drafts from research notes
- **Verifier** — inline citations, source URL verification, dead link cleanup

---

### Tools

- **[AlphaXiv](https://www.alphaxiv.org/)** — paper search, Q&A, code reading, persistent annotations
- **Docker** — isolated container execution for safe experiments on your machine
- **Web search** — Gemini or Perplexity, zero-config default
- **Session search** — indexed recall across prior research sessions
- **Preview** — browser and PDF export of generated artifacts

---

### How it works

Built on [Pi](https://github.com/badlogic/pi-mono) for the agent runtime, [alphaXiv](https://www.alphaxiv.org/) for paper search and analysis, and [Docker](https://www.docker.com/) for isolated local execution. Every output is source-grounded — claims link to papers, docs, or repos with direct URLs.

---

### Contributing

```bash
git clone https://github.com/getcompanion-ai/feynman.git
cd feynman && npm install && npm run start
```

[Docs](https://feynman.is/docs) · [MIT License](LICENSE)
