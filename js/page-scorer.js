import { setActiveNav, qs, loadTournament } from "./util.js";
import { getFB, watchMatch, addBall, undoBall, setMatchStatus, resetMatch, watchAuth, setToss, setPlayingXI, finalizeMatchAndComputeAwards } from "./store-fb.js";
import { renderScoreLine, renderCommentary } from "./renderers.js";

setActiveNav("scorer");
const FB = getFB();

const $ = (id)=>document.getElementById(id);
const esc = (s)=> (s??"").toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const params = qs();
const matchId = params.get("matchId") || params.get("match") || "A1";

let TOURNAMENT = null;
let SQUADS = {}; // team -> [15]
let CURRENT_DOC = null;
let LAST_STATUS = null;
let _tossMounted = false;
let _xiMounted = false;

// -----------------------------
// Helpers
// -----------------------------
function showState(msg, ok=true){
  const el = $("sMeta");
  if(!el) return;
  el.textContent = msg;
  el.style.color = ok ? "var(--muted)" : "#ff9a9a";
}

function showAwardsPopup(awards){
  if(!awards) return;
  const mom = awards.mom;
  const six = awards.sixerKing;
  const bb = awards.bestBowler;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="popup">
      <div class="row" style="justify-content:space-between; gap:12px; align-items:center">
        <div>
          <div class="h1" style="font-size:18px">Match Awards</div>
          <div class="muted small" style="margin-top:2px">Auto calculated (rules-based)</div>
        </div>
        <button class="btn" id="awClose">Close</button>
      </div>

      <div class="awardsGrid" style="margin-top:12px">
        <div class="awardCard awardMom">
          <div class="awardTitle">🏅 Man of the Match</div>
          <div class="awardName">${esc(mom?.name||"-")}</div>
          <div class="awardMeta">${esc(mom?.team||"")} ${mom?.score!=null?` • Score ${esc(mom.score)}`:""}</div>
        </div>

        <div class="awardCard awardSix">
          <div class="awardTitle">💥 Sixer King Award</div>
          <div class="awardName">${esc(six?.name||"-")}</div>
          <div class="awardMeta">${esc(six?.team||"")} ${six?.sixes!=null?` • 6s ${esc(six.sixes)}`:""}</div>
        </div>

        <div class="awardCard awardBowl">
          <div class="awardTitle">🎯 Best Bowler Award</div>
          <div class="awardName">${esc(bb?.name||"-")}</div>
          <div class="awardMeta">${esc(bb?.team||"")} ${bb?.wickets!=null?` • ${esc(bb.wickets)}W`:""}${bb?.econ!=null?` • Eco ${esc(bb.econ)}`:""}</div>
        </div>
      </div>

      <div class="muted small" style="margin-top:12px">Tip: Awards edit karne ho to Admin panel me manual override future me add kar sakte hain.</div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector("#awClose")?.addEventListener("click", ()=>overlay.remove());
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) overlay.remove(); });
}

function squadOf(team){
  const list = SQUADS?.[team];
  if(Array.isArray(list) && list.length) return list;
  const base = (team||"Team").toString().trim() || "Team";
  return Array.from({length:15}, (_,i)=>`${base} Player ${i+1}`);
}

function playingXIOf(state, team){
  const xi = state?.playingXI?.[team];
  if(Array.isArray(xi) && xi.length===11) return xi;
  return null;
}

