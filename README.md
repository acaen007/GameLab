# Game Lab

A browser app for studying two-player zero-sum games. It has two parts, chosen with the **Normal-form / Kuhn / Leduc** switch in the top bar:

- **Normal-form:** learning dynamics (bandit and full-information learners) in matrix games.
- **Kuhn** and **Leduc** poker: build strategy portfolios for both players and compare them exactly.

It is plain HTML/CSS/JavaScript with no build step and no runtime dependencies.

## Quick start

The app runs entirely in the browser. There is no Python launcher or virtual environment (`run.py` and `.venv` belonged to the earlier Python version and were removed).

```sh
open index.html        # macOS: opens the app in your default browser
```

If your browser blocks local files, serve the folder and open http://localhost:8000:

```sh
npm run serve          # local server without caching (Ctrl+C to stop)
```

Command-line tools need Node ≥ 18 and nothing to install:

```sh
npm test               # run all tests (npm run tests also works)
npm run example        # four-deployment comparison, writes example-results.csv
node example.js exp3 --binarize   # same, with another learner: ucb1 | ucbv | exp3 | thompson
npm run presets        # regenerate presets/*.json from src/presets.js
```

## Using the app

The normal-form part has three views, switched in the top bar.

1. **Set up.** Edit the matrix and the two player panels, or load a preset or JSON file from the toolbar above the matrix.
   - **p** (right of the matrix) and **q** (below it) are the players' actual strategies. Typing in them makes that player a fixed mixed strategy, which is the strategy the simulation uses. They are disabled while the player is a learner.
   - **E[P1]** and **E[P2]** give each action's expected payoff against the other player's strategy.
   - For the preset game, Player 2's strategy menu also lists the four **Preset deployments**. **Preset: deterministic vs mixed rewards** (under the matrix) sets ε and can reset the matrix.
2. **Run & results.** A summary line shows what will be simulated, with an **Edit setup** link. If the setup changed after the last run, a banner says so and the next run uses the new setup.
3. **Single run** mode has **Play / Pause / Step / Run to end**. **Live round** highlights the cell being played and shows each player's action, payoff and feedback.
4. **Monte Carlo** mode has **Run Monte Carlo**, which repeats the match R times and shows means with 95% confidence intervals. **Cancel** keeps the completed repetitions.
5. **Compare 4 deployments** runs the four preset Player 2 deployments with common random numbers, then opens the **Deployment differences** tab. **Switch N** is in the run bar.
6. Export with **Save JSON** (Set up toolbar), and **PNG** / **CSV** (plots toolbar).
7. **Saved runs.** Every finished run is saved automatically: a single run, a Monte Carlo run, or each deployment of a Compare. Re-running an identical setup reuses the existing entry. Ticked runs are overlaid on the Run & results charts, each in its own colour as "#n name", and appear as extra columns in the summary. Deployment-difference charts use only the current comparison, because the pairing holds only within one run. Runs can be renamed, deleted, shown or hidden in bulk, or used to **Load setup**. They are stored in the browser (IndexedDB), so they survive reloads, but each address (`file://`, `localhost:8000`, …) has its own store.

## Kuhn and Leduc poker

Select **Kuhn** or **Leduc** in the top bar (or open `index.html#kuhn` / `#leduc`). Switching back to **Normal-form** returns to the exact setup and results you left.

- **Rules.**
  - *Kuhn:* cards J < Q < K, ante 1, one betting round with bet size 1 and at most one bet.
  - *Leduc:* deck J J Q Q K K, ante 1. Round 1 has bet size 2; then a public board card is dealt and round 2 has bet size 4. Each round allows a bet and one raise. A pair with the board wins, otherwise the higher card; equal cards split the pot.
  - In both games Player 1 acts first in every round.
- **Strategies.** Each strategy gives, for every hand class, the probability to **Bet** (when no bet is pending), **Raise** (Leduc only, when facing a bet and a raise is allowed) and **Call** (when facing a bet and not raising; otherwise fold).
  - Hand classes are the private card in Kuhn and in Leduc round 1. In Leduc round 2 they are Pair / K high / Q high / J high.
  - This is a compact, card-based parameterization: it does not depend on the betting history.
  - For Kuhn it still covers every behavioural strategy, because each player has one decision of each type per card.
