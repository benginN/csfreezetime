// Yardım: SON KULLANICI için eksiksiz kılavuz. Yönetici/altyapı detayı
// içermez (radar dosya yolları, backfill, sunucu kurulumu vb. YOK).
export default function Help() {
  return (
    <div className="help" style={{ maxWidth: 860, lineHeight: 1.65 }}>
      <h1>Help — everything Freezetime can do</h1>
      <p className="meta">
        Freezetime turns CS2 demos into coach-grade intelligence: a synchronized
        2D replay, archive-wide statistics, and honest numbers — every claim
        carries its sample size, and thin data hides itself rather than mislead.
      </p>

      <h2>1. Finding things — Home &amp; search</h2>
      <ul>
        <li><b>Team strip:</b> the top row lists every team alphabetically; scroll it sideways (mouse wheel works). Click a team for its overview page.</li>
        <li><b>Tournament strip:</b> right below it, every tournament in the archive — most recent event first. Click one and the search locks to exactly that event&apos;s matches.</li>
        <li><b>Search box:</b> type anything — team ("spirit"), player ("donk"), map ("mirage"), tournament ("cologne") or combinations ("spirit mirage"). Matching team, player and 🏆 tournament chips appear above the results; matches filter live.</li>
        <li>The default list shows the most recent 100 <b>encounters</b> — a BO3/BO5 counts as one entry with its maps grouped inside, so a series is never cut in half at the bottom of the list. Searching reaches the entire database (the total is shown in the header).</li>
        <li><b>Split recordings:</b> when a server restart split a map into two demos, the list shows ONE row with the combined score and an "N parts" badge. Inside, a banner links between parts and round numbers continue across them (part 2 starts at round 7 if part 1 ended 3-3).</li>
      </ul>

      <h2>2. The match page — one map, three independent layers</h2>
      <p>
        Open any match and you get a single map with three layers that never
        interfere with each other. Each has a checkbox header — unchecking
        greys the section out. Only the checkbox and the title toggle a
        section, so stray clicks on the row do nothing.
      </p>

      <h3>2a. Replay</h3>
      <ul>
        <li>Play/pause, speeds from 0.25x to 8x, and a timeline (bottom right) marked with kills and events — click any mark to jump.</li>
        <li><b>Players:</b> dots show facing direction, an HP ring, shield/money/inventory in the corner HUD, and a live killfeed. Blinded players whiten and fade back as the flash wears off. Muzzle flashes and red tracers show who is shooting whom.</li>
        <li><b>Bomb:</b> the C4 carrier wears a small red dot; if the bomb is dropped, the red dot stays on the ground where it lies.</li>
        <li><b>Dropped weapons:</b> when a player dies, their weapon stays as a small pale square at the death spot for the rest of the round — the name shows for 3 seconds, and any time on hover.</li>
        <li><b>Focus a player:</b> click a name in the HUD (or use the player select) to highlight them; the timeline switches to their kills/deaths/nade throws. The <b>setpos</b> button copies their exact position and view angles as a console command for your practice server.</li>
        <li><b>Round chips:</b> colored by the winning team, with a side stripe (amber = T win, blue = CT win) and a divider at side swaps. The <b>highlight</b> dropdown rings rounds by buy type — the ring color tells you WHICH team had that buy (cyan = left team, purple = right team, double ring = both).</li>
        <li><b>Win probability:</b> the sparkline above the timeline shows the live T win chance, computed from archive history (alive counts, bomb state, clock). The percentage updates as you scrub.</li>
        <li><b>Drawing:</b> pen and arrow tools live on the map edge with a color picker; drawings save per round automatically and survive reloads.</li>
        <li><b>Zoom:</b> mouse wheel / trackpad pinch, drag to pan, double-click to reset; +/- buttons on the map.</li>
        <li><b>Keyboard:</b> Space = play/pause · Left/Right = step · Up/Down = round · 1-6 = speed · Esc = clear focus.</li>
      </ul>

      <h3>2b. Heatmap</h3>
      <ul>
        <li>Football-style position density for <b>any set of rounds you pick</b> (chips, or all/none), one side or both, one player or everyone.</li>
        <li>The player list is side-aware: pick CT and only players who actually played CT in your selected rounds appear.</li>
        <li>Lower levels (Nuke) render in their own inset.</li>
      </ul>

      <h3>2c. Ghost rounds</h3>
      <ul>
        <li>Overlay many rounds as translucent trails with their <b>own clock</b> — align them at round start, bomb plant, or first kill, and compare how executions differ.</li>
        <li>Filter to one side or a single player; each round is color-coded and labeled (r7, r19…).</li>
        <li><b>Trail slider:</b> choose how long the tail behind each ghost is (1-60 s, or the full path at the far right).</li>
        <li><b>Hover a ghost dot</b> for its name; the bottom-right panel shows that player&apos;s live HP/armor/money/inventory at the ghost clock. <b>Click the dot to pin</b> the panel; unpin with the panel&apos;s ✕ or by clicking empty map.</li>
      </ul>

      <h3>2d. Notes &amp; playlists</h3>
      <ul>
        <li><b>Notes:</b> write a text note — or record a voice note with the mic button — pinned to the exact second of the round. Amber marks on the timeline jump to them.</li>
        <li><b>Playlists:</b> save the current moment into a named playlist from the Replay panel. On the Playlists page, "Play all" walks the collection and <b>auto-advances</b> when each round ends — a hands-free VOD review session.</li>
      </ul>

      <h2>3. Team intelligence</h2>
      <h3>3a. Team page</h3>
      <p>Overall record, per-map report cards, and the team&apos;s matches. The <b>time window</b> (last N weeks/months/years — free-form) and <b>lineup ≥ N/5</b> filters at the top narrow everything, including the match list. Lineup compares against the five who played the team&apos;s most recent match.</p>

      <h3>3b. Opponent report (per team + map)</h3>
      <ul>
        <li><b>Overview:</b> map record, side round-win rates, pistols, conversion after a won pistol.</li>
        <li><b>Recent results:</b> the matches behind the numbers, W/L colored, linked to replays.</li>
        <li><b>Execute templates:</b> utility combinations the team repeats across matches ("window smoke + top-mid flash + top-mid smoke x8, 88% won → A 3 / B 4").</li>
        <li><b>Strategy tendencies:</b> the archive clusters each round&apos;s approach; bars show what this team actually favors (recent matches count more — see section 6). The pencil next to a bar lets you name a strategy ("B rush") — the name then appears everywhere. The buy-conditional table answers "they are on a force — what is coming?".</li>
        <li><b>Next-round prediction:</b> the report embeds the same prediction engine as the ML Lab. Pick side, buy and (optionally) the opponent you are preparing against, and you get the most likely strategies with probabilities — plus <i>which method produced them and on how much evidence</i>. The method is chosen automatically: whichever won the honesty test for that map &amp; side (see section 5).</li>
        <li><b>Economy behaviour:</b> buy mixes and the reaction after a lost pistol.</li>
        <li><b>Default setups:</b> where the five stand 15 s into the round, with hold times and how setups <b>rotate after first contact</b> (destination mix and delay).</li>
        <li><b>Utility habits:</b> recurring smoke/molotov/flash spots with timing, plus flash effectiveness, flash-to-kill sync, average HE/fire damage per nade, and trade pairs (who avenges whom).</li>
        <li><b>Thrown rounds:</b> rounds the team lost after reaching a 75%+ win probability — each links to the exact replay moment.</li>
        <li><b>Players:</b> role cards (entry/lurker/anchor/AWP with evidence), opening duels, clutches, trades.</li>
        <li>Everything respects the time-window and lineup filters; sections built from archive-wide models say so when a window is active. <b>Print</b> produces a clean one-pager.</li>
      </ul>

      <h3>3c. Compare &amp; veto</h3>
      <ul>
        <li>Two full reports side by side with mirrored bars — pick any two teams and a shared map. Also reachable from any match via the report icon in its header.</li>
        <li><b>Veto simulation:</b> rational ban/pick sequences for BO1/BO3/BO5 from both teams&apos; map strengths, with the reasoning (relative edge and sample) at every step, and projected maps with a clearly-labeled win heuristic.</li>
      </ul>

      <h2>4. Players, leaderboards, moments</h2>
      <ul>
        <li><b>Player pages:</b> per-side role cards with entry/opening/AWP/utility evidence, flash and utility-damage numbers, trades made and deaths traded, clutch history (each 1vX linked to its replay), per-map stats and personal heatmaps.</li>
        <li><b>Leaderboards:</b> archive-wide top-20s — ADR, opening-duel net, clutch wins, flash effectiveness, trade kills. Every board states its minimum sample.</li>
        <li><b>Moments:</b> a structured search over every round ever parsed — "AWP kills through smoke on eco" — with presets and savable searches. Results deep-link into replays.</li>
      </ul>

      <h2>5. ML Lab — the models behind the predictions</h2>
      <ul>
        <li>The 🧠 <b>ML Lab</b> page shows what the prediction models know, how good they are, and how they are tested — with every panel explained in plain words.</li>
        <li><b>Method race:</b> six methods try to predict each round&apos;s strategy, from a simple league average to a gradient-boosted <b>LightGBM</b> model. They are scored on a <i>temporal test</i>: train on older rounds, predict the newest 25% of every match. Think of the score as "how surprised was the method by what actually happened" — lower is better.</li>
        <li><b>The honesty rule:</b> per map &amp; side, only the winning method is ever shown anywhere on the site. A fancy model that cannot beat the simple baseline stays on the bench — you will never be shown numbers that tested worse.</li>
        <li><b>LightGBM insight:</b> where the learned model wins, bar charts show which inputs drive its decisions (economy, the team&apos;s own strategy history, evidence volume) — no black box.</li>
        <li><b>Prediction lab:</b> try any team/opponent/map/side/buy combination yourself and see exactly what the site would serve, with the method and evidence note attached.</li>
        <li><b>Cluster explorer:</b> browse the strategies themselves — each cluster is a recurring way a side opens a round, with example rounds that jump straight into the replay.</li>
      </ul>

      <h2>6. My database — your own demos, on your machine</h2>
      <ul>
        <li>Keep your demos (scrims, officials) in a folder on your computer. In <b>My DB</b>, pick that folder once (Chrome/Edge). Unprocessed demos are parsed one by one — stop anytime; it resumes where it left off.</li>
        <li><b>Privacy by design:</b> your demo visits the server only to be parsed, never becomes part of the public site, and the server copy is deleted the moment your browser saves the result. Your matches, team names and players are invisible to everyone else.</li>
        <li>Results are written into a <code>.freezetime/</code> folder next to your demos — that folder <b>is</b> your database: portable, re-importable on any machine in seconds, no re-uploads.</li>
        <li><b>Mix in public matches:</b> the "Add matches from the Freezetime archive" panel lets you search the public archive and pull picked matches into your database — e.g. your next opponent&apos;s official maps next to your own scrims. They download once, live in your browser like your own matches (🌐 badge), count in your team report and clustering, and can be removed any time without touching the public site.</li>
        <li>Local matches open with the full match page: replay, heatmap, ghost rounds — all computed in your browser (they even work offline).</li>
        <li><b>Your team report</b> gives your archive the same intelligence: overview, economy, utility spots, setups, player table, trade pairs, thrown rounds, and — with enough rounds — the same strategy clustering and buy-conditional tendencies the main site uses. Below 12 rounds per side the strategy section hides itself instead of guessing.</li>
      </ul>

      <h2>7. How the numbers are made</h2>
      <ul>
        <li><b>Parse once, query forever:</b> each demo is parsed a single time into positions (16 Hz), kills, grenades and economy; every feature reads from that.</li>
        <li><b>Honest statistics:</b> every percentage carries its n; thresholds (e.g. 8+ rounds for setups, 30+ for role tags, 12+ for clustering, 3+ throws for utility spots) hide thin data entirely.</li>
        <li><b>Win probability</b> is historical: for each game state (alive counts, bomb, clock bucket) it is the actual T win rate across the archive, smoothed toward similar states when a cell is rare.</li>
        <li><b>Strategy clusters</b> group rounds by where a team spends the first 30 seconds and what utility it uses — no black boxes, no external AI; everything is deterministic and reproducible.</li>
        <li><b>Recency weighting:</b> tendencies, predictions and utility/setup shares weight each round by its age (half-life ≈ 3 months) — a team&apos;s style from last week matters more than from last winter. Raw round counts shown next to numbers stay unweighted, so you always see the true evidence size.</li>
        <li><b>Retention:</b> matches older than 12 months keep their statistics and results forever, but replay/heatmap data is removed (marked "archived"). Old meta stays out of today&apos;s models by design — and the time-window filter lets you narrow further.</li>
      </ul>

      <h2>8. Tips</h2>
      <ul>
        <li>Time-window filters are free-form: type any number and pick weeks/months/years — "7 weeks" and "2 years" are both valid.</li>
        <li>Name clusters early (pencil in the report) — the names flow into predictions, compare pages and match pages.</li>
        <li>Align ghost rounds at <i>bomb plant</i> to compare post-plant setups, and at <i>first kill</i> to study trades.</li>
        <li>Setpos + a practice server is the fastest way to rebuild any position you find in a demo.</li>
      </ul>
    </div>
  );
}
