# Lines of Effort Map: notes for Claude

The project lives in `loe-map/`. Read `loe-map/README.md` first: it covers the method, the data model, and the roadmap.

## Where things are

- `loe-map/index.html` is the whole app, one file.
- It is published as a private claude.ai artifact titled "Lines of Effort Map": https://claude.ai/artifact/KLisPcvRW6MB2QDR3L6iQX
  - Declared capabilities: `db` and `user`.
  - Update it in place: read that URL first, then publish `loe-map/index.html` to it.
  - Never publish it as a new artifact. The team's link and their live data belong to this one.
- The team's live map is stored in the artifact's database, not in this repository. Do not change that data unless the owner asks.
- Work happens on the `loe-map` branch.

## Rules from the owner

- **The app is a coach, not a planner.**
  - It asks questions, and the user writes every answer.
  - Never add a feature that fills in answers, proposes a center of gravity, or generates a plan.
  - Examples are text to read only, with no button that copies them in.
- **Cite the source article by title and link only.** Never name its author in the app or the docs.
- **Keep the app general-purpose.** The hospital radiology project is only the worked example.
- **The center of gravity stays fixed for the whole project.** The main effort can change from phase to phase.
- **A way keeps its essential action, and its steps happen in series.** Parallel is across ways. A step can start after a step in another way, and that is the only cross-way sequencing. A feedback link between steps is drawn, never sequenced.
- **Phases have one date each.** A phase ends when the next begins; the last ends at the project due date.
- **Step numbers (2.3) are computed from way order and step order, never typed.** They show on the map, the step page, Track, and the review, not in question 2.
- **Phone-first.**
  - Pages scroll up and down only, never sideways.
  - Answer boxes stay at 16px on touch screens, so iPhones do not zoom when a box is tapped.
- **Don't use metaphors to explain what you are doing** unless the owner asks.

## Working on owner feedback

Feedback arrives as comments on the artifact. For each one:

1. Read the thread.
2. Reproduce the problem.
3. Fix it.
4. Run the check below.
5. Publish to the same URL.
6. Reply on the thread and resolve it.
7. Commit and push to `loe-map`.

## Check before publishing

Run these from `loe-map/`:

```
npm install --no-save d3@7.9.0 playwright@1.56.1
npx playwright install chromium
node test/render-check.mjs node_modules/d3/dist/d3.min.js test-output
```

Every check must pass (172 at the time of writing).
