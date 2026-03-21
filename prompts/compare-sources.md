---
description: Compare multiple sources on a topic and produce a source-grounded matrix of agreements, disagreements, and confidence.
---
Compare sources for: $@

Requirements:
- Identify the strongest relevant primary sources first.
- For current or market-facing topics, use `web_search` and `fetch_content` to gather up-to-date primary sources before comparing them.
- For academic claims, use `alpha_search` and inspect the strongest papers directly.
- Inspect the top sources directly before comparing them.
- Build a comparison matrix covering:
  - source
  - key claim
  - evidence type
  - caveats
  - confidence
- Distinguish agreement, disagreement, and uncertainty clearly.
- End with a `Sources` section containing direct URLs for every source used.
- Save the comparison to `outputs/` as markdown if the user wants a durable artifact.
