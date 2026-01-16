import { setActiveNav, loadTournament, esc } from "./util.js";
import { getFB, watchAllMatches } from "./store-fb.js";

setActiveNav("points");
const FB = getFB();

function emptyRow(team, group){
  return {team, group, played:0, won:0, lost:0, tied:0, nr:0, pts:0};
}

function compute(t, matches){
  const map = {};
  for(const [g, teams] of Object.entries(t.groups)){
    for(const tm of teams) map[tm]=emptyRow(tm, g);
  }
  for(const m of matches){
    if(!map[m.a] || !map[m.b]) continue;
    if(m.status!=="COMPLETED") continue;
    map[m.a].played += 1;
    map[m.b].played += 1;

    const winner = m.result?.winner || null; // "A"/"B"/team name
    const tie = m.result?.tie || false;

    if(tie){
      map[m.a].tied += 1;
      map[m.b].tied += 1;
      map[m.a].pts += 1;
      map[m.b].pts += 1;
    } else if(winner){
      const wTeam = (winner==="A")? m.a : (winner==="B")? m.b : winner;
      const lTeam = (wTeam===m.a)? m.b : m.a;
      if(map[wTeam] && map[lTeam]){
        map[wTeam].won += 1; map[wTeam].pts += 2;
        map[lTeam].lost += 1;
      }
    } else {
      // if scorer didn't set result yet: mark NR
      map[m.a].nr += 1;
      map[m.b].nr += 1;
      map[m.a].pts += 1;
      map[m.b].pts += 1;
    }
  }
  const byGroup = {};
  for(const row of Object.values(map)){
    (byGroup[row.group] ||= []).push(row);
  }
  for(const g of Object.keys(byGroup)){
    byGroup[g].sort((x,y)=> (y.pts-x.pts) || (y.won-x.won) || x.team.localeCompare(y.team));
  }
  return byGroup;
}

function render(byGroup){
  const wrap = document.getElementById("pointsWrap");
  wrap.innerHTML = Object.entries(byGroup).map(([g, rows])=>`
    <div class="card">
      <div class="h1" style="font-size:18px">Group ${esc(g)}</div>
      <div class="sep"></div>
      <table class="table">
        <thead><tr>
          <th>Team</th><th>P</th><th>W</th><th>L</th><th>T</th><th>NR</th><th>Pts</th>
        </tr></thead>
        <tbody>
          ${rows.map(r=>`
            <tr>
              <td><b>${esc(r.team)}</b></td>
              <td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.tied}</td><td>${r.nr}</td><td><b>${r.pts}</b></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div class="muted small" style="margin-top:10px">Note: NRR can be added later if required.</div>
    </div>
  `).join("");
}

(async function(){
  const t = await loadTournament();
  if(!FB){
    document.getElementById("pointsWrap").innerHTML = `<div class="card"><div class="muted small">Firebase not configured.</div></div>`;
    return;
  }
  watchAllMatches(FB, (docs)=>{
    render(compute(t, docs));
  });
})();