- **Portfolios.** **+ Add strategy** starts from a template and opens its editor. Templates:
  - Nash equilibrium (Kuhn only; Player 1's value is −1/18). Player 1's equilibria form a family indexed by the bluff frequency α ∈ [0, 1/3]: bet J with α, bet K with 3α, call with Q with α + 1/3. The editor has an α slider that updates the table, the matrix and the distribution live. Player 2's equilibrium is unique;
  - Uniform random;
  - Tight (bets and calls only with the best hand);
  - Calling station;
  - Maniac.
  
  Edit probabilities with the sliders or type them (fractions such as `1/3` work). Strategies can be renamed, duplicated and removed. Portfolios are saved in the browser (localStorage).
- **Payoff matrix.** Entry (i, j) is Player 1's exact expected payoff per hand when P1 strategy i meets P2 strategy j. It is computed by enumerating all deals (6 in Kuhn, 120 in Leduc) and the full betting tree, with no sampling. Player 2 receives the negative.
- **Reward distribution.** Click a cell to see the exact distribution of Player 1's payoff for one hand. It also shows the mean, the standard deviation, the win, split and loss probabilities, and how hands end (showdown or either player folding).
- **Game tree.** The selected pair in extensive form: chance deals, each player's decisions (labelled with the card held) and every terminal with Player 1's payoff and how often the hand ends there. Edge labels give action and chance probabilities, and edge width shows the probability of reaching a node. Click nodes to expand or collapse them (Leduc starts collapsed; the board card is a second chance node). Hovering a node traces its path from the root and outlines the other nodes in its information set.

## Layout

| Path | Contents |
| --- | --- |
| `index.html`, `styles.css` | Page and styles |
| `src/engine.js` | Seeded streams, LP solver, normalization, learners, simultaneous match loop, evaluator metrics, validation, JSON schema (no DOM) |
| `src/analysis.js` | Metric series, Welford statistics, Student-t CIs, paired differences, time-sliced Monte Carlo, CSV |
| `src/charts.js`, `src/app.js` | Canvas charts and the normal-form user interface |
| `src/poker.js` | Kuhn and Leduc rules, strategy templates, exact evaluation (no DOM) |
| `src/poker-app.js` | Game switch and the Kuhn / Leduc user interface |
| `src/presets.js`, `presets/` | Built-in experiments (JS for the app, JSON for loading/sharing) |
| `src/fatal.js` | Shows unexpected errors on the page |
| `tests/` | Engine, analysis and poker tests |
| `example.js` | Headless runnable example |
| `scripts/write-presets.js` | Writes `presets/*.json` |

## Model

- **Game.** P1 chooses rows and receives `A[i][j]`. P2 chooses columns and receives `−A[i][j]`. Play is simultaneous: both players choose before either is updated.
- **Fixed strategies.** Pure, mixed (resampled independently every round), uniform, minimax (from the LP), and a *secret pool*. The pool draws one strategy once per match and keeps it, which differs from a mixture that is resampled every round.
- **Learners.**
  - UCB1 (`mean + sqrt(c ln t / n)`, c = 2, each action once in random order, random tie-breaking).
  - UCB-V (Audibert, Munos & Szepesvári, 2009): `mean + sqrt(2 V E / n) + 3 c E / n` with `E = ζ ln t` and `V` the empirical variance of the normalized feedback. Defaults are ζ = 1.2 and c = 1. Initialization and tie-breaking are the same as UCB1.
  - EXP3 (explicit exploration γ; default `min(1, sqrt(K ln K / ((e−1)T)))`).
  - Hedge (default `η = sqrt(8 ln K / T)`; requires full information).
  - Beta-Bernoulli Thompson sampling.
- **Feedback.** *Reward-only* learners receive `{action, reward}`. *Full-information* learners also receive the opponent's action and the counterfactual reward vector. Incompatible configurations, such as Hedge with reward-only feedback, are rejected.
- **Normalization.** Each player's normalization is fixed once from that player's whole payoff table. It is the identity if every payoff lies in [0, 1]. Otherwise it is `r~ = (r − min) / (max − min)`, and a constant table maps to 0.5. Learners see `r~`; plots and regret use actual payoffs.
- **Binarization (optional).** Each round draws one uniform `u_a` per action, and the feedback is `1[u_a < r~_a]`.
- **Randomness.** Each player has separate streams (choice, binarization, pool) keyed by `(seed, repetition, player)`. Deployments use a separate opponent stream keyed by `(master seed, repetition)`. Repetitions are independent. Comparison arms share all streams (common random numbers), so their differences are paired.

## Metrics

- **External regret.** Computed only by the evaluator: the best fixed action in hindsight against the realized opponent actions, minus the actual cumulative payoff.
- **Pseudo-regret.** Shown only when the opponent is oblivious and its induced expected-payoff vector is constant over time. In the preset this equals exactly `2ε × #B`.
- **Exploitability.** For each stationary candidate strategy: `v − min_j (pA)_j` for P1, and `max_i (Aq)_i − v` for P2. It is reported separately from regret and payoff.
- **Monte Carlo.** Shows pointwise means with 95% Student-t confidence intervals. Deployment differences use paired 95% confidence intervals.
- **Horizon-tuned parameters.** Every curve comes from a single run with horizon T, and parameters tuned to the horizon use that full T. Separate runs with different T are never joined into one curve.

## Preset: deterministic vs mixed rewards

`A: [0.5+ε, 1, 0]`, `B: [0.5−ε, 0, 1]`, with columns S1/S2/S3. The default is ε = 0.05, and 0 < ε < 0.5 is required. **Compare 4 deployments** runs these four P2 deployments:

- always S1;
- S2/S3 resampled each round with probabilities (0.5+ε, 0.5−ε);
- the mix for rounds 1…N, then S1;
- S1, then the mix.

All four deployments give A an expected payoff of 0.5+ε and B 0.5−ε, and every deployment has exploitability ε. P1 can be UCB1, UCB-V, EXP3 or Thompson, each optionally binarized, with identical parameters across arms and no reset at the switch.

**Regression test.** UCB1 with ε = 0.05 over T = 4 rounds has expected P1 pseudo-regret 0.2 against S1 and 0.1887625 against the mixture. The test computes both by exact enumeration and cross-checks them against an independent implementation.

## File formats

- **Config JSON** (*Save/Load*) has the shape `{version, name, game: {rows, cols, payoff}, players: [p1, p2], sim: {horizon, repetitions, seed, switchRound, epsilon, rollingWindow, deployment}}`. Blank learner parameters (`null`) mean horizon-based defaults.
- **Results CSV:**
  - Single runs: one row per round, with actions, payoffs, feedback and all metrics.
  - Monte Carlo: long format `series, metric, t, n, mean, ci95_low, ci95_high`, including paired differences.
- **Plot PNG:** the plots in the current tab.