function fillSelect(sel, list, placeholder){
  if(!sel) return;
  const keep = sel.value;
  sel.innerHTML = "";
  const o0 = document.createElement("option");
  o0.value = "";
  o0.textContent = placeholder || "Select...";
  sel.appendChild(o0);
  for(const n of list){
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  if(keep && list.includes(keep)) sel.value = keep;
}

function currentInnings(doc){
  const st = doc?.state;
  const idx = Number(st?.inningsIndex||0);
  return st?.innings?.[idx] || null;
}

function battingBowlingTeams(doc){
  const st = doc?.state || {};
  const inn = currentInnings(doc);
  const summary = doc?.summary || st.summary || {};
  return {
    batting: inn?.batting || summary.batting || doc?.a,
    bowling: inn?.bowling || summary.bowling || doc?.b
  };
}

function ensureDropdowns(doc){
  const st = doc?.state || {};
  const { batting, bowling } = battingBowlingTeams(doc);

  const batXI = playingXIOf(st, batting);
  const bowlXI = playingXIOf(st, bowling);

  const batList = batXI || squadOf(batting);
  const bowlList = bowlXI || squadOf(bowling);

  fillSelect($("batter"), batList, `Select striker (${batting})...`);
  fillSelect($("nonStriker"), batList, `Select non-striker (${batting})...`);
  fillSelect($("bowler"), bowlList, `Select bowler (${bowling})...`);
}

function fmtOversFromBalls(balls){
  const o = Math.floor((Number(balls||0))/6);
  const b = (Number(balls||0))%6;
  return `${o}.${b}`;
}

function renderScorerLiveChip(doc){
  const box = $("scorerLiveChip");
  if(!box) return;
  const st = doc?.state || {};
  const inn = currentInnings(doc);
  if(!inn){
    box.innerHTML = `<div class="muted small">Live chip</div><div class="muted small">No innings.</div>`;
    return;
  }
  const of = inn.onField || {};
  const striker = (of.striker||"").trim();
  const nonStriker = (of.nonStriker||"").trim();
  const bowler = (of.bowler||"").trim();

  const sb = striker ? (inn.batters?.[striker] || {}) : {};
  const ns = nonStriker ? (inn.batters?.[nonStriker] || {}) : {};
  const bo = bowler ? (inn.bowlers?.[bowler] || {}) : {};

  const score = `${inn.runs||0}/${inn.wkts||0}`;
  const overs = `${inn.overs||"0.0"}`;
  const pp = Number(st.powerplayOvers ?? doc?.powerplayOvers ?? 3);
  const inPP = !!(st.summary?.inPowerplay);

  // Chase metrics (innings 2)
  const totalOvers = Number(st.oversPerInnings || doc?.oversPerInnings || 10);
  const totalBalls = Math.max(0, totalOvers * 6);
  const i1 = st?.innings?.[0];
  const isChase = (Number(st.inningsIndex||0) === 1 && !!i1);
  const i1Complete = isChase && (
    Number(i1.balls||0) >= totalBalls ||
    Number(i1.wkts||0) >= 10 ||
    Number(st.inningsIndex||0) >= 1
  );
  let chaseLine = "";
  if(isChase && i1Complete){
    const target = Number(i1.runs||0) + 1;
    const ballsUsed = Number(inn.balls||0);
    const ballsLeft = Math.max(0, totalBalls - ballsUsed);
    const runs = Number(inn.runs||0);
    const runsNeeded = Math.max(0, target - runs);
    const reqRR = ballsLeft > 0 ? Math.round(((runsNeeded*6)/ballsLeft)*100)/100 : 0;
    chaseLine = `
      <div class="muted small" style="margin-top:4px">
        <b>Target</b> ${esc(target)} <span class="muted">•</span>
        ${runsNeeded<=0 ? `<b>Target achieved</b>` : `<b>Need</b> ${esc(runsNeeded)} in ${esc(ballsLeft)} balls`}
        <span class="muted">•</span> <b>Req RR</b> ${esc(reqRR)}
      </div>
    `;
  }

  const ppLine = inPP ? `
      <div class="muted small" style="margin-top:4px">
        <b>Powerplay</b> • Overs 1-${esc(pp)}
      </div>
    ` : "";

  const bowOvers = bowler ? fmtOversFromBalls(bo.oBalls||0) : "-";

  box.innerHTML = `
    <div class="row wrap" style="justify-content:space-between; gap:10px; align-items:flex-start">
      <div>
        <div class="muted small">LIVE • ${esc(inn.batting||"")}</div>
        <div style="margin-top:4px"><b>${esc(score)}</b> <span class="muted">(${esc(overs)})</span></div>
        ${ppLine}
        ${chaseLine}
      </div>
      <a class="chip" href="scorecard.html?match=${encodeURIComponent(doc.matchId||matchId)}" style="text-decoration:none">Scorecard</a>
    </div>

    <div class="sep" style="margin:10px 0"></div>

    <div class="grid cols2" style="gap:8px">
      <div>
        <div class="muted small">Batters</div>
        <div style="margin-top:4px">
          <div><b>${esc(striker||"-")}</b>${striker?" *":""} <span class="muted">${striker?` ${sb.r||0}(${sb.b||0})`:""}</span></div>
          <div><b>${esc(nonStriker||"-")}</b> <span class="muted">${nonStriker?` ${ns.r||0}(${ns.b||0})`:""}</span></div>
        </div>
      </div>
      <div>
        <div class="muted small">Bowler</div>
        <div style="margin-top:4px">
          <div><b>${esc(bowler||"-")}</b></div>
          <div class="muted small">O ${esc(bowOvers)} • R ${esc(bo.r||0)} • W ${esc(bo.w||0)}</div>
        </div>
      </div>
    </div>
  `;
}

function requireNames(){
  const batter = $("batter")?.value?.trim();
  const nonStriker = $("nonStriker")?.value?.trim();
  const bowler = $("bowler")?.value?.trim();
  if(!batter || !nonStriker){
    showState("Striker & non-striker select karo.", false);
    return null;
  }
  if(batter===nonStriker){
    showState("Striker aur non-striker same nahi ho sakte.", false);
    return null;
  }
  if(!bowler){
    showState("Bowler select karo.", false);
    return null;
  }

  // Wicket flow enforcement: next batter must be assigned before any next delivery.
  const inn = currentInnings(CURRENT_DOC);
  const of = inn?.onField;
  if(of?.needNextBatter){
    showState("Wicket hua hai. Pehele Wicket flow me next batsman select karo.", false);
    return null;
  }

  // Over-end enforcement
  // (separate from wicket enforcement)
  if(of?.needNewBowler){
    if(of?.lastBowler && bowler === of.lastBowler){
      showState("Same bowler next over nahi dal sakta. New bowler select karo.", false);
      return null;
    }
  }

  // Max 2-over (or configured) restriction
  const st = CURRENT_DOC?.state || {};
  const maxO = Number(st.maxOversPerBowler ?? 2);
  const maxBalls = Math.max(0, maxO*6);
  if(maxBalls>0){
    const inn = currentInnings(CURRENT_DOC);
    const oBalls = Number(inn?.bowlers?.[bowler]?.oBalls || 0);
    if(oBalls >= maxBalls){
      showState(`${bowler} max ${maxO} overs complete. New bowler select karo.`, false);
      return null;
    }
  }

  return { batter, nonStriker, bowler };
}

async function safeAddBall(ball){
  try{
    await addBall(FB, matchId, ball);
  }catch(e){
    const msg = e?.message || String(e);
    showState(msg, false);
    alert(msg);
  }
}

// -----------------------------
// Toss Card (inject)
// -----------------------------
function mountTossCard(){
  if(_tossMounted) return;
  const batterSel = $("batter");
  if(!batterSel) return;

  const ballCard = batterSel.closest(".card");
  const parent = ballCard ? ballCard.parentElement : null;
  if(!ballCard || !parent) return;

  const tossCard = document.createElement("div");
  tossCard.className = "card";
  tossCard.id = "tossCard";
  tossCard.innerHTML = `
    <div class="h1" style="font-size:16px">Toss & Match Setup</div>
    <div class="muted small" style="margin-top:4px">Pehele toss set karo. Phir Playing XI select karo. Phir Start Match (LIVE).</div>
    <hr class="sep"/>

    <div class="grid cols2">
      <div>
        <div class="muted small">Toss winner</div>
        <select id="tossWinner" class="input">
          <option value="">Select team…</option>
        </select>
      </div>
      <div>
        <div class="muted small">Decision</div>
        <select id="tossDecision" class="input">
          <option value="BAT">Bat</option>
          <option value="BOWL">Bowl</option>
        </select>
      </div>
    </div>

    <div style="margin-top:10px" class="row wrap">
      <button class="btn ok" id="btnSaveToss" type="button">Save Toss</button>
      <div class="muted small" id="tossMsg"></div>
    </div>
  `;

  parent.insertBefore(tossCard, ballCard);
  _tossMounted = true;

  $("btnSaveToss")?.addEventListener("click", async ()=>{
    const winner = $("tossWinner")?.value?.trim();
    const decision = $("tossDecision")?.value?.trim() || "BAT";
    if(!winner) return alert("Toss winner select karo");
    try{
      await setToss(FB, matchId, winner, decision);
      $("tossMsg").textContent = "Toss saved ✅ Ab Playing XI select karo.";
    }catch(e){
      alert(e?.message || String(e));
    }
  });
}

function updateTossUI(doc){
  if(!_tossMounted) mountTossCard();
  const winnerSel = $("tossWinner");
  if(!winnerSel) return;

  const teams = [doc?.a, doc?.b].filter(Boolean);
  fillSelect(winnerSel, teams, "Select team…");

  const st = doc?.state || {};
  const hasToss = !!(st.toss || doc?.tossWinner);
  const card = $("tossCard");
  const msg = $("tossMsg");

  if(card){
    // Show whenever toss not set (even if match accidentally flipped to LIVE)
    card.style.display = (!hasToss) ? "block" : (doc?.status==="UPCOMING" ? "block" : "none");
  }
  if(msg){
    if(hasToss){
      const t = st.toss || { winner: doc.tossWinner, decision: doc.tossDecision };
      msg.textContent = `Saved: ${t.winner} won, chose ${t.decision}.`;
    } else {
      msg.textContent = "Toss pending.";
    }
  }
}

// -----------------------------
// Playing XI Card (inject)
// -----------------------------
function mountPlayingXICard(){
  if(_xiMounted) return;

  const batterSel = $("batter");
  const ballCard = batterSel ? batterSel.closest(".card") : null;
  const parent = ballCard ? ballCard.parentElement : null;
  if(!parent || !ballCard) return;

  const xiCard = document.createElement("div");
  xiCard.className = "card";
  xiCard.id = "xiCard";
  xiCard.innerHTML = `
    <div class="h1" style="font-size:16px">Playing XI (11 out of 15)</div>
    <div class="muted small" style="margin-top:4px">Dono teams ke 11-11 players select karo. Fir scoring dropdown me sirf XI dikhेंगे.</div>
    <hr class="sep"/>

    <div class="grid cols2">
      <div>
        <div class="muted small" id="xiLabelA">Team A XI</div>
        <div id="xiListA" class="grid" style="gap:6px"></div>
        <div class="muted small" id="xiCountA" style="margin-top:6px">Selected: 0/11</div>
      </div>
      <div>
        <div class="muted small" id="xiLabelB">Team B XI</div>
        <div id="xiListB" class="grid" style="gap:6px"></div>
        <div class="muted small" id="xiCountB" style="margin-top:6px">Selected: 0/11</div>
      </div>
    </div>

    <div class="row wrap" style="margin-top:10px">
      <button class="btn ok" id="btnSaveXI" type="button">Save Playing XI</button>
      <div class="muted small" id="xiMsg"></div>
    </div>
  `;

  // Toss card already above Ball card, so this goes under Toss automatically
  parent.insertBefore(xiCard, ballCard);
  _xiMounted = true;

  $("btnSaveXI")?.addEventListener("click", async ()=>{
    if(!CURRENT_DOC) return;
    const xiA = Array.from(document.querySelectorAll("#xiListA input[type=checkbox]:checked")).map(i=>i.value);
    const xiB = Array.from(document.querySelectorAll("#xiListB input[type=checkbox]:checked")).map(i=>i.value);
    try{
      await setPlayingXI(FB, matchId, xiA, xiB);
      $("xiMsg").textContent = "Playing XI saved ✅";
      showState("Playing XI saved ✅ Ab scoring start kar sakte ho.", true);
    }catch(e){
      alert(e?.message || String(e));
    }
  });
}

function renderXIList(containerId, players, selectedSet, countId){
  const box = $(containerId);
  if(!box) return;

  box.innerHTML = "";
  for(const p of players){
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    row.style.cursor = "pointer";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = p;
    cb.checked = selectedSet.has(p);

    cb.addEventListener("change", ()=>{
      const checked = Array.from(box.querySelectorAll("input[type=checkbox]:checked")).length;
      if(checked > 11){
        cb.checked = false;
        alert("Sirf 11 players select kar sakte ho.");
      }
      const finalCount = Array.from(box.querySelectorAll("input[type=checkbox]:checked")).length;
      const cEl = $(countId);
      if(cEl) cEl.textContent = `Selected: ${finalCount}/11`;
    });

    const sp = document.createElement("span");
    sp.textContent = p;

    row.appendChild(cb);
    row.appendChild(sp);
    box.appendChild(row);
  }

  const cnt = Array.from(box.querySelectorAll("input[type=checkbox]:checked")).length;
  const cEl = $(countId);
  if(cEl) cEl.textContent = `Selected: ${cnt}/11`;
}

function updateXIUI(doc){
  if(!_xiMounted) mountPlayingXICard();
  const card = $("xiCard");
  if(!card) return;

  const st = doc?.state || {};
  const hasToss = !!(st.toss || doc?.tossWinner);
  const hasXI = !!(st.playingXI && st.playingXI[doc.a]?.length===11 && st.playingXI[doc.b]?.length===11);

  // Show whenever XI not set but toss is available (even if match accidentally flipped to LIVE)
  card.style.display = (hasToss && !hasXI) ? "block" : (doc?.status==="UPCOMING" && hasToss ? "block" : "none");

  $("xiLabelA").textContent = `${doc.a} XI`;
  $("xiLabelB").textContent = `${doc.b} XI`;

  const squadA = squadOf(doc.a);
  const squadB = squadOf(doc.b);

  const selA = new Set((st.playingXI?.[doc.a] || []).filter(Boolean));
  const selB = new Set((st.playingXI?.[doc.b] || []).filter(Boolean));

  renderXIList("xiListA", squadA, selA, "xiCountA");
  renderXIList("xiListB", squadB, selB, "xiCountB");

  $("xiMsg").textContent = hasXI ? "Saved ✅ (You can re-save if needed)" : "Pending: select 11-11 players.";
}

// -----------------------------
// Wicket Modal (dropdown based + fielder)
// -----------------------------
const WICKET_TYPES = ["Bowled","Caught","Run Out","Stumped","Hit Wicket","Retired Hurt","Retired Out"];

function openWicketModal(doc){
  const modal = $("wicketModal");
  if(!modal) return alert("wicketModal missing in scorer.html");
  modal.style.display = "block";
  $("wicketMsg").textContent = "";

  const st = doc.state || {};
  const inn = currentInnings(doc) || st.innings?.[0] || {};
  const of = inn.onField || {};
  const { batting, bowling } = battingBowlingTeams(doc);

  $("outType").innerHTML = WICKET_TYPES.map(t=>`<option value="${t}">${t}</option>`).join("");

  const outs = [of.striker, of.nonStriker].filter(Boolean);
  $("outBatter").innerHTML = outs.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");

  const xiBat = playingXIOf(st, batting) || squadOf(batting);

  const outSet = new Set();
  Object.entries(inn.batters||{}).forEach(([name, b])=>{ if(b?.out) outSet.add(name); });

  const eligible = xiBat.filter(n=>{
    if(!n) return false;
    if(n===of.striker || n===of.nonStriker) return false;
    if(outSet.has(n)) return false;
    return true;
  });

  $("nextBatter").innerHTML = `<option value="">Select next batter…</option>` +
    eligible.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");

  const xiField = playingXIOf(st, bowling) || squadOf(bowling);
  fillSelect($("outFielder"), xiField, `Select fielder (${bowling})…`);
}

function closeWicketModal(){
  const modal = $("wicketModal");
  if(modal) modal.style.display = "none";
}

$("wicketCancel")?.addEventListener("click", closeWicketModal);
$("wicketX")?.addEventListener("click", closeWicketModal);

$("wicketSave")?.addEventListener("click", async ()=>{
  if(!CURRENT_DOC) return;

  const names = requireNames();
  if(!names) return;

  const outType = ($("outType")?.value || "Bowled").trim();
  const outBatter = ($("outBatter")?.value || "").trim();
  const nextBatter = ($("nextBatter")?.value || "").trim();
  const fielder = ($("outFielder")?.value || "").trim();

  const kindLc = outType.toLowerCase();
  const needsFielder = (kindLc==="caught" || kindLc==="run out" || kindLc==="stumped");
  const isRetHurt = (kindLc==="retired hurt");

  if(!outBatter){
    $("wicketMsg").textContent = "Out batsman select karo.";
    return;
  }
  if(needsFielder && !fielder){
    $("wicketMsg").textContent = "Fielder select karo (fielding XI).";
    return;
  }

  const inn = currentInnings(CURRENT_DOC) || {};
  const wktsNow = Number(inn.wkts||0);
  const lastWicket = wktsNow >= 9;
  if(!isRetHurt && !lastWicket && !nextBatter){
    $("wicketMsg").textContent = "Next batsman select karo.";
    return;
  }

  closeWicketModal();

  await safeAddBall({
    type: "WICKET",
    runs: 0,
    batter: names.batter,
    nonStriker: names.nonStriker,
    bowler: names.bowler,
    wicketKind: outType,
    outBatter,
    nextBatter: nextBatter || null,
    fielder: fielder || null
  });
});

// -----------------------------
// Buttons
// -----------------------------
$("btnStart")?.addEventListener("click", async ()=>{
  const st = CURRENT_DOC?.state || {};
  const hasToss = !!(st.toss || CURRENT_DOC?.tossWinner);
  const hasXI = !!(st.playingXI && st.playingXI[CURRENT_DOC.a]?.length===11 && st.playingXI[CURRENT_DOC.b]?.length===11);
  if(!hasToss) return alert("Pehele Toss set karo.");
  if(!hasXI) return alert("Pehele Playing XI (11-11) select karo.");
  await setMatchStatus(FB, matchId, "LIVE");
});

$("btnEnd")?.addEventListener("click", async ()=>{
  await setMatchStatus(FB, matchId, "COMPLETED");
  try{
    const awards = await finalizeMatchAndComputeAwards(FB, matchId);
    showAwardsPopup(awards);
  }catch(e){
    console.warn("Awards compute failed", e);
  }
});
$("btnReset")?.addEventListener("click", async ()=>{
  if(!confirm("Reset match? (All balls delete)")) return;
  await resetMatch(FB, matchId);
  alert("Reset done ✅");
});

$("undoBall")?.addEventListener("click", ()=>undoBall(FB, matchId));

document.querySelectorAll("[data-run]").forEach(btn=>{
  btn.addEventListener("click", async ()=>{
    const names = requireNames();
    if(!names) return;
    const runs = Number(btn.getAttribute("data-run")||0);
    await safeAddBall({ type:"RUN", runs, batter:names.batter, nonStriker:names.nonStriker, bowler:names.bowler });
  });
});

document.querySelectorAll("[data-extra]").forEach(btn=>{
  btn.addEventListener("click", async ()=>{
    const names = requireNames();
    if(!names) return;
    const x = btn.getAttribute("data-extra");
    if(x==="wd"){
      const total = Math.max(1, Number(prompt("Wide total runs? (min 1)", "1") || 1));
      await safeAddBall({ type:"WD", runs:total, batter:names.batter, nonStriker:names.nonStriker, bowler:names.bowler });
    }
    if(x==="nb"){
      const total = Math.max(1, Number(prompt("No-ball total runs? (min 1)\nExample: NB+4 = 5", "1") || 1));
      let batRuns = 0;
      if(total>1 && confirm("NB par bat se runs hue the? (OK=yes / Cancel=no)")){
        batRuns = Math.max(0, Math.min(total-1, Number(prompt("Bat runs on NB? (0-"+(total-1)+")", String(total-1)) || (total-1))));
      }
      await safeAddBall({ type:"NB", runs:total, batRuns, batter:names.batter, nonStriker:names.nonStriker, bowler:names.bowler });
    }
    if(x==="bye"){
      const r = Math.max(0, Number(prompt("Bye runs?", "1") || 1));
      await safeAddBall({ type:"BYE", runs:r, batter:names.batter, nonStriker:names.nonStriker, bowler:names.bowler });
    }
    if(x==="lb"){
      const r = Math.max(0, Number(prompt("Leg-bye runs?", "1") || 1));
      await safeAddBall({ type:"LB", runs:r, batter:names.batter, nonStriker:names.nonStriker, bowler:names.bowler });
    }
  });
});

document.querySelectorAll("[data-wicket]").forEach(btn=>{
  btn.addEventListener("click", ()=> openWicketModal(CURRENT_DOC));
});

// -----------------------------
// Auth
// -----------------------------
watchAuth(FB, (user)=>{
  if(!user){
    showState("Login required. Admin page se login karke aao.", false);
  }else{
    showState(`Logged in: ${user.email}`, true);
  }
});

// -----------------------------
// Render
// -----------------------------
function render(doc){
  CURRENT_DOC = doc;
  if(!doc){
    showState("Match not found.", false);
    return;
  }

  if(!TOURNAMENT){
    loadTournament(FB).then(t=>{
      TOURNAMENT = t;
      SQUADS = t?.squads || {};
    }).catch(()=>{});
  }

  $("sTitle").textContent = `Scorer • Match ${doc.matchId || matchId}`;
  $("sMeta").textContent = `${doc.a} vs ${doc.b} • Group ${doc.group||"-"} • Time ${doc.time||"-"} • Status ${doc.status||"UPCOMING"}`;

  // ✅ Auto completion popup (chase achieved / overs complete / tie)
  if(LAST_STATUS && LAST_STATUS !== "COMPLETED" && doc.status === "COMPLETED"){
    const key = `awardsShown:${matchId}:${doc.updatedAt?.seconds||""}`;
    if(!localStorage.getItem(key)){
      if(doc.awards) showAwardsPopup(doc.awards);
      localStorage.setItem(key, "1");
    }
  }
  LAST_STATUS = doc.status;

  mountTossCard();
  updateTossUI(doc);

  mountPlayingXICard();
  updateXIUI(doc);

  ensureDropdowns(doc);

  // Cricbuzz-style live chip for scorer
  renderScorerLiveChip(doc);

  const inn = currentInnings(doc);
  const of = inn?.onField;
  if(of){
    if(of.striker) $("batter").value = of.striker;
    if(of.nonStriker) $("nonStriker").value = of.nonStriker;

    if(of.needNewBowler){
      $("bowler").value = "";
      showState("Over complete. New bowler select karo.", false);
    }else if(of.bowler){
      $("bowler").value = of.bowler;
    }

    if(of.needNextBatter){
      showState("Wicket hua hai. Wicket button se next batsman select karo.", false);
    }
  }

  const preview = $("preview");
  if(preview){
    const st = doc.state || {};
    const summary = doc.summary || st.summary || {};
    preview.innerHTML =
      renderScoreLine({ matchId: doc.matchId, a: doc.a, b: doc.b, group: doc.group, time: doc.time, status: doc.status, summary }, st)
      + renderCommentary(st, 8);
  }
}

watchMatch(FB, matchId, render);
