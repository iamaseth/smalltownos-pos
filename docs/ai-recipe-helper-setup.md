# AI recipe helper: server setup

The menu item editor (Products page) has an optional **AI help** button. It suggests a
single-serving recipe for a dish and offers photos to choose from. It uses two Google services and
stays unavailable until the server has the matching environment variables.

| Variable | Used for |
| --- | --- |
| `GOOGLE_AI_API_KEY` | Recipe suggestions (Gemini API). |
| `GOOGLE_AI_MODEL` | Optional model name. Defaults to `gemini-2.5-flash`. |
| `GOOGLE_SEARCH_API_KEY` | Photo search (Programmable Search JSON API). |
| `GOOGLE_SEARCH_CX` | The Programmable Search engine ID, with image search turned on. |

Recipe suggestions and photo search are independent: either works without the other. If a variable is
missing, the endpoint answers `503` and the editor shows that message. If Google cannot be reached,
the endpoint answers `502` and nothing else in the POS is affected.

## Behavior

- The server sends Google the dish name, its category, and the names of active ingredients and
  ingredient groups. It sends no customer, order, or price data.
- Suggested lines are matched to existing ingredients and groups by name. Amounts in a unit that
  cannot convert to the ingredient's unit are not added. Unmatched ingredients are listed in the
  editor and are never created automatically.
- Suggestions only fill the editor form. Nothing is saved until the manager saves the dish, and
  recipes are drafts until confirmed.
- Photo candidates are fetched through the existing image proxy (`POST /products/fetch-url`) and
  cropped like any uploaded photo. Photos come from web search results, so the store is responsible
  for having the right to use them.

Endpoints are in `main/routes/recipes.ts` under `/recipes/ai` and require `supplies.manage`; picking a
photo also needs `catalog.manage` because it uses the image proxy. The logic is in
`main/services/ai-recipe-helper.ts`.
