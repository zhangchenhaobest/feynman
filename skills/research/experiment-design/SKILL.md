---
name: experiment-design
description: Use this when the task is to turn a vague research idea into a testable experiment, define metrics, choose baselines, or plan ablations.
---

# Experiment Design

## When To Use

Use this skill when the user has:
- a hypothesis to test
- a method to evaluate
- an unclear benchmark plan
- a need for baselines, ablations, or metrics

## Procedure

1. Restate the research question as a falsifiable claim.
2. Define:
   - independent variables
   - dependent variables
   - success metrics
   - baselines
   - constraints
3. Search for prior work first.
4. If the setup is tied to current products, APIs, model offerings, pricing, or market behavior, use `web_search` and `fetch_content` first.
5. Use `alpha_search`, `alpha_get_paper`, and `alpha_ask_paper` for academic baselines and prior experiments.
6. Prefer the smallest experiment that can meaningfully reduce uncertainty.
7. List confounders and failure modes up front.
8. If implementation is requested, create the scripts, configs, and logging plan.
9. Write the plan to disk before running expensive work.

## Pitfalls

- Avoid experiments with no baseline.
- Avoid metrics that do not connect to the claim.
- Avoid ablations that change multiple variables at once.
- Avoid broad plans that cannot be executed with the current environment.

## Deliverable

Produce:
- hypothesis
- setup
- baselines
- metrics
- ablations
- risks
- next action
