import { initFirebase, firebaseReady, tournamentRef, matchRef, matchesCol } from "./firebase.js";
import { emptyInnings, applyBall } from "./scoring-core.js";

export function getFB(){
  return initFirebase();
}

/**
 * Admin Init: Tournament meta + matches ensure.
 * IMPORTANT: page-admin.js uses ensureTournamentDocs + auth exports for login.
 */
export async function ensureTournamentDocs(FB, tournament){
  const { _f } = FB;
  const tRef = tournamentRef(FB);
  const tSnap = await _f.getDoc(tRef);

  if(!tSnap.exists()){
    await _f.setDoc(tRef, {
      name: tournament.name,
      season: tournament.season,
      dates: tournament.dates,
      oversPerInnings: tournament.oversPerInnings,
      powerplayOvers: tournament.powerplayOvers,
      maxOversPerBowler: tournament.maxOversPerBowler,
      ball: tournament.ball,
      groups: tournament.groups || [],
      teams: tournament.teams || [],
      venues: tournament.venues || [],
      squads: tournament.squads || {},
      createdAt: _f.serverTimestamp(),
      updatedAt: _f.serverTimestamp()
    });
  } else {
    // Keep meta + squads in sync
    await _f.updateDoc(tRef, {
      updatedAt: _f.serverTimestamp(),
      groups: tournament.groups || [],
      teams: tournament.teams || [],
      venues: tournament.venues || [],
      squads: tournament.squads || {}
    });
  }

  // Ensure match docs exist
  for(const m of (tournament.matches || [])){
    const mRef = matchRef(FB, m.matchId);
    const mSnap = await _f.getDoc(mRef);
    if(!mSnap.exists()){
      const state = newMatchState(tournament, m);
      await _f.setDoc(mRef, {
        ...m,
        status: "UPCOMING",
        state,
        summary: state.summary,
        updatedAt: _f.serverTimestamp(),
        createdAt: _f.serverTimestamp()
      });
    }
  }
}

/**
 * Match State (extended): toss + playingXI + balls + innings
 */
export function newMatchState(tournament, m){
  const oversPerInnings = tournament.oversPerInnings || 10;
  const powerplayOvers = Number(tournament.powerplayOvers ?? 3);
  const maxOversPerBowler = Number(tournament.maxOversPerBowler ?? 2);

  const st = {
    matchId: m.matchId,
    oversPerInnings,
    powerplayOvers,
    maxOversPerBowler,
    status: "UPCOMING",
    inningsIndex: 0,

    // innings format compatible with renderers
    innings: [
      emptyInnings(m.a, m.b),
      emptyInnings(m.b, m.a)
    ],

    // ball-by-ball
    balls: [],

    // Phase-2
    playingXI: {}, // { "TeamName":[11 players], ... }

    // Phase-1/2
    toss: null
  };

  st.summary = {
    status:"UPCOMING",
    inningsIndex:0,
    scoreText:"0/0",
    oversText:`0.0/${oversPerInnings}`,
    rr:0,
    powerplayOvers,
    batting:m.a,
    bowling:m.b
  };

  return st;
}

export async function setMatchStatus(FB, matchId, status){
  const { _f } = FB;
  const mRef = matchRef(FB, matchId);
  const snap = await _f.getDoc(mRef);
  if(!snap.exists()) throw new Error("Match doc not found. Initialize first.");

  const docData = snap.data();
  const state = docData.state;
  state.status = status;
  state.summary.status = status;

  // Auto awards on match completion
  let awards = docData.awards || null;
  if(status === "COMPLETED"){
    awards = computeAwardsFromState(state);
  }

  await _f.updateDoc(mRef, {
    status,
    state,
    summary: state.summary,
    ...(awards ? { awards } : {}),
    updatedAt: _f.serverTimestamp()
  });
}

// Reset a match back to UPCOMING with a fresh empty state (clears balls + innings)
export async function resetMatch(FB, matchId){
  const { _f } = FB;
  const mRef = matchRef(FB, matchId);
  const snap = await _f.getDoc(mRef);
  if(!snap.exists()) throw new Error("Match doc not found. Initialize first.");

  const m = snap.data();
  const tSnap = await _f.getDoc(tournamentRef(FB));
  const tMeta = tSnap.exists() ? (tSnap.data()||{}) : {};

  const tournament = {
    oversPerInnings: tMeta.oversPerInnings || 10,
    powerplayOvers: tMeta.powerplayOvers ?? 3,
    maxOversPerBowler: tMeta.maxOversPerBowler ?? 2
  };
  const fresh = newMatchState(tournament, { matchId, a: m.a, b: m.b });

  await _f.updateDoc(mRef, {
    status: "UPCOMING",
    state: fresh,
    summary: fresh.summary,
    updatedAt: _f.serverTimestamp()
  });
}

