---
name: literature-review
description: Use this when the task is to survey prior work, compare papers, synthesize a field, or build a reading list grounded in primary sources.
---

# Literature Review

## When To Use

Use this skill when the user wants:
- a research overview
- a paper shortlist
- a comparison of methods
- a synthesis of consensus and disagreement
- a source-backed brief on a topic

## Procedure

1. Search broadly first.
2. If the topic is primarily academic or paper-centric, start with `alpha_search`.
3. If the topic includes current products, companies, markets, software, or "latest/current" framing, start with `web_search` and `fetch_content`, then use `alpha_search` only for academic background.
4. Pick the strongest candidates by direct relevance, recency, citations, venue quality, and source quality.
5. Inspect the top papers with `alpha_get_paper` before making concrete claims.
6. Use `alpha_ask_paper` for missing methodological or experimental details.
7. Build a compact evidence table:
   - title
   - year
   - authors
   - venue
   - claim or contribution
   - important caveats
8. Distinguish:
   - what multiple sources agree on
   - where methods or findings differ
   - what remains unresolved
9. If the user wants a durable artifact, write a markdown brief to disk.
10. If you discover an important gotcha about a paper, save it with `alpha_annotate_paper`.
11. End with a `Sources` section that lists direct URLs, not just titles.

## Pitfalls

- Do not summarize a field from titles alone.
- Do not flatten disagreements into fake consensus.
- Do not treat recent preprints as established facts without saying so.
- Do not cite secondary commentary when a primary source is available.
- Do not treat a current product or market topic as if it were a paper-only topic.

## Output Shape

Prefer this structure:
- question
- strongest papers
- major findings
- disagreements or caveats
- open questions
- recommended next reading or experiments
- sources
