---
name: context-recall
description: Use this when the user asks what was done before, refers to earlier sessions, wants prior artifacts, or expects Feynman to remember past work.
---

# Context Recall

## When To Use

Use this skill when the user:
- asks what was done previously
- refers to an earlier paper, memo, or artifact
- expects cross-session continuity
- asks what has already been tried or written

## Procedure

1. Read durable memory first with `memory_search` or `memory_lessons`.
2. Search prior sessions with `session_search`.
3. If needed, inspect the current workspace for artifacts in `outputs/`, `notes/`, `experiments/`, and `papers/`.
4. Distinguish clearly between:
   - durable remembered facts
   - session transcript recall
   - currently present files on disk
5. If you find a stable correction or preference that should persist, save it with `memory_remember`.

## Pitfalls

- Do not claim to remember something without checking memory or session history.
- Do not confuse durable memory with transient task progress.
- Do not summarize prior work from vague impressions; recover evidence first.

## Deliverable

Include:
- what was previously done
- where the evidence came from
- which artifacts or files exist now
- any gaps or uncertainty