/**
 * Toss: winner + decision, then bind innings batting/bowling.
 */
export async function setToss(FB, matchId, winner, decision){
  const { _f } = FB;
  const mRef = matchRef(FB, matchId);
  const snap = await _f.getDoc(mRef);
  if(!snap.exists()) throw new Error("Match doc not found. Initialize first.");

  const docData = snap.data();
  const a = docData.a, b = docData.b;

  if(!winner || (winner!==a && winner!==b)) throw new Error("Invalid toss winner");
  decision = (decision||"BAT").toUpperCase();
  if(decision!=="BAT" && decision!=="BOWL") decision="BAT";

  const other = (winner===a) ? b : a;
  const battingFirst = (decision==="BAT") ? winner : other;
  const bowlingFirst = (decision==="BAT") ? other : winner;

  const state = docData.state || newMatchState({ oversPerInnings: 10 }, { matchId, a, b });
  state.toss = { winner, decision, at: Date.now() };

  // innings bindings
  state.innings = state.innings || [ emptyInnings(a,b), emptyInnings(b,a) ];
  state.innings[0] = state.innings[0] || emptyInnings(battingFirst, bowlingFirst);
  state.innings[1] = state.innings[1] || emptyInnings(bowlingFirst, battingFirst);

  state.innings[0].batting = battingFirst;
  state.innings[0].bowling = bowlingFirst;
  state.innings[1].batting = bowlingFirst;
  state.innings[1].bowling = battingFirst;

  state.status = "UPCOMING";
  state.inningsIndex = 0;

  state.summary = state.summary || {};
  state.summary.status = "UPCOMING";
  state.summary.inningsIndex = 0;
  state.summary.batting = battingFirst;
  state.summary.bowling = bowlingFirst;

  await _f.updateDoc(mRef, {
    tossWinner: winner,
    tossDecision: decision,
    battingFirst,
    bowlingFirst,
    status: "UPCOMING",
    state,
    summary: state.summary,
    updatedAt: _f.serverTimestamp()
  });
}

/**
 * Phase-2: Save Playing XI (11 each)
 */
export async function setPlayingXI(FB, matchId, teamA_XI, teamB_XI){
  const { _f } = FB;
  const mRef = matchRef(FB, matchId);
  const snap = await _f.getDoc(mRef);
  if(!snap.exists()) throw new Error("Match doc not found. Initialize first.");

  const m = snap.data();
  const a = m.a, b = m.b;

  const xiA = Array.isArray(teamA_XI) ? teamA_XI.filter(Boolean) : [];
  const xiB = Array.isArray(teamB_XI) ? teamB_XI.filter(Boolean) : [];

  if(xiA.length !== 11) throw new Error(`${a} ke liye exact 11 players select karo`);
  if(xiB.length !== 11) throw new Error(`${b} ke liye exact 11 players select karo`);

  const state = m.state || newMatchState({ oversPerInnings: (m.state?.oversPerInnings||10) }, { matchId, a, b });
  state.playingXI = state.playingXI || {};
  state.playingXI[a] = xiA;
  state.playingXI[b] = xiB;

  await _f.updateDoc(mRef, { state, updatedAt: _f.serverTimestamp() });
}

