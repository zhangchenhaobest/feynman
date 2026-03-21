---
name: autoresearch
description: Use this when the user wants an end-to-end idea-to-paper run, from problem framing through literature, experiments if feasible, and a paper-style draft.
---

# AutoResearch

## When To Use

Use this skill when the user wants:
- an idea turned into a paper-style draft
- a full research workflow, not just a memo or reading list
- autonomous progress from topic framing to deliverable

## Procedure

1. Restate the idea as a concrete research question and identify the likely contribution type:
   - empirical result
   - synthesis or review
   - method proposal
   - benchmark or audit
2. Search for relevant primary sources first.
3. If the topic is current, product-oriented, market-facing, or asks about latest developments, start with `web_search` and `fetch_content`.
4. Use `alpha_search`, `alpha_get_paper`, and `alpha_ask_paper` for academic background or paper-centric parts of the topic.
5. Build a compact evidence table in `notes/` or `outputs/` before deciding on the paper narrative.
6. Decide whether experiments are feasible in the current environment:
   - if yes, design and run the smallest experiment that materially reduces uncertainty
   - if no, continue with a literature-grounded or theory-grounded draft and state the limitation clearly
7. Produce at least two artifacts:
   - an intermediate artifact (research memo, evidence table, or experiment log)
   - a final paper-style draft in `papers/`
8. Structure the final draft with:
   - title
   - abstract
   - introduction
   - related work
   - method or synthesis
   - evidence or experiments
   - limitations
   - conclusion
9. End with a `Sources` section containing direct URLs for every source used.

## Pitfalls

- Do not jump straight to drafting before checking the literature.
- Do not treat a current topic as if papers alone are enough.
- Do not fake experiments when the environment cannot support them.
- Do not present speculative contributions as established results.
- Do not omit limitations or missing validation.

## Deliverable

A complete idea-to-paper run should leave behind:
- one intermediate artifact in `notes/` or `outputs/`
- one final paper-style draft in `papers/`
- a source list with direct URLs
