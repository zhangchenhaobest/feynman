---
name: reading-list
description: Use this when the user wants a curated reading sequence, paper shortlist, or tiered set of papers for learning or project onboarding.
---

# Reading List

## When To Use

Use this skill for:
- getting up to speed on a topic
- onboarding into a research area
- choosing which papers to read first
- constructing a project-specific reading order

## Procedure

1. Start with source discovery that matches the topic.
2. For academic topics, use `alpha_search` in `all` mode.
3. For current, product-oriented, or market-facing topics, use `web_search` and `fetch_content` first, then use `alpha_search` for background literature if needed.
4. Inspect the strongest candidates directly before recommending them.
5. Use `alpha_ask_paper` for fit questions like:
   - what problem does this really solve
   - what assumptions does it rely on
   - what prior work does it build on
6. Classify papers or sources into roles:
   - foundational
   - key recent advances
   - evaluation or benchmark references
   - critiques or limitations
   - likely replication targets
7. Order the list intentionally:
   - start with orientation
   - move to strongest methods
   - finish with edges, critiques, or adjacent work
8. Write the final list as a durable markdown artifact in `outputs/`.
9. For every source, include a direct URL.

## Pitfalls

- Do not sort purely by citations.
- Do not over-index on recency when fundamentals matter.
- Do not include papers you have not inspected at all.
- Do not force everything into papers when the user actually needs current docs, products, or market sources.

## Deliverable

For each paper include:
- title
- year
- why it matters
- when to read it in the sequence
- one caveat or limitation