export async function addBall(FB, matchId, ball){
  const { _f } = FB;
  const mRef = matchRef(FB, matchId);
  const snap = await _f.getDoc(mRef);
  if(!snap.exists()) throw new Error("Match doc not found. Initialize first.");

  const docData = snap.data();
  const state = docData.state;
  if(!state) throw new Error("State missing. Reset match first.");

  // ✅ Enforce match setup before scoring
  // If someone mistakenly logs a ball early, the match flips to LIVE and the UI setup cards can hide.
  // We block scoring until Toss + Playing XI are saved.
  const hasToss = !!(state.toss || docData.tossWinner);
  const a = docData.a, b = docData.b;
  const hasXI = !!(state.playingXI && state.playingXI[a]?.length === 11 && state.playingXI[b]?.length === 11);
  if(!hasToss) throw new Error("Toss pending. Pehele Toss save karo.");
  if(!hasXI) throw new Error("Playing XI pending. Dono teams ke 11-11 players select karo.");

  // ✅ Enforce max overs per bowler (default 2 overs = 12 legal balls)
  const maxOversPerBowler = Number(state.maxOversPerBowler ?? 2);
  const maxBowlerBalls = Math.max(0, maxOversPerBowler * 6);
  const idx = Number(state.inningsIndex||0);
  const inn = state.innings?.[idx];
  const bowlerName = (ball.bowler || inn?.onField?.bowler || "").toString().trim();
  const type = (ball.type || "RUN").toString().toUpperCase();
  const legal = (type !== "WD" && type !== "NB");
  if(legal && maxBowlerBalls>0 && bowlerName){
    const oBalls = Number(inn?.bowlers?.[bowlerName]?.oBalls || 0);
    if(oBalls >= maxBowlerBalls){
      throw new Error(`${bowlerName} max ${maxOversPerBowler} overs already. New bowler select karo.`);
    }
  }

  if(state.status!=="LIVE"){
    state.status="LIVE";
    docData.status="LIVE";
  }

  ball.seq = (state.balls?.length||0)+1;
  ball.at = Date.now();
  state.balls = state.balls || [];
  state.balls.push(ball);

  applyBall(state, ball);

  await _f.updateDoc(mRef, {
    status: state.status,
    state,
    summary: state.summary,
    updatedAt: _f.serverTimestamp()
  });
}

// -----------------------------
// Awards (MoM / Sixer King / Best Bowler)
// -----------------------------
function computeAwardsFromState(st){
  const innings = Array.isArray(st?.innings) ? st.innings : [];
  const playerMap = new Map(); // name -> {name, team, bat, bowl, field}

  const upsert = (name, team)=>{
    if(!name) return null;
    const key = name.toString();
    if(!playerMap.has(key)){
      playerMap.set(key, {
        name:key,
        team: team || "",
        bat:{r:0,b:0,f4:0,f6:0,outs:0},
        bowl:{balls:0,r:0,w:0,wd:0,nb:0},
        field:{catches:0,runouts:0,stumpings:0}
      });
    }
    const p = playerMap.get(key);
    if(team && !p.team) p.team = team;
    return p;
  };

  for(const inn of innings){
    const batTeam = inn?.batting || "";
    const bowlTeam = inn?.bowling || "";
    const batters = inn?.batters || {};
    const bowlers = inn?.bowlers || {};
    const fielding = inn?.fielding || {};

    for(const [n, b] of Object.entries(batters)){
      const p = upsert(n, batTeam);
      if(!p) continue;
      p.bat.r += Number(b?.r||0);
      p.bat.b += Number(b?.b||0);
      p.bat.f4 += Number(b?.f4||0);
      p.bat.f6 += Number(b?.f6||0);
      p.bat.outs += (b?.out ? 1 : 0);
    }
    for(const [n, b] of Object.entries(bowlers)){
      const p = upsert(n, bowlTeam);
      if(!p) continue;
      p.bowl.balls += Number(b?.oBalls||0);
      p.bowl.r += Number(b?.r||0);
      p.bowl.w += Number(b?.w||0);
      p.bowl.wd += Number(b?.wd||0);
      p.bowl.nb += Number(b?.nb||0);
    }
    for(const [n, f] of Object.entries(fielding)){
      const p = upsert(n, bowlTeam);
      if(!p) continue;
      p.field.catches += Number(f?.catches||0);
      p.field.runouts += Number(f?.runouts||0);
      p.field.stumpings += Number(f?.stumpings||0);
    }
  }

  const players = Array.from(playerMap.values());

  // Sixer King
  let sixerKing = null;
  for(const p of players){
    if(!sixerKing || p.bat.f6 > sixerKing.sixes){
      sixerKing = { name:p.name, team:p.team, sixes:p.bat.f6 };
    }
  }

  // Best Bowler: max wickets, then lower runs, then lower econ
  let bestBowler = null;
  for(const p of players){
    const w = p.bowl.w;
    if(w<=0) continue;
    const balls = p.bowl.balls;
    const overs = balls>0 ? (balls/6) : 0;
    const econ = overs>0 ? (p.bowl.r/overs) : 999;
    const cand = { name:p.name, team:p.team, wickets:w, runs:p.bowl.r, balls, econ: Math.round(econ*100)/100 };
    if(!bestBowler) bestBowler = cand;
    else {
      if(cand.wickets > bestBowler.wickets) bestBowler = cand;
      else if(cand.wickets === bestBowler.wickets){
        if(cand.runs < bestBowler.runs) bestBowler = cand;
        else if(cand.runs === bestBowler.runs && cand.econ < bestBowler.econ) bestBowler = cand;
      }
    }
  }

  // Man of the Match: simple weighted score
  let mom = null;
  for(const p of players){
    const batting = p.bat.r + (p.bat.f4*1) + (p.bat.f6*2);
    const bowling = (p.bowl.w*25) + (p.bowl.balls>0 ? Math.max(0, 20 - (p.bowl.r/Math.max(1,p.bowl.balls/6))*2) : 0);
    const field = (p.field.catches*10) + (p.field.runouts*12) + (p.field.stumpings*12);
    const score = Math.round((batting + bowling + field)*100)/100;
    const cand = { name:p.name, team:p.team, score };
    if(!mom || cand.score > mom.score) mom = cand;
  }

  return {
    mom,
    sixerKing,
    bestBowler,
    computedAt: Date.now()
  };
}

