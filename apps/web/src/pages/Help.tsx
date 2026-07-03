// Yardım sayfası: özelliklerin nasıl çalıştığı + sayıların nasıl üretildiği.
// Statik içerik; site dili İngilizce.
export default function Help() {
  return (
    <div className="help">
      <h1>How TacticalMind works</h1>

      <h2>Getting demos in</h2>
      <p>
        Use <b>⬆ Upload demo</b> to add a <code>.dem</code> file. It is parsed once
        into a queryable archive (positions at 16 Hz, kills, grenades, economy,
        rounds) — every page below reads from that archive, so nothing is
        recomputed per view. The same demo uploaded twice is detected by its
        hash and you are redirected to the existing match. Statistics that need
        model refreshes (strategies, roles, win probability) update the next
        time the stats jobs run after new demos arrive.
      </p>

      <h2>Search</h2>
      <p>
        The top bar searches teams, players and maps at once, and every word
        must match: <code>spirit g2</code> lists head-to-head matches of the two
        teams, <code>donk mirage</code> lists donk's Mirage matches. Player hits
        appear as chips linking to player pages; a single team hit shows that
        team's prediction and tendency panels under the results.
      </p>

      <h2>Match view</h2>
      <p>
        One map, three independent layers — each has its own checkbox, controls
        and (where relevant) its own clock:
      </p>
      <ul>
        <li>
          <b>Replay</b> — players (click a dot or a HUD name to focus the
          timeline on that player's kills, deaths and grenade throws; click a
          mark to jump), grenades with type labels and throw arcs, bullet
          tracers, killfeed, corner HUDs (hover to expand armor/money/inventory).
        </li>
        <li>
          <b>Heatmap</b> — positioning density for a side/player over any set of
          rounds, football-style palette. Fully independent of the replay.
        </li>
        <li>
          <b>Ghost rounds</b> — up to 10 rounds' player trails replayed on their
          own clock (own play/speed/slider). Filter to one player to study a
          route habit across rounds.
        </li>
      </ul>
      <p>
        <b>Win probability</b>: the sparkline above the timeline shows the
        historical T win rate for the current game state (alive counts, bomb,
        time) at every second — see "How the numbers are made" below.
      </p>
      <p>
        <b>Map controls</b>: scroll to zoom (pinch works on trackpads), drag to
        pan, double-click to reset, or use the +/−/⟲ buttons. The ✏/→ buttons
        below them start drawing (freehand or arrows, four colors); sketches
        stick to map locations through zoom, are saved per round in your
        browser, and Esc exits the tool. On two-level maps (Nuke) the lower
        level renders as the inset in the corner, everywhere.
      </p>

      <h2>Keyboard shortcuts</h2>
      <table style={{ maxWidth: 460 }}>
        <tbody>
          <tr><td><code>Space</code></td><td>play / pause the replay</td></tr>
          <tr><td><code>←</code> / <code>→</code></td><td>seek −5 s / +5 s</td></tr>
          <tr><td><code>↑</code> / <code>↓</code></td><td>previous / next round</td></tr>
          <tr><td><code>1</code>–<code>6</code></td><td>speed 0.25× · 0.5× · 1× · 2× · 4× · 8×</td></tr>
          <tr><td><code>Esc</code></td><td>exit drawing mode</td></tr>
        </tbody>
      </table>

      <h2>Moments (🔎)</h2>
      <p>
        Query the entire archive for specific situations — opening picks, eco
        AWP kills, early flashes into an area, 3+ player stacks, bomb plants —
        via presets or the form (area fields autocomplete with the selected
        map's callouts). Every result deep-links into the replay at that exact
        moment. Searches can be saved by name (stored in your browser for now).
      </p>

      <h2>Teams, reports, comparison</h2>
      <ul>
        <li>
          <b>Team page</b> — overall record, per-map records, match history.
        </li>
        <li>
          <b>Opponent report</b> — the pre-match page per team+map: side round
          win rates, pistols and conversions, economy behaviour (including the
          reaction after losing a pistol), strategy tendencies (plus the most
          likely approach per buy type), default setups at the 15-second mark
          with representative rounds, recurring utility spots with throw
          timings, positioning heatmaps, thrown rounds, player roles. The 🖨
          button produces a print-friendly version.
        </li>
        <li>
          <b>⚔ Compare</b> — two reports side by side with mirrored
          head-to-head bars; shared selectors for utility and positioning.
        </li>
        <li>
          <b>Player pages</b> — role labels with their evidence, per-map
          performance, opening duels, clutch record with watchable moments,
          archive positioning heatmaps, anomaly flags.
        </li>
      </ul>

      <h2>How the numbers are made</h2>
      <p>
        Everything is deterministic statistics computed from the demo archive —
        there is no AI service and no per-use cost. The guiding rule: every
        claim carries its sample size, and anything below a reliability
        threshold is hidden rather than shown shakily.
      </p>
      <ul>
        <li>
          <b>Strategies</b> — each round's first 30 seconds become an "approach
          signature" (zone occupancy in 5-second windows + utility counts);
          rounds are clustered per map/side (k chosen by silhouette score).
          Team tendencies are cluster frequencies pulled toward the league
          average with Bayesian shrinkage, so 5 rounds of data can't scream.
        </li>
        <li>
          <b>Next-round prediction</b> — league / team / team+buy models race
          on a temporal test split (log-loss); only the winner is served. If
          the team data doesn't beat the league baseline, you see the league
          distribution and the note says so.
        </li>
        <li>
          <b>Setups</b> — the five players' callouts at 15 s form a pattern;
          patterns need ≥8 rounds per side to be reported at all.
        </li>
        <li>
          <b>Utility spots</b> — greedy radius clustering of landing points
          (deterministic, no random seeds); a spot needs ≥3 throws.
        </li>
        <li>
          <b>Roles</b> — explicit thresholds on measured behaviour (entry share
          of first duels, distance from team centroid for lurkers, single-place
          occupancy after 15 s for anchors, AWP-in-inventory share). Labels
          require ≥30 rounds per side; below that only raw numbers show.
        </li>
        <li>
          <b>Win probability</b> — for every second of every archived round the
          state (alive T, alive CT, bomb planted, time bucket) is recorded with
          the round's winner; probability is the historical win rate of that
          state, smoothed hierarchically toward coarser states. "Thrown rounds"
          are losses where the team's own probability peaked at ≥75%.
        </li>
        <li>
          <b>Clutches</b> — a 1vX starts when a side is down to exactly one
          player; the first such situation per round is recorded with its
          outcome.
        </li>
        <li>
          <b>Anomaly flags</b> — a player-match metric is flagged when it sits
          more than 1.5 standard deviations from that player's own baseline
          (leave-one-out); the flag always shows value, baseline and z.
        </li>
      </ul>

    </div>
  );
}
