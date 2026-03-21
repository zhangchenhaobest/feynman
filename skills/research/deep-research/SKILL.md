---
name: deep-research
description: Use this when the user wants a broad, thorough investigation with strong sourcing, explicit evidence tables, and a durable research brief.
---

# Deep Research

## When To Use

Use this skill when the user wants:
- a thorough investigation rather than a quick memo
- a broad landscape analysis
- careful source comparison across multiple source types
- a durable research brief with explicit evidence

## Procedure

1. Clarify the exact scope and what decision or question the research should support.
2. Choose the right retrieval mix:
   - use `web_search` and `fetch_content` first for current, product, market, regulatory, or latest topics
   - use `alpha_search`, `alpha_get_paper`, and `alpha_ask_paper` for academic background or paper-centric claims
   - use both when the topic spans current reality and academic literature
3. Gather enough high-quality sources before synthesizing.
4. Build an evidence table covering:
   - source
   - claim
   - evidence type
   - caveats
   - relevance
5. Synthesize:
   - strongest findings
   - disagreements
   - open questions
   - what would change the conclusion
6. Save a durable markdown brief to `outputs/`.
7. End with a `Sources` section containing direct URLs for every source used.

## Pitfalls

- Do not answer a current topic from papers alone.
- Do not answer an academic topic from search snippets alone.
- Do not collapse disagreement into fake consensus.
- Do not omit the evidence table on broad or high-stakes topics.

## Deliverable

Include:
- scope
- evidence table
- key findings
- disagreements or caveats
- open questions
- recommendation or next step
- sources