export async function finalizeMatchAndComputeAwards(FB, matchId){
  const { _f } = FB;
  const mRef = matchRef(FB, matchId);
  const snap = await _f.getDoc(mRef);
  if(!snap.exists()) throw new Error("Match doc not found.");
  const docData = snap.data();
  const st = docData.state;
  if(!st) throw new Error("State missing.");
  const awards = computeAwardsFromState(st);
  await _f.updateDoc(mRef, { awards, updatedAt: _f.serverTimestamp() });
  return awards;
}

export async function undoBall(FB, matchId){
  const { _f } = FB;
  const mRef = matchRef(FB, matchId);
  const snap = await _f.getDoc(mRef);
  if(!snap.exists()) throw new Error("Match doc not found.");

  const docData = snap.data();
  const state = docData.state;
  if(!state?.balls || state.balls.length===0) return;

  // Keep toss + XI
  const toss = state.toss || null;
  const playingXI = state.playingXI || {};

  // Build fresh
  const tournamentSnap = await _f.getDoc(tournamentRef(FB));
  const tMeta = tournamentSnap.exists() ? (tournamentSnap.data()||{}) : {};
  const oversPerInnings = tMeta.oversPerInnings || 10;
  const powerplayOvers = tMeta.powerplayOvers ?? 3;
  const maxOversPerBowler = tMeta.maxOversPerBowler ?? 2;

  const fresh = newMatchState({ oversPerInnings, powerplayOvers, maxOversPerBowler }, { a: docData.a, b: docData.b, matchId });
  fresh.toss = toss;
  fresh.playingXI = playingXI;

  // replay except last
  const balls = state.balls.slice(0, -1);
  for(const b of balls){
    fresh.balls.push(b);
    applyBall(fresh, b);
  }

  await _f.updateDoc(mRef, { status: fresh.status, state: fresh, summary: fresh.summary, updatedAt: _f.serverTimestamp() });
}

export function watchAllMatches(FB, cb){
  const { _f } = FB;
  const q = _f.query(matchesCol(FB), _f.orderBy("matchId","asc"));
  return _f.onSnapshot(q, (snap)=>{
    const arr = [];
    snap.forEach(d=>arr.push({id:d.id, ...d.data()}));
    cb(arr);
  });
}

export function watchMatch(FB, matchId, cb){
  const { _f } = FB;
  return _f.onSnapshot(matchRef(FB, matchId), (snap)=>{
    cb(snap.exists()? {id:snap.id, ...snap.data()} : null);
  });
}

/** ✅ AUTH EXPORTS (Login fix) */
export async function signIn(FB, email, pass){
  const { _f, auth } = FB;
  return await _f.signInWithEmailAndPassword(auth, email, pass);
}
export async function signOutUser(FB){
  const { _f, auth } = FB;
  return await _f.signOut(auth);
}
export function watchAuth(FB, cb){
  const { _f, auth } = FB;
  return _f.onAuthStateChanged(auth, cb);
}
