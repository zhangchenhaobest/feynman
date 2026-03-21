---
description: Build a prioritized reading list on a research topic with rationale for each paper.
---
Create a research reading list for: $@

Requirements:
- If the topic is academic, use `alpha_search` with `all` mode.
- If the topic is current, product-oriented, or asks for the latest landscape, use `web_search` and `fetch_content` first, then add `alpha_search` for academic background when relevant.
- Inspect the strongest papers or primary sources directly before recommending them.
- Use `alpha_ask_paper` when a paper's fit is unclear.
- Group papers by role when useful: foundational, strongest recent work, methods, benchmarks, critiques, replication targets.
- For each paper, explain why it is on the list.
- Include direct URLs for each recommended source.
- Save the final reading list to `outputs/` as markdown.
