import { setActiveNav, qs, esc } from "./util.js";
import { getFB, watchMatch } from "./store-fb.js";
import { renderScoreLine, renderCommentary } from "./renderers.js";

setActiveNav("home");
const FB = getFB();
const matchId = qs().get("match") || "A1";

document.getElementById("btnScorecard").href = `scorecard.html?match=${encodeURIComponent(matchId)}`;

if(!FB){
  document.getElementById("mTitle").textContent = "Firebase not configured";
} else {
  watchMatch(FB, matchId, (doc)=>{
    if(!doc){
      document.getElementById("mTitle").textContent = "Match not found";
      return;
    }
    document.getElementById("mTitle").textContent = `${doc.a} vs ${doc.b}`;
    document.getElementById("mMeta").textContent = `Match ${doc.matchId} • Group ${doc.group} • ${doc.time} • Status: ${doc.status}`;
    document.getElementById("liveTop").innerHTML = renderScoreLine(doc);
    document.getElementById("commentary").innerHTML = renderCommentary(doc);
  });
}
