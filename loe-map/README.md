# Lines of Effort Map

A coaching tool that walks a team through the center-of-gravity method from military planning and draws a map of the plan from the team's answers. It works for any project with a goal you can measure. The built-in worked example is a hospital radiology project.

The whole app is one file, `index.html`, published as a claude.ai artifact so the team shares one live map.

## The idea in plain language

The app's start screen explains this at about a 5th-grade reading level.

Every plan depends on someone or something doing the main work. Planners call that the **center of gravity**: the main doer, the person, group, or thing with the built-in ability to reach the goal. Three more terms describe what the doer does and what it needs. Together with the center of gravity, they are the **critical factors**.

| Term | Plain meaning | Pizza-delivery example |
|---|---|---|
| Goal | What you are trying to achieve | Every Friday-night delivery arrives within 30 minutes |
| Critical capability | The main action the doer must be able to do | Get hot pizza to the customer's door |
| Center of gravity | The doer that actually does that action | The delivery drivers |
| Critical requirements | What the doer needs to do the action | Cars that run, gas, phones with maps, pizzas ready on time, enough drivers |
| Critical vulnerabilities | Requirements that are weak, missing, or easy to break | Only two drivers on Friday nights, and one car breaks down often |

To find the doer, ask: does it do the action, or is it used to do the action? A car does not deliver pizza. A driver uses a car to deliver pizza. So the drivers are the center of gravity, and the cars are a requirement.

## The coaching principle

The tool asks questions. The team answers them. It never supplies an answer, proposes a center of gravity, or generates a plan.

- Every item on the map was typed by a person in answer to a question.
- The coach reflects back what the answers imply and asks follow-up questions. It does not draw conclusions for you.
- Examples sit behind a "Show examples" link. They are text to read. There is no button that copies an example onto the map.
- The challenge questions that matter most keep a one-line written answer: why the objective is the right level, why the center of gravity is the real one, and why each vulnerability is vulnerable.
- Each answer opens the next question. Earlier answers stay editable, and editing never locks a step you have already reached.

## The four questions

