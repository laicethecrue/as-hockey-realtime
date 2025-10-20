/******************************************************
 * AS – Hockey Game v3.0 (classement en temps réel)
 * - Realtime Database (Firebase) pour scores partagés
 * - Fallback local si offline
 * - Catégories: Vision / Drills / Stratégie / Fondamentaux / NHL / Mental / Tout
 ******************************************************/

// ---------- Firebase (CDN ES Modules) ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, onValue, get, child } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ⚠️ REMPLACE ICI par ta vraie config (Console Firebase > Project settings > SDK setup)
const firebaseConfig = /* FIREBASE_CONFIG_HERE */ {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  databaseURL: "https://REPLACE_ME-default-rtdb.firebaseio.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME"
};

let app, db;
try {
  app = initializeApp(firebaseConfig);
  db  = getDatabase(app);
  console.log("Firebase OK");
} catch (e) {
  console.warn("Firebase non initialisé (mode local)", e);
  db = null;
}

// ---------- État ----------
const state = {
  page: "home",
  player: null,
  level: "normal",
  points: 0,
  tick: null,
  quiz: { cat:"all", items:[], timers:{}, answered:{} },
  cards: { memory:{deck:[],flipped:[],found:{},moves:0,time:60,tick:null} },
  onlineScores: [] // classement partagé (realtime)
};

// ---------- Données ----------
const DB = {
  roster: [],
  qdata: { questions:{} },
  cards: { memory_pairs:[] }
};

// ---------- Niveaux / points ----------
const LEVELS = {
  facile: { timePerQ:10, speedWindow:3, speedBonus:2, multiplier:0.8 },
  normal: { timePerQ:7,  speedWindow:2, speedBonus:3, multiplier:1.0 },
  pro:    { timePerQ:5,  speedWindow:2, speedBonus:5, multiplier:1.2 }
};
function rewardBadge(p){ return p>=300?"🏆 Or":p>=150?"🥈 Argent":"🥉 Bronze"; }
function pointValue(q){ const base = Number.isFinite(q.p)?q.p:10; return Math.round(base*(LEVELS[state.level].multiplier||1)); }

// ---------- LocalStorage (fallback) ----------
const LS_PLAYER="as_v3_player";
function initials(name){
  if(!name) return "AS";
  const parts=name.trim().split(/\s+/);
  const i1=(parts[0]||"").charAt(0);
  const i2=(parts.length>1?parts[parts.length-1].charAt(0):"");
  return (i1+i2).toUpperCase() || "AS";
}
function saveScoreLocal(playerId, delta){
  const key="as_v3_scores";
  const s = JSON.parse(localStorage.getItem(key)||"{}");
  s[playerId]=(s[playerId]||0)+delta;
  localStorage.setItem(key, JSON.stringify(s));
}
function getScoreLocal(playerId){
  const s = JSON.parse(localStorage.getItem("as_v3_scores")||"{}");
  return s[playerId]||0;
}

// ---------- Online: Firebase helpers ----------
async function pushScoreOnline(player){
  if(!db || !player) return;
  const total = getScoreLocal(player.id); // total local (session cumulée) comme fallback
  const data = { name: player.name, points: total, updatedAt: Date.now() };
  try{
    await set(ref(db, "scores/"+player.id), data);
  }catch(e){ console.warn("save online fail:", e); }
}
function subscribeLeaderboard(){
  if(!db) return;
  const r = ref(db, "scores");
  onValue(r, (snap)=>{
    const v = snap.val() || {};
    const arr = Object.keys(v).map(k=>({ id:k, ...v[k] }));
    arr.sort((a,b)=> b.points-a.points || a.name.localeCompare(b.name,"fr",{sensitivity:"base"}));
    state.onlineScores = arr;
    if(state.page==="home") render();
  });
}

// ---------- Chargement ----------
async function loadAll(){
  // data.json
  try{
    const r = await fetch("./data.json?v=300"); DB.qdata = await r.json();
  }catch(e){ console.error("data.json", e); }

  // cards.json
  try{
    const r = await fetch("./cards.json?v=300"); const c = await r.json();
    DB.cards.memory_pairs = c.memory_pairs||[];
    DB.roster = (c.roster||[]).slice().sort((a,b)=>
      (a.name||"").localeCompare(b.name||"","fr",{sensitivity:"base"})
    );
  }catch(e){ console.error("cards.json", e); }

  // restore player
  const pid = localStorage.getItem(LS_PLAYER)||"";
  if(pid){ const p=DB.roster.find(x=>x.id===pid); if(p) state.player=p; }

  // online leaderboard
  subscribeLeaderboard();

  render();
}

