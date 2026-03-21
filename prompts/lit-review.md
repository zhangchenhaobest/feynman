---
description: Run a literature review on a topic using paper search and primary-source synthesis.
---
Investigate the following topic as a literature review: $@

Requirements:
- If the topic is academic or paper-centric, use `alpha_search` first.
- If the topic is current, product-oriented, market-facing, or asks about latest developments, use `web_search` and `fetch_content` first, then use `alpha_search` only for academic background.
- Use `alpha_get_paper` on the most relevant papers before making strong claims.
- Use `alpha_ask_paper` for targeted follow-up questions when the report is not enough.
- Prefer primary sources and note when something appears to be a preprint or secondary summary.
- Separate consensus, disagreements, and open questions.
- When useful, propose concrete next experiments or follow-up reading.
- End with a `Sources` section containing direct URLs for every paper or source used.
- If the user wants an artifact, write the review to disk as markdown.