Source: ["The Center of Gravity: Still Relevant After All These Years?"](https://www.armyupress.army.mil/Journals/Military-Review/Online-Exclusive/2017-Online-Exclusive-Articles/The-Center-of-Gravity/), Military Review, online exclusive, May 2017. The four questions are on page 6.

| Step | The article's question | What your answer becomes on the map |
|---|---|---|
| 1 Goal | What is the system's goal or purpose? | The objective block, with measure, baseline, target, and due date |
| 2 Ways | What probable ways or actions will the system use to achieve the goal? | One lane per way, each with an essential action |
| 3 Doers | What entity, actor, or node has the inherent ability to perform the action? | The doer of each way. The team then picks one doer as the center of gravity, and it stays fixed for the whole project. |
| 4 Needs | What does the doer require, and which of those are vulnerable? | Needs linked to each doer. Vulnerable needs are flagged with your reason. |
| Links | (Relationships, actors, function, tensions) | Depends-on, influences, and in-tension-with links between any items |
| Phases | (Sequence the ways in main and supporting efforts) | Named, dated phases, each with one way as its main effort and a reason |
| Review | | Your answers laid out as the four questions, the phases, a tier list, and open questions |

**Main effort and center of gravity are separate.** The main effort is the way that matters most at a given point in time, so it can change from phase to phase. The center of gravity is tied to the objective, so it stays the same. When a phase's main effort is led by a doer other than the center of gravity, the coach asks what keeps the center of gravity ready while the focus is elsewhere. The map's phase menu highlights the main-effort lane for the phase you pick, and it opens on the phase whose dates include today.

The article's definition, shown in step 3: "The center of gravity is the primary entity that possesses the inherent capability to achieve the objective."

The tier list sorts every item the way the article describes. Critical items serve the center of gravity. Major items serve the other doers. Minor items connect to something. Peripheral items connect to nothing. The Focus button fades the minor and peripheral items so the map shows what the objective hinges on.

## Using it

1. Open the link. The coach starts on a short orientation and the first question.
2. Answer question 1. The map draws the objective. Question 2 opens.
3. Keep going. The map fills in as each answer lands.
4. Use **Worked example** to see a finished map for a hospital project to cut emergency CT report turnaround. It is read-only and never touches your team's map.
5. Switch the map between **Lanes** and **Network**. Lanes shows the structure: needs, then doer, then action, then objective. Network shows the tangle.
6. Tap any item on the map to see its role. Use **Edit answers** to change it.
7. **Copy data** gives you a text backup of everything your team has entered.

### On a phone

The page works in the Claude mobile app and in a phone browser. It shows Coach and Map as two tabs with one question per screen. Every answer box is a standard text field, so the microphone key on the phone keyboard dictates straight into it.

Spoken commands such as "next" or "mark overnight coverage vulnerable" are not built yet. The artifact sandbox does not give pages microphone access, so in-page speech recognition cannot run there. The plan below covers what can be built inside that limit.

## Sharing with your team

Everyone who opens the link sees the same map, live. Who can edit depends on your Claude plan.

- **Team or Enterprise plan.** Members of your organization who open the link at Contributor level or above can answer.
- **Personal plan (Pro or Max).** Only you can edit, plus people you invite by email as **Editor**. They can edit only while the artifact is not also shared by public link. Anyone who arrives through a public link can view but not edit.

For a team on a personal account, invite each teammate by email as Editor and leave the public link off. People without edit access see a banner telling them how to get it.

**Do not enter personal or confidential information.** The map is for project structure only.

## Data

The map lives in the artifact's shared database, in five collections.

```
project/main   title, objective, measure, baseline, target, dueDate,
               objectiveRationale, cogNodeId, cogRationale, relationshipsReviewed
loes/{id}      name, order, color, capability, doerNodeId
nodes/{id}     label, type (actor | system | process | resource), loeId, vulnerable,
               rationale, owner, notes
links/{id}     source, target, type (uses | depends_on | influences | tension), loeId
               id = type__source__target, plus __loeId for a need tied to one way
phases/{id}    name, order, start, end, mainLoeId, rationale
```

A need belongs to a doer within one way, so two ways that share a doer can each have their own needs. A "uses" link saved before needs carried a way counts for the way whose lane the need sits in, or for every way of that doer when the need sits elsewhere.

Roles are computed from these records and never stored. That includes needs, vulnerabilities, tiers, and which steps are open. The center of gravity is the one stored choice, and it only counts while that node is still a doer. The map therefore cannot drift out of step with the answers.

## Local check

`test/render-check.mjs` loads the page in headless Chromium with a stub shared database. It walks the six steps, checks that each one opens only when its question is answered, and checks the worked example, read-only access, and the phone tabs. It also takes screenshots of both map views on desktop and phone, in light and dark themes.

Run it from the `loe-map` folder. It needs Node.js 18 or later.

```
npm install --no-save d3@7.9.0 playwright@1.56.1
npx playwright install chromium
node test/render-check.mjs node_modules/d3/dist/d3.min.js test-output
```

## What comes next

These are listed in priority order. Each item is a choice between building it now and waiting until the team has used the tool.

1. **Ideas on demand.** A "Give me ideas" button appears only after you have typed an attempt. It asks Claude for three example answers in your domain, labeled as ideas, with no button to insert them.
2. **Spoken commands, basic.** A command box at the top of the coach. You dictate into it with the keyboard microphone, and the page matches a fixed list of commands. No AI is involved. Every action in the page already runs through a single command list, so this adds a parser and nothing else.
3. **Decisive points.** For each vulnerability: what you will do, who owns it, by when, and in which phase. These tasks would appear inside their phase on the lanes.
4. **Spoken commands, free-form.** Free speech mapped to one command from the fixed list, shown back for you to confirm before it runs. Build this only if the fixed list feels too rigid.
5. **More challenge questions** in the review, each with a stored answer.
6. **Export** of PNG, SVG, and JSON files, plus importing a backup.
7. **Matrix view** of doers against actions and needs against ways.
8. **Comments** on individual items.
9. **Several projects** in one artifact, with a switcher.
