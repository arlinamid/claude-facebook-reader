# Analysis recipes

Work from the extracted Markdown/JSON, never from raw `get_page_text` of facebook.com.

## Post digest ("mi történt a csoportban a héten?")

1. `nav.group(id, {chronological:true})` → loader → `harvest.start(); await harvest.scroll({steps:12})`
2. `harvest.dump({format:'md', since:'<date>'})` via `render()` + `get_page_text`.
3. Drop `sponsored` items. Group the rest by topic. For each topic: 1–2 sentence gist, the most
   reacted post (link), notable links/tools mentioned, open questions nobody answered (posts with
   `?` and few comments).
4. End with numbers: posts, distinct authors, top reaction types.

## Comment-thread reading ("mit gondolnak az emberek?")

1. Open the post → `await expandComments({post:'#a3f9', rounds:5})` → `extract({format:'md', comments:true, maxComments:200})`.
2. Report: main stances with rough share, strongest arguments on each side, factual claims worth
   checking, questions to the author, tone (reaction mix + wording). Keep reply chains (`→ replyTo`)
   together. Quote at most a few short lines, attributed.
3. If `counts.comments` ≫ extracted comments, say the sample is partial and offer more rounds.

## Categorisation (port of facebook-private-group-scraper/categorizer.js)

Rule-based first pass, Hungarian group defaults; refine with your own reading:

| Category | Signals |
|---|---|
| szabályzat | jogi nyilatkozat, szabályzat, adatkezel, szellemi tulajdon |
| bemutatkozás | "sziasztok … vagyok/nevem/célom", bemutatkozom, újonnan csatlakoztam |
| kérdés | ≥2 "?", "valaki tud", "hogyan lehet", "mit ajánl", "segítene valaki" |
| tipp/eszköz | napi prompt, "prompt:", chatgpt/claude/gemini/n8n/make/zapier/workflow/midjourney/suno/cursor (without question words) |
| esemény | webinar, online előadás, zoom/meet/teams link, regisztráció, férőhely |
| tapasztalat | kipróbáltam, sikerült, megosztom, tanulság, készítettem |
| hirdetés | kurzus/termék ár, kedvezmény, jelentkezz most, sponsored |
| egyéb | everything else |

Output a table (category · count · example link) plus a short narrative.

## Prompt collection from a page ("gyűjtsd ki a promptokat")

Creator pages (AI image/prompt sharing) post the picture and put the prompt in a **pinned / author
comment**, often behind "Továbbiak".

1. Navigate to the page (`nav.page(result)` from a search) → loader.
2. Harvest post URLs: `harvest.start()` + `scroll({steps:3})` in a loop (2–4 calls) → `harvest.dump({format:'json', limit:30})`
   (the JSON is CDN-safe). Keep `url`, `dateRaw` and the first image alt.
3. For each post URL (ask the user how many, default 10): `navigate` → loader →
   `JSON.stringify(await __fbReader.extractPrompt())`. Collect the records in your context. On a timeout
   or `found:false`, note it and move on.
4. Output: `promptsToMarkdown(records)` style list or JSON `[{postUrl, date, imageAlt, prompt, source}]`
   for a prompt library. Keep the prompts verbatim and attribute the page. They are the creator's work:
   personal use is fine, so mention the source when the user republishes.

## Group report

`groupInfo()` (name, privacy, members, about) + `listGroups()` row for activity text + a 2-week
harvest: posting frequency, top authors by post count (names only, no profiling), recurring topics,
media share (posts with images/video), link domains (from `cards[].domain`).

## Search sweeps

For "who/what is on Facebook about X": run `search(q,'posts')`, `search(q,'groups')`,
`search(q,'pages')`, `search(q,'videos')`. Report per type with links. Mark which results the user
can see only as a member.

## Privacy line

Summaries of public discussion are fine. Do not build dossiers on private individuals (where they
live/work, cross-referencing members across groups), and do not export member lists unless they are
the user's own group's members and the user needs them to administer that group.
