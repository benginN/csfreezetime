// Help: complete end-user guide. No admin/infra detail (backfill, server
// setup, radar paths). Kept in sync with the feature set as it grows.
export default function Help() {
  return (
    <div className="help" style={{ maxWidth: 860, lineHeight: 1.65 }}>
      <h1>Help — everything Freezetime can do</h1>
      <p className="meta">
        Freezetime turns CS2 demos into coach-grade intelligence: a synchronized
        2D replay, archive-wide statistics, and honest numbers — every claim
        carries its sample size, and thin data hides itself rather than mislead.
        Anything marked 🧠 is produced by the local ML pipeline (deterministic,
        no external AI); hover it anywhere for a one-line explanation.
      </p>

      <h2>1. Finding matches — Home &amp; search</h2>
      <ul>
        <li><b>Team strip:</b> the top row lists every team alphabetically; scroll it sideways (mouse wheel works). Click a team for its page.</li>
        <li><b>Tournament strip:</b> right below it, every tournament in the archive, most recent first. Click one and the search locks to that event.</li>
        <li><b>Search box:</b> type anything — team ("spirit"), player ("donk"), map ("mirage"), tournament ("cologne") or combinations ("spirit mirage"). Matching team, player and 🏆 tournament chips appear above the results; the list filters live.</li>
        <li>The default list shows the most recent 100 <b>encounters</b> — a BO3/BO5 counts as one entry with its maps grouped inside, so a series is never cut in half at the bottom. Search reaches the entire database (the total is in the header).</li>
        <li><b>Download a demo:</b> the ⬇ on any match row downloads the raw <code>.dem</code> (watchable in CS2).</li>
        <li><b>Split recordings:</b> when a server restart split a map into two demos, the list shows ONE row with the combined score and an "N parts" badge; inside, round numbers continue across the parts.</li>
      </ul>

      <h2>2. The match page — one map, three independent layers</h2>
      <p>
        Open any match and you get a single map with three layers (Replay,
        Heatmap, Ghost rounds) that never interfere. Each has a checkbox header —
        unchecking greys it out. Only the checkbox and title toggle a section.
      </p>

      <h3>2a. Replay</h3>
      <ul>
        <li>Play/pause, speeds 0.25×–8×, and a timeline (bottom right) marked with kills and events — click any mark to jump.</li>
        <li><b>Players:</b> dots show facing direction and an HP ring, with shield/money/inventory in the corner HUD and a live kill feed. Blinded players whiten and fade back as the flash wears off; muzzle flashes and red tracers show who is shooting whom.</li>
        <li><b>Grenades:</b> smoke bloom, molotov fire and flashes are drawn. <b>Hover an active grenade</b> for its type, throw time and thrower, plus its flight arc. <b>Toggle grenade types</b> on/off (the "nades" row) — hide HE/decoy to read smokes and flashes cleanly.</li>
        <li><b>Bomb &amp; dropped weapons:</b> the C4 carrier wears a red dot (it stays on the ground if dropped); a dead player&apos;s weapon stays as a pale square, named on hover.</li>
        <li><b>Focus or hide a player:</b> click a HUD name to focus the timeline on their kills/deaths/nades; click the 👁 on a HUD row to hide that player from the map (unhide-all is in the nades row). <b>setpos</b> copies their exact position and view angles as a console command for your practice server.</li>
        <li><b>Round chips:</b> colored by winner with a side stripe (amber = T win, blue = CT win) and a divider at side swaps. Hover a chip for its strategy labels, buy types and flags. The <b>highlight</b> picker rings rounds by buy type, by <b>strategy</b>, or by <b>who had an AWP</b> — the ring color says which team (cyan = left, purple = right, double = both).</li>
        <li><b>Flags on chips:</b> ⚠ marks a <b>thrown round</b> (a team peaked ≥75% win probability and still lost); ⚡ marks a <b>surprise</b> (they ran a strategy the model gave under 15%) — the moments an opponent broke their own habits.</li>
        <li><b>Win probability:</b> the sparkline above the timeline shows the live T win chance from archive history (alive counts, bomb state, clock); it updates as you scrub.</li>
        <li><b>Drawing / zoom / keyboard:</b> pen + arrow tools with a color picker (saved per round); mouse-wheel / pinch to zoom, drag to pan, double-click to reset. Space = play/pause · ←/→ = step · ↑/↓ = round · 1–6 = speed · Esc = clear focus.</li>
      </ul>

      <h3>2b. Heatmap</h3>
      <ul>
        <li>Position density for <b>any set of rounds you pick</b> (chips, or all/none), one side or both, one player or everyone.</li>
        <li>The player list is side-aware: pick CT and only players who actually played CT in your selected rounds appear.</li>
        <li>Lower levels (Nuke) render in their own inset.</li>
      </ul>

      <h3>2c. Ghost rounds</h3>
      <ul>
        <li>Overlay many rounds as translucent trails on their <b>own clock</b> — align at round start, bomb plant, or first kill and compare how executions differ.</li>
        <li>Filter to one side or a single player; each round is color-coded and labeled (r7, r19…).</li>
        <li><b>Trail slider:</b> how long the tail behind each ghost is (1–60 s, or the full path). <b>Hover a ghost</b> for its name; <b>click to pin</b> a panel with that player&apos;s live HP/armor/money/inventory at the ghost clock.</li>
      </ul>

      <h3>2d. Notes &amp; playlists</h3>
      <ul>
        <li><b>Notes:</b> pin a text note — or a voice note (mic button) — to the exact second of a round. Amber marks on the timeline jump to them.</li>
        <li><b>Playlists:</b> save the current moment into a named playlist. On the Playlists page, "Play all" walks the collection and <b>auto-advances</b> when each round ends — hands-free VOD review.</li>
      </ul>

      <h2>3. Team page</h2>
      <ul>
        <li>Overall record and per-map cards; each card shows the team&apos;s <b>signature strategy</b> per side with a 🧠 <b>×N vs league</b> note (how much more than an average team they run it). Click a card for the full report.</li>
        <li><b>Player table:</b> matches, rounds, ADR, K/D, flash assists and survival for everyone who played for the team; the <b>current five</b> (from their most recent match) sit on top, former players are dimmed and dated. Click a name for the player page.</li>
        <li><b>Filters</b> at the top narrow everything: a free-form <b>time window</b> (last N weeks/months/years) and <b>lineup ≥ N/5</b> — keep only matches where at least N of the current five played, so the stats describe today&apos;s roster, not a former one.</li>
      </ul>

      <h2>4. Opponent report (per team + map)</h2>
      <p className="meta">The coach&apos;s one-pager. Everything respects the window/lineup filters; <b>Print</b> produces a clean sheet.</p>
      <ul>
        <li><b>Overview:</b> map record, side round-win rates, pistols, conversion after a won pistol, plus <b>rush rate</b> (T rounds with first contact inside 22 s) and <b>set-strat share</b> (rehearsed executes vs default/mid-round).</li>
        <li><b>Recent results:</b> the matches behind the numbers, W/L colored, linked to replays.</li>
        <li><b>Execute templates:</b> 🧠 utility combinations the team repeats to open a site ("window smoke + top-mid flash + top-mid smoke ×8, 88% won → A 3 / B 4").</li>
        <li><b>Strategy tendencies:</b> 🧠 the archive groups each round&apos;s opening into recurring strategies (shown as an <b>area mix</b>, e.g. "TopMid + SideAlley" — players split across these, not a single-file route; hover for exact shares). Bars show what this team favors, with the <b>×N vs league</b> badge. The pencil ✏ names a strategy ("B rush") — the name then appears everywhere. A <b>by-buy</b> table and a <b>by-round-type</b> table (pistol / after pistol / 3rd / mid-game / overtime) sit below.</li>
        <li><b>Next-round prediction:</b> 🧠 the same engine as the ML Lab. Pick side, buy and (optionally) the opponent — you get the likely strategies with probabilities, plus <i>which method produced them and on how much evidence</i>.</li>
        <li><b>Economy behaviour:</b> buy mixes and the reaction after a lost pistol.</li>
        <li><b>Default setups:</b> 🧠 the exact player positions 15 s into the round (from a real example round), a <b>site notation</b> badge on CT (3A-2B), hold times, and how they <b>rotate after first contact</b> (destination mix and delay).</li>
        <li><b>Utility habits:</b> 🧠 recurring smoke/molotov/flash spots with timing, flash effectiveness, flash-to-kill sync, average HE/fire damage per nade, and trade pairs (who avenges whom). Deep-dive on the Pattern Finder page.</li>
        <li><b>Boost spots:</b> 🧠 player-on-player boosts they repeat (detected geometrically), with replay links.</li>
        <li><b>Map control → outcome:</b> 🧠 "when they take area X, where does the round end?" — areas held by 2+ players early, correlated with the finishing bombsite as a <b>×N</b> lift over their own average.</li>
        <li><b>Thrown rounds:</b> rounds lost after reaching 75%+ win probability, each linked to the exact replay moment.</li>
        <li><b>Players:</b> role cards (entry / lurker / anchor / AWP with evidence), opening duels, clutches, trades.</li>
      </ul>

      <h2>5. Compare &amp; veto</h2>
      <ul>
        <li>Two full reports side by side with mirrored bars — pick any two teams and a shared map (also reachable from a match&apos;s header).</li>
        <li><b>Veto simulation:</b> rational ban/pick sequences for BO1/BO3/BO5 from both teams&apos; map strengths, with the reasoning (relative edge and sample) at every step and projected maps.</li>
      </ul>

      <h2>6. 🧭 Pattern Finder</h2>
      <ul>
        <li>Finds a team&apos;s grenade <b>habits</b>: every grenade on a map as landing dots, with the <b>top repeated spots</b> ranked for you ("smoke → TopMid ×47, usually at 1:39 ±5s").</li>
        <li><b>Drag a box</b> on the map to isolate an area; the timing histogram shows exactly when in the round those grenades come, and the round list jumps into the replay.</li>
        <li>Filter by team, side, thrower, period and grenade type; turn on trajectory lines when you want to see the throws.</li>
      </ul>

      <h2>7. 🔬 Scenarios</h2>
      <ul>
        <li>Situation questions about a team, like a moment search for tendencies: pick side, buy, previous-round result, where the previous round ended, and round type.</li>
        <li>You get 🧠 the historical strategy mix in exactly that spot, how far it deviates from their normal game (<b>×N vs usual</b>), and real rounds to watch — e.g. "full buy, right after losing on A → they drop Palace to ×0.3 and load mid."</li>
      </ul>

      <h2>8. Player pages</h2>
      <ul>
        <li><b>Map-driven:</b> pick a map (chips at the top, or click a row in the Maps table) and the role cards, clutch moments and heatmaps all focus on it; "all maps" is the overall profile.</li>
        <li><b>Roles:</b> 🧠 per-side cards (entry / lurker / anchor:site / AWP) with the evidence — opening duels, entry share, AWP rounds, utility per round, flash assists, trades made and deaths traded, utility damage.</li>
        <li><b>Notable moments:</b> multi-kill rounds (3k/4k/ace) first, then clutch wins, each linked to the replay.</li>
        <li><b>Positioning heatmaps</b> per side, with an <b>AWP-only</b> toggle (only positions taken while carrying the big gun) and a whole-round / first-25 s switch.</li>
        <li><b>Anomaly flags:</b> 🧠 matches that were unusual for this player vs their own baseline (good or bad — not accusations).</li>
      </ul>

      <h2>9. Leaderboards &amp; Moments</h2>
      <ul>
        <li><b>Leaderboards:</b> archive-wide top-20s — ADR, opening-duel net, clutch wins, flash effectiveness, trade kills. Every board states its minimum sample.</li>
        <li><b>Moments:</b> a structured search over every round ever parsed ("AWP kills through smoke on eco"), with presets and savable searches. Results deep-link into replays.</li>
      </ul>

      <h2>10. 🧠 ML Lab — the models behind the predictions</h2>
      <p className="meta">The transparency page. ML isn&apos;t hidden in one corner — 🧠 marks it across the site — and this is where you see how it&apos;s tested.</p>
      <ul>
        <li><b>Prediction lab:</b> pick a team (and optional opponent) and see exactly what the site would predict for any map/side/buy, with the method and evidence attached.</li>
        <li><b>Method race:</b> six methods try to predict each round&apos;s strategy, from a simple league average to a gradient-boosted <b>LightGBM</b> model. They&apos;re scored on a <i>temporal test</i> — train on older rounds, predict the newest 25% of every match. Lower log-loss = less surprised by what actually happened.</li>
        <li><b>The honesty rule:</b> per map &amp; side, only the winning method is ever served anywhere on the site. A model that can&apos;t beat the simple baseline stays on the bench — you&apos;re never shown numbers that tested worse.</li>
        <li><b>LightGBM insight:</b> where the learned model wins, it&apos;s explained in three plain ingredients — the round economy, the team&apos;s strategy fingerprint, and how much history there is.</li>
        <li><b>Cluster explorer:</b> browse the strategies themselves — each cluster is a recurring way a side opens a round, with example rounds that jump into the replay.</li>
      </ul>

      <h2>11. My DB — your own demos, on your machine</h2>
      <ul>
        <li>Keep your demos (scrims, officials, POV) in a folder; in <b>My DB</b> pick it once (Chrome/Edge). Unprocessed demos are parsed one by one — stop anytime, it resumes.</li>
        <li><b>Privacy by design:</b> your demo visits the server only to be parsed, never joins the public site, and the server copy is deleted the instant your browser saves the result. Results live in a <code>.freezetime/</code> folder next to your demos — portable, re-importable on any machine in seconds.</li>
        <li><b>Compose with public matches:</b> the archive picker pulls chosen public matches into your database (e.g. your next opponent&apos;s official maps next to your scrims). They live locally with a 🌐 badge, count in your team report and clustering, and can be removed without touching the public site.</li>
        <li><b>Team voice comms:</b> attach a recording (mp3/ogg/wav) to any local match with the 🎙 button. It plays inside the replay locked to the match clock — scrubbing and speed keep it in sync, and an offset control lines the calls up with the action. The audio never leaves your machine.</li>
        <li><b>Your team report</b> gives your archive the same intelligence the main site uses; below 12 rounds per side the strategy section hides itself instead of guessing.</li>
      </ul>

      <h2>12. How the numbers are made</h2>
      <ul>
        <li><b>Parse once, query forever:</b> each demo is parsed a single time into positions (16 Hz), kills, grenades and economy; every feature reads from that.</li>
        <li><b>Honest statistics:</b> every percentage carries its <i>n</i>; thresholds (8+ rounds for setups, 30+ for role tags, 12+ for clustering, 3+ for utility/boost spots) hide thin data entirely.</li>
        <li><b>Strategy clusters</b> group rounds by where a side spends the opening seconds and what utility it uses — shown as an <b>area mix</b> (players split across areas, with real shares on hover), not a single route. No black box, no external AI; deterministic and reproducible.</li>
        <li><b>Win probability</b> is historical: for each game state (alive counts, bomb, clock bucket) it&apos;s the actual T win rate across the archive, smoothed toward similar states when a cell is rare.</li>
        <li><b>Recency weighting:</b> tendencies, predictions and utility/setup shares weight each round by age (half-life ≈ 3 months) — last week matters more than last winter. Raw round counts stay unweighted, so you always see the true evidence size.</li>
        <li><b>Retention:</b> matches past the retention window keep their stats and results forever, but replay/heatmap data is removed (marked "archived"). The time-window filter narrows further.</li>
      </ul>

      <h2>13. Tips</h2>
      <ul>
        <li>Time-window filters are free-form: "7 weeks" and "2 years" are both valid.</li>
        <li>Name clusters early (✏ in the report) — the names flow into predictions, compare and match pages.</li>
        <li>Align ghost rounds at <i>bomb plant</i> to compare post-plant setups, and at <i>first kill</i> to study trades.</li>
        <li>Use the highlight picker on the match page to ring every round a team ran a given strategy, then step through them.</li>
        <li>setpos + a practice server is the fastest way to rebuild any position you find in a demo.</li>
      </ul>
    </div>
  );
}
