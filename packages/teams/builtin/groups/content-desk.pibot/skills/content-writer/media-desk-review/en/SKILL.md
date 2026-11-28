---
name: media-desk-review
description: "Review user-supplied publishing metrics (pasted tables or CSV) and AI-vs-edited draft diffs to propose evidence-backed writing rules."
metadata:
  pibot-name: "Content Review & Rule Learning"
  pibot-version: "1"
---

# Content Review & Rule Learning (Media Desk)

Analyze **user-supplied** publishing data (pasted tables, CSV, or local files) and differences between AI first drafts and the creator's final edited versions to propose durable, evidence-backed writing rules.

## Data Boundaries
- Analyze only data and drafts supplied by the user. **Never use Monid or any third-party account scraping/import tool.**
- Keep metric definitions clean: when a platform lacks view counts, evaluate it by engagement (`likes + comments + shares + saves`) only — **never compute engagement rate or cross-platform view comparisons across incompatible rows**. Deduplicate cumulative snapshots for the same piece before summing, and state any skipped rows.
- Never manufacture advice when sample sizes are too small; say plainly what data is missing.

## Review Dimensions
1. **Overview**: total views, total engagement, comparable engagement rate, published count, platform breakdown, and top-performing pieces.
2. **Primary-platform rule**: propose prioritizing one lead platform only when at least 2 platforms have valid view counts and the top platform's average exceeds the second by more than 30%; cite sample sizes and averages.
3. **Publish-window rule**: propose a default local-time publishing window only when at least 2 hours are represented and the leading window has at least 2 posts; state whether it was ranked by views or engagement.
4. **Draft-edit signals**: compare at least 2 pairs of AI first drafts vs. the creator's final versions:
   - Average final/draft length ratio < 0.85: propose tighter first drafts and note what the user routinely cuts.
   - Average final/draft length ratio > 1.15: propose richer first drafts with concrete details/examples and note what the user adds.
   - Summarize recurring edits to headlines, openings, and phrasing.

## Rule Proposal Format (User Confirmation Required)
Present each proposal with: **Rule name**, **Actionable rule**, **Evidence**, and **Confidence (low/medium/high)**.
- Proposed rules never take effect until the user approves them.
- After approval, record them in the workspace style/rules note or use `skill_propose` if the user wants to promote them into a persistent skill (never export sample/placeholder data).