// ---------- Utils UI ----------
function go(p){ state.page=p; render(); }
function setLevel(l){ state.level=l; render(); }
function selectPlayer(id){
  const p = DB.roster.find(x=>x.id===id); if(!p) return;
  state.player=p; localStorage.setItem(LS_PLAYER,p.id);
  state.points=0; state.quiz.answered={};
  render();
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function catLabel(cat){
  return cat==="vision"?"Vision":
         cat==="drills"?"Drills":
         cat==="strategie"?"Stratégie":
         cat==="fondamentaux"?"Fondamentaux":
         cat==="nhl"?"NHL":
         cat==="mental"?"Mental":"Toutes";
}
function poolByCategory(cat){
  const Q=DB.qdata.questions||{};
  if(cat==="vision") return Q.vision||[];
  if(cat==="drills") return Q.drills||Q.drills_qcm||[];
  if(cat==="strategie") return Q.strategie||Q.strategie_qcm||[];
  if(cat==="fondamentaux") return Q.fondamentaux||[];
  if(cat==="nhl") return Q.nhl||[];
  if(cat==="mental") return Q.mental||[];
  let all=[]; for(const k of ["vision","drills","strategie","fondamentaux","nhl","mental"]){
    if(Q[k]) all=all.concat(Q[k]); if(Q[k+"_qcm"]) all=all.concat(Q[k+"_qcm"]);
  } return all;
}

// ---------- Quiz ----------
function startQuiz(cat="all"){
  state.quiz.cat=cat;
  state.quiz.items = shuffle(poolByCategory(cat).map(q=>({...q})));
  state.quiz.answered={};
  state.quiz.timers={};
  state.quiz.items.forEach((_,i)=> state.quiz.timers[i]=LEVELS[state.level].timePerQ);

  clearInterval(state.tick);
  state.tick=setInterval(()=>{
    let any=false;
    for(const k in state.quiz.timers){
      if(state.quiz.timers[k]>0){ state.quiz.timers[k]--; any=true; }
      const el=document.getElementById(`qt-${k}`); if(el) el.textContent=(state.quiz.timers[k]||0)+"s";
    }
    if(!any) clearInterval(state.tick);
  },1000);

  go("quiz");
}
function ensureRec(q){ const key=q.q; if(!state.quiz.answered[key]) state.quiz.answered[key]={correct:false,tries:[],showExp:false}; return state.quiz.answered[key]; }
function pointEarned(q, firstTry, tleft){
  let pts = pointValue(q); const L=LEVELS[state.level];
  if(firstTry && tleft >= (L.timePerQ - L.speedWindow)) pts += L.speedBonus;
  return pts;
}
async function answer(q, qi, j){
  const rec=ensureRec(q); const tleft=state.quiz.timers[qi]||0; const firstTry=rec.tries.length===0;
  if(j===q.a){
    if(!rec.correct){
      rec.correct=true; rec.showExp=true;
      const pts = pointEarned(q, firstTry, tleft);
      state.points += pts;
      if(state.player){
        saveScoreLocal(state.player.id, pts);
        // push online (non bloquant)
        pushScoreOnline(state.player);
      }
      alert(`✅ +${pts} pts`);
    }else{
      rec.showExp=true; alert("⭐ Déjà validée");
    }
  } else {
    if(!rec.tries.includes(j)) rec.tries.push(j);
    alert("❌ Essaie encore");
  }
  render();
}

// ---------- Mémoire ----------
function memStart(){
  const base = shuffle(DB.cards.memory_pairs.slice()).slice(0,6);
  let deck=[]; base.forEach(b=>{ deck.push({k:b.id+"A",id:b.id,label:b.label,emoji:b.emoji}); deck.push({k:b.id+"B",id:b.id,label:b.label,emoji:b.emoji}); });
  Object.assign(state.cards.memory,{deck:shuffle(deck),flipped:[],found:{},moves:0,time:60});
  clearInterval(state.cards.memory.tick);
  state.cards.memory.tick=setInterval(()=>{
    const M=state.cards.memory; M.time=Math.max(0,M.time-1);
    const el=document.getElementById("mem-timer"); if(el) el.textContent=M.time+"s";
    if(M.time===0) clearInterval(M.tick);
  },1000);
  go("cardsMemory");
}
function memFlip(i){
  const M=state.cards.memory,D=M.deck;
  if(M.found[i]||M.flipped.includes(i)||M.flipped.length===2) return;
  M.flipped.push(i); render();
  if(M.flipped.length===2){
    M.moves++; const [i1,i2]=M.flipped,c1=D[i1],c2=D[i2];
    setTimeout(()=>{
      if(c1.id===c2.id){ M.found[i1]=true; M.found[i2]=true; }
      M.flipped=[]; render();
      const done = Object.keys(M.found).length===D.length;
      if(done){
        clearInterval(M.tick);
        const bonus=Math.max(0,M.time);
        const pts=10+bonus; state.points+=pts;
        if(state.player){ saveScoreLocal(state.player.id, pts); pushScoreOnline(state.player); }
        alert(`🏁 Mémoire OK • Coups:${M.moves} • Bonus:${bonus} • +${pts} pts`);
        go("home");
      }
    },450);
  }
}

// ---------- Vues ----------
const V={};
function getAvatarHTML(p){
  if(!p) return `<div class="rank-avatar">AS</div>`;
  const num = p.number ? `<span class="badge-num">#${p.number}</span>` : "";
  if(p.avatar && /^https?:\/\//.test(p.avatar)) return `<div class="rank-avatar"><img src="${p.avatar}" alt="${p.name}"/>${num}</div>`;
  return `<div class="rank-avatar">${initials(p.name)}${num}</div>`;
}
function header(){
  const name = state.player?state.player.name:"—";
  const lvl = state.level.charAt(0).toUpperCase()+state.level.slice(1);
  const medal = rewardBadge(state.points);
  return `<div class="card" style="text-align:left;">
    <div><b>Joueur :</b> ${name}</div>
    <div><b>Niveau :</b> ${lvl}</div>
    <div><b>Points (session) :</b> ${state.points} • ${medal}</div>
  </div>`;
}
function leaderboardHTML(){
  const arr = state.onlineScores && state.onlineScores.length ? state.onlineScores : (DB.roster||[]).map(p=>({id:p.id,name:p.name,points:getScoreLocal(p.id)})).sort((a,b)=>b.points-a.points);
  const podium = arr.slice(0,3);
  const medals=["🥇","🥈","🥉"], classes=["g1","g2","g3"];
  const pod = podium.length?`
    <div class="podium">
      ${podium.map((r,i)=> {
        const p = (DB.roster||[]).find(x=>x.id===r.id);
        return `<div class="p ${classes[i]}">
          <div class="avatar">${p ? (p.avatar?`<img src="${p.avatar}" alt="${p.name}">`: initials(p.name)) : "AS"}</div>
          <h4>${medals[i]} ${r.name}</h4>
          <div class="pts"><b>${r.points}</b> pts</div>
          <small>${i===0?"Leader":"Top "+(i+1)}</small>
        </div>`;
      }).join("")}
    </div>` : "<p>Aucun score encore.</p>";

  const rows = arr.map((r,ix)=>{
    const p = (DB.roster||[]).find(x=>x.id===r.id);
    return `<tr>
      <td>${ix+1}</td>
      <td><div class="rank-row">${getAvatarHTML(p)} <span class="rank-name">${r.name}</span></div></td>
      <td>${r.points||0}</td>
    </tr>`;
  }).join("");

  return pod + `<table class="table"><thead><tr><th>#</th><th>Joueur</th><th>Points</th></tr></thead><tbody>${rows}</tbody></table>`;
}
V.home = ()=>{
  const rosterOpts=(DB.roster||[]).map(p=>`<option value="${p.id}" ${state.player&&p.id===state.player.id?"selected":""}>${p.name}</option>`).join("");
  return `
    <h2>Menu principal</h2>
    ${header()}

    <div class="card">
      <div class="badge">Sélection du joueur</div>
      <select id="selPlayer">${rosterOpts}</select>
      <div class="row">
        <button data-act="setPlayer">✅ Choisir</button>
        <button class="small" data-act="lvl" data-l="facile">Facile</button>
        <button class="small" data-act="lvl" data-l="normal">Normal</button>
        <button class="small" data-act="lvl" data-l="pro">Pro</button>
      </div>
    </div>

    <div class="card">
      <div class="badge">Quiz par catégorie</div>
      <div class="row">
        <button data-act="start" data-cat="vision">👀 Vision</button>
        <button data-act="start" data-cat="drills">⚙️ Drills</button>
        <button data-act="start" data-cat="strategie">📘 Stratégie</button>
      </div>
      <div class="row">
        <button data-act="start" data-cat="fondamentaux">🎯 Fondamentaux</button>
        <button data-act="start" data-cat="nhl">🏒 NHL</button>
        <button data-act="start" data-cat="mental">🧠 Mental</button>
      </div>
      <button class="small" data-act="start" data-cat="all">🔀 Tout mélangé</button>
    </div>

    <div class="card">
      <div class="badge">Cartes</div>
      <button data-act="memStart">🧠 Mémoire</button>
    </div>

    <div class="card">
      <div class="badge">Classement (partagé)</div>
      ${leaderboardHTML()}
    </div>
  `;
};
V.quiz = ()=>{
  const items=state.quiz.items;
  if(!items.length) return header()+`<p>Aucune question dans cette catégorie.</p><button data-act="home">⬅ Retour</button>`;
  let h=header()+`<h2>🧩 ${catLabel(state.quiz.cat)} — ${items.length} questions</h2>`;
  items.forEach((q,i)=>{
    const rec = state.quiz.answered[q.q]||{correct:false,tries:[],showExp:false};
    const good = rec.correct ? q.a : null;
    h+=`
      <div class="card">
        <div class="badge">Q${i+1} • ${pointValue(q)} pts <span style="float:right">⏱ <b id="qt-${i}">${state.quiz.timers[i]||0}s</b></span></div>
        <p><b>${q.q}</b></p>
        ${(q.c||[]).map((c,j)=>{
          const tried=rec.tries.includes(j);
          const cls=(good===j)?"correct":(tried?"wrong":"");
          return `<button class="${cls}" data-act="ans" data-i="${i}" data-j="${j}">${c}</button>`;
        }).join("")}
        ${rec.correct && q.exp? `<div class="card" style="margin-top:8px;background:#0b1628;border:1px solid #29406f"><b>Pourquoi :</b> ${q.exp}</div>`:""}
      </div>`;
  });
  return h+`<button data-act="home">⬅ Retour</button>`;
};
V.cardsMemory = ()=>{
  const M=state.cards.memory;
  const grid=M.deck.map((c,idx)=>{
    const face=M.found[idx]||M.flipped.includes(idx);
    return `<div class="mem-card ${M.found[idx]?"found":""}">
      <button data-act="memFlip" data-i="${idx}">${face?(c.emoji?`${c.emoji}<br>${c.label}`:c.label):"🃏"}</button>
    </div>`;
  }).join("");
  return `${header()}
    <h2>🧠 Mémoire</h2>
    <div class="card"><b>Temps :</b> <span id="mem-timer">${M.time}s</span> • <b>Coups :</b> ${M.moves}</div>
    <div class="grid">${grid}</div>
    <button data-act="home">⬅ Retour</button>`;
};

// ---------- Render & Actions ----------
function render(){ const root=document.getElementById("app"); root.innerHTML= V[state.page]?V[state.page](): "<p>Chargement…</p>"; }
document.addEventListener("click",(e)=>{
  const b=e.target.closest("button"); if(!b) return;
  const act=b.getAttribute("data-act");
  if(act==="home"){ go("home"); return; }
  if(act==="setPlayer"){ const id=document.getElementById("selPlayer").value; selectPlayer(id); return; }
  if(act==="lvl"){ setLevel(b.getAttribute("data-l")); return; }
  if(act==="start"){ startQuiz(b.getAttribute("data-cat")); return; }
  if(act==="ans"){ const i=+b.getAttribute("data-i"), j=+b.getAttribute("data-j"); answer(state.quiz.items[i], i, j); return; }
  if(act==="memStart"){ memStart(); return; }
  if(act==="memFlip"){ const i=+b.getAttribute("data-i"); memFlip(i); return; }
});

// ---------- Init ----------
loadAll();
