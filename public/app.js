const $ = (id) => document.getElementById(id);
const fields = ["threshold", "superLikeEnabled", "superLikeThreshold", "intellectualEnabled", "prior", "batchMinMinutes", "batchMaxMinutes", "continuous", "breakMinMinutes", "breakMaxMinutes", "activeStartHour", "activeEndHour", "maxSwipesPerSession", "minDelayMs", "maxDelayMs", "humanize", "quickPassBelow", "maxPhotos", "model", "effort", "browserChannel", "headless", "captureReasoning", "userGuidance"];
const boolFields = new Set(["humanize", "continuous", "headless", "superLikeEnabled", "captureReasoning", "intellectualEnabled"]);
let settings = {};
let state = { status: "idle", awaiting: null, swiping: false };
const decisionsById = new Map();
const cardEls = new Map();
const noteDrafts = new Map(); // unsaved note text by decision id, survives card rebuilds
const reviewCards = new Map(); // decision id -> { el, ref } in the Review tab
const isEditing = (el) => el && el.contains(document.activeElement) && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName);
let currentDecisionId = null;

function fmtP(p) { return (p * 100).toFixed(0) + "%"; }

// Keep whatever card is at the top of the viewport in place while the DOM above it changes,
// so a new entry arriving doesn't shove the one you're reading down the page.
function keepScroll(update) {
  const cards = document.querySelectorAll(".tabpane:not([hidden]) .card");
  let anchor = null, top = 0;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (r.bottom > 0) { anchor = c; top = r.top; break; }
  }
  update();
  if (anchor && anchor.isConnected && window.scrollY > 0) {
    const delta = anchor.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }
}
const modelNames = { "claude-opus-5": "Claude Opus 5", "claude-sonnet-5": "Claude Sonnet 5", "claude-haiku-4-5": "Claude Haiku 4.5", "claude-opus-4-8": "Claude Opus 4.8", "claude-fable-5-1": "Claude Fable 5.1" };
const hasEffort = (model) => !/haiku/i.test(model || "");
function modelLabel(d) {
  if (!d.model) return "model not recorded";
  const effort = hasEffort(d.model) && d.effort ? ` (${d.effort} effort)` : "";
  return `${modelNames[d.model] ?? d.model}${effort}`;
}
// Likelihood ratio as a whole-number ratio: 12 -> "12:1", 1.5 -> "3:2", 0.7 -> "7:10", 1 -> "1:1".
// Picks the closest fraction with both sides at most 20.
function fmtRatio(lr) {
  if (!(lr > 0)) return "1:1";
  let best = [1, 1], bestErr = Infinity;
  for (let den = 1; den <= 20; den++) {
    const num = Math.max(1, Math.round(lr * den));
    if (num > 20 && den > 1) continue;
    const err = Math.abs(num / den - lr) / lr;
    if (err < bestErr - 1e-9) { bestErr = err; best = [num, den]; }
    if (err < 0.02) break; // close enough; prefer the simplest fraction
  }
  return `${best[0]}:${best[1]}`;
}

// ---------- settings ----------
function renderSettingsDerived() {
  $("thresholdVal").textContent = fmtP(parseFloat($("threshold").value));
  const prior = parseFloat($("prior").value);
  $("priorVal").textContent = fmtP(prior);
  $("lrNeeded").textContent = ((1 - prior) / prior).toFixed(1);
  const effortOk = hasEffort($("model").value);
  $("effort").disabled = !effortOk;
  $("effortHint").textContent = effortOk ? "" : "Haiku 4.5 has no effort control.";
  $("superLikeVal").textContent = fmtP(parseFloat($("superLikeThreshold").value));
  $("superLikeRow").hidden = $("superLikeEnabled").value !== "true";
  $("quickPassVal").textContent = fmtP(parseFloat($("quickPassBelow").value));
  $("continuousOpts").hidden = $("continuous").value !== "true";
}
function fillSettings(s) {
  settings = s;
  for (const f of fields) $(f).value = String(s[f]);
  renderSettingsDerived();
}
async function saveSettings() {
  const patch = {};
  for (const f of fields) {
    const el = $(f);
    if (boolFields.has(f)) patch[f] = el.value === "true";
    else patch[f] = el.type === "number" || el.type === "range" ? parseFloat(el.value) : el.value;
  }
  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const body = await res.json();
  if (res.ok) { fillSettings(body); $("saveMsg").textContent = "Saved."; }
  else $("saveMsg").textContent = "Error: " + body.error;
  setTimeout(() => ($("saveMsg").textContent = ""), 2500);
}

// ---------- state / log / stats ----------
function setState(s) {
  state = s;
  $("statusText").textContent = s.status.replace("_", " ") + (s.current?.name ? ` · ${s.current.name}` : "");
  $("statusDot").className = "dot " + s.status;
  $("sSession").textContent = s.swipesThisSession;
  const busy = ["launching", "awaiting_login", "running", "stopping"].includes(s.status);
  $("startBtn").disabled = busy;
  $("stopBtn").disabled = !busy && s.status !== "waiting";
  $("startBtn").textContent = s.status === "waiting" ? "Start next batch now" : "Start batch (auto)";
  if (busy) $("statusText").textContent += settings.mode === "auto" ? " · auto" : " · manual review";
  renderBatchText();
  if (s.status === "error" && s.lastError) appendLog({ at: new Date().toISOString(), message: "ERROR: " + s.lastError });
  renderCurrent();
  // The profile on screen lives in the "On screen now" panel; keep it out of history until swiped.
  for (const [id, el] of cardEls) el.hidden = id === s.awaiting?.decisionId;
}
function renderBatchText() {
  const s = state;
  const el = $("batchText");
  if (s.batch && ["running", "launching", "awaiting_login"].includes(s.status)) {
    const left = Math.max(0, Math.round((new Date(s.batch.endsAt) - Date.now()) / 60000));
    el.textContent = `· ${s.batch.plannedMinutes}-min batch, ${left} min left, ${s.batch.evaluated} profiles`;
  } else if (s.status === "waiting" && s.nextBatchAt) {
    el.textContent = `· next batch ${new Date(s.nextBatchAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  } else if (s.lastBatchEnd) {
    el.textContent = `· last batch: ${s.lastBatchEnd}`;
  } else el.textContent = "";
}
setInterval(renderBatchText, 30_000);

function appendLog(entry) {
  const el = $("log");
  el.textContent += `${entry.at.slice(11, 19)}  ${entry.message}\n`;
  el.scrollTop = el.scrollHeight;
}
function setStats(s) {
  $("sSeen").textContent = s.seen; $("sLiked").textContent = s.liked; $("sSuper").textContent = s.superLiked;
  const swiped = s.liked + s.passed;
  $("sLikeRate").textContent = swiped ? Math.round((100 * s.liked) / swiped) + "%" : "–";
  $("sLower").textContent = s.lower; $("sRight").textContent = s.aboutRight; $("sHigher").textContent = s.higher;
  $("sBias").textContent = s.meanBias === null ? "–" : (s.meanBias >= 0 ? "+" : "") + Math.round(s.meanBias * 100) + " pts";
  $("gutGap").textContent = s.meanGutGap === null ? "" : `Gut check vs arithmetic: ${s.meanGutGap >= 0 ? "+" : ""}${(s.meanGutGap * 100).toFixed(1)} pts on average over ${s.gutGapCount} profiles.`;
}
async function refreshStats() { setStats((await (await fetch("/api/state")).json()).stats); }

// ---------- shared card rendering ----------
function distanceOf(d) {
  if (typeof d.distanceMiles === "number") return d.distanceMiles;
  const m = (d.profileText ?? "").match(/(\d+(?:\.\d+)?)\s*(miles?|mi|km|kilomet\w+)\s+away/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return /k/i.test(m[2]) ? Math.round(n * 0.621371) : n;
}
function fillClassification(root, d) {
  const c = d.classification;
  const dist = distanceOf(d);
  root.querySelector(".name").textContent = `${d.name ?? "Unknown"}${d.age ? `, ${d.age}` : ""}`;
  if (dist !== undefined) { const sp = document.createElement("span"); sp.className = "dist"; sp.textContent = `${dist} mi`; root.querySelector(".name").appendChild(sp); }
  const badge = root.querySelector(".action");
  const actionLabel = { like: "Liked", superlike: "Superliked", pass: "Passed", recommend_like: "Recommends like", recommend_pass: "Recommends pass", skipped: "Not scored" };
  badge.textContent = actionLabel[d.action] ?? d.action.replace("_", " ");
  badge.className = "badge action " + d.action;
  if (c) {
    const bars = root.querySelectorAll(".prob");
    bars[0].querySelector(".fill").style.width = fmtP(c.probability);
    bars[0].querySelector(".thresh").style.left = fmtP(d.threshold);
    bars[0].querySelector(".pval").textContent = fmtP(c.probability);
    if (typeof c.arithmetic_probability === "number") {
      const a = document.createElement("span"); a.className = "arith"; a.title = "Arithmetic posterior: prior odds × the listed ratios";
      a.textContent = `arith ${fmtP(c.arithmetic_probability)}`;
      bars[0].appendChild(a);
    }
    if (typeof d.superLikeThreshold === "number") { const t = bars[0].querySelector(".thresh.super"); t.style.left = fmtP(d.superLikeThreshold); t.hidden = false; }
    if (c.intellectual_exception) {
      const lf = document.createElement("span"); lf.className = "badge likedfor"; lf.textContent = "🧠 intellectual exception";
      badge.after(lf);
    }
    if (typeof c.intellectual_probability === "number") {
      const ip = document.createElement("span"); ip.className = "intp"; ip.title = "Model's probability that you'd consider her eligible for the intellectual exception";
      ip.textContent = `🧠 ${fmtP(c.intellectual_probability)}`;
      root.querySelector(".model").appendChild(ip);
    }
    root.querySelector(".diet").textContent = c.dietary_badge ? `Dietary badge: ${c.dietary_badge}` : "No dietary badge shown";
    root.querySelector(".modelchip").textContent = modelLabel(d);
    const stage = root.querySelector(".stage");
    if (d.quickPass) stage.textContent = /pass$/.test(d.action) ? "bio and first photo only · quick pass" : "bio and first photo only";
    else if (typeof d.bioOnlyProbability === "number") stage.textContent = `bio-only ${fmtP(d.bioOnlyProbability)} → all photos ${fmtP(c.probability)}`;
    else stage.textContent = "";
    const ul = root.querySelector(".evidence");
    ul.innerHTML = "";
    for (const e of c.evidence) {
      const li = document.createElement("li");
      li.className = e.direction;
      li.textContent = `${e.criterion === "intellectual" ? "🧠 " : ""}${e.observation}`;
      if (e.criterion !== "intellectual") {
        const lr = document.createElement("span"); lr.className = "lr"; lr.textContent = `LR ${fmtRatio(e.likelihood_ratio)}`; li.appendChild(lr);
      }
      ul.appendChild(li);
    }
    if (c.reasoning) root.querySelector(".reasoning").textContent = c.reasoning;
    else root.querySelector(".reasoning")?.closest("details")?.remove();
  } else {
    root.querySelector(".prob")?.remove();
    root.querySelector(".reasoning")?.closest("details")?.remove();
    root.querySelector(".diet").innerHTML = `<span class="error">${d.error ?? "Not classified"}</span>`;
    root.querySelector(".model")?.remove();
  }
}
const thumbUrl = (url) => url.replace(/^\/photos\//, "/thumbs/");
function fillPhotos(root, d, limit, full = false) {
  const photos = root.querySelector(".photos");
  photos.innerHTML = "";
  for (const url of d.photos.slice(0, limit)) {
    const img = document.createElement("img");
    img.src = full ? url : thumbUrl(url);
    img.loading = "lazy"; img.decoding = "async";
    img.onclick = () => {
      // Zoom shows the full-size original; un-zoom goes back to the thumbnail.
      const zoomed = img.classList.toggle("zoom");
      img.src = zoomed || full ? url : thumbUrl(url);
    };
    photos.appendChild(img);
  }
}

// ---------- current profile (review mode) ----------
function renderCurrent() { keepScroll(renderCurrentInner); }
function renderCurrentInner() {
  const box = $("current");
  const id = state.awaiting?.decisionId ?? null;
  if (state.status !== "running") {
    currentDecisionId = null;
    box.className = "current empty";
    box.textContent = state.status === "awaiting_login" ? "Log into Tinder in the Chrome window that opened…"
      : state.status === "launching" ? "Opening the browser…"
      : state.status === "waiting" ? "Between batches. The next one starts on its own, or press Start to begin now."
      : "Press Start batch to begin. In review mode the profile on screen appears here with the model's read, and you swipe from the buttons below it.";
    return;
  }
  if (!id) {
    currentDecisionId = null;
    box.className = "current waiting";
    box.textContent = state.swiping ? "Swiping…" : settings.mode === "auto" ? "Auto mode: swiping on its own. Decisions appear in the history below." : "Looking at the next profile…";
    return;
  }
  const d = decisionsById.get(id);
  if (!d) { box.className = "current waiting"; box.textContent = "Loading profile…"; return; }
  if (currentDecisionId === id && box.querySelector(".card")) return; // already rendered
  currentDecisionId = id;
  const tpl = $("currentTpl").content.cloneNode(true);
  fillClassification(tpl, d);
  fillPhotos(tpl, d, 9, true);
  tpl.querySelector(".ptext").textContent = d.profileText || "(no profile text captured)";
  const rec = d.action === "recommend_like" ? "like" : d.action === "recommend_pass" ? "pass" : null;
  tpl.querySelector(".swipeHint").textContent = rec ? `Model recommends: ${rec}. Your swipe is final and is recorded as agree/disagree.` : "Model could not score this one. Your call.";
  tpl.querySelector(".pass").onclick = () => swipe("pass");
  tpl.querySelector(".like").onclick = () => swipe("like");
  box.className = "current";
  box.innerHTML = "";
  box.appendChild(tpl);
}
async function swipe(direction) {
  const id = state.awaiting?.decisionId;
  if (!id || state.swiping) return;
  const btns = $("current").querySelectorAll(".swipe button");
  btns.forEach((b) => (b.disabled = true));
  const res = await fetch("/api/swipe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisionId: id, direction }) });
  if (!res.ok) {
    const body = await res.json();
    appendLog({ at: new Date().toISOString(), message: "Swipe rejected: " + body.error });
    btns.forEach((b) => (b.disabled = false));
  }
}
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); swipe("pass"); }
  if (e.key === "ArrowRight") { e.preventDefault(); swipe("like"); }
});

// ---------- history ----------
function buildCard(d) {
  const tpl = $("cardTpl").content.cloneNode(true);
  fillClassification(tpl, d);
  fillPhotos(tpl, d, 3);
  // verdict row
  const vlabel = tpl.querySelector(".vlabel");
  if (d.userSwipe === "like" || d.userSwipe === "pass") {
    vlabel.innerHTML = `<span class="you">You <b class="${d.userSwipe}">${d.userSwipe === "like" ? "liked" : "passed"}</b> ·</span>`;
  } else if (d.userSwipe === "browser") {
    vlabel.innerHTML = `<span class="you">You swiped in the browser ·</span>`;
  } else {
    vlabel.textContent = "Your call:";
  }
  const vbtns = tpl.querySelectorAll(".vbtn:not(.exemplar)");
  const range = tpl.querySelector(".userpRange");
  const paint = (v, up) => {
    vbtns.forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    range.value = typeof up === "number" ? Math.round(up * 100) : "";
  };
  paint(d.verdict ?? null, d.userProbability);
  const send = async (verdict, userProbability) => {
    const res = await fetch(`/api/decisions/${d.id}/verdict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verdict, userProbability }) });
    if (res.ok) {
      const body = await res.json();
      const cur = decisionsById.get(d.id) ?? d;
      cur.verdict = body.decision.verdict; cur.userProbability = body.decision.userProbability;
      paint(cur.verdict ?? null, cur.userProbability); setStats(body.stats);
    }
  };
  vbtns.forEach((b) => {
    b.onclick = () => send(b.classList.contains("on") ? null : b.dataset.v, b.classList.contains("on") ? null : undefined);
  });
  const exBtn = tpl.querySelector(".vbtn.exemplar");
  exBtn.classList.toggle("on", d.exemplar === "intellectual");
  exBtn.onclick = async () => {
    const next = exBtn.classList.contains("on") ? null : "intellectual";
    const res = await fetch(`/api/decisions/${d.id}/exemplar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exemplar: next }) });
    if (res.ok) { const body = await res.json(); const cur = decisionsById.get(d.id) ?? d; cur.exemplar = body.decision.exemplar; exBtn.classList.toggle("on", cur.exemplar === "intellectual"); }
  };
  range.onchange = () => {
    if (range.value === "") { send(null, null); return; }
    const up = Math.min(100, Math.max(0, parseFloat(range.value))) / 100;
    const p = d.classification?.probability;
    const verdict = p === undefined ? null : up > p + 0.1 ? "higher" : up < p - 0.1 ? "lower" : "about_right";
    send(verdict, up);
  };
  range.onkeydown = (e) => { if (e.key === "Enter") range.blur(); };
  const note = tpl.querySelector(".note");
  note.value = noteDrafts.get(d.id) ?? d.note ?? "";
  let noteTimer = null;
  const saveNote = async () => {
    const text = note.value;
    noteDrafts.set(d.id, text);
    if ((decisionsById.get(d.id)?.note ?? "") === text) return;
    const res = await fetch(`/api/decisions/${d.id}/note`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: text }) });
    if (res.ok) {
      const body = await res.json();
      const cur = decisionsById.get(d.id) ?? d;
      cur.note = body.decision.note; // mutate in place so no card rebuild is triggered
      if (noteDrafts.get(d.id) === cur.note) noteDrafts.delete(d.id);
      note.classList.add("saved"); setTimeout(() => note.classList.remove("saved"), 1200);
    }
  };
  note.oninput = () => { noteDrafts.set(d.id, note.value); clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 800); };
  note.onblur = () => { clearTimeout(noteTimer); saveNote(); };
  if (!d.classification) { tpl.querySelector(".verdict").remove(); note.remove(); }
  tpl.querySelector(".ptext").textContent = d.profileText || "(no profile text captured)";
  const u = d.usage ? ` · ${d.usage.input + d.usage.cacheRead} in / ${d.usage.output} out tokens` : "";
  tpl.querySelector(".meta").textContent = `${new Date(d.at).toLocaleString()} · ${d.mode} mode · threshold ${fmtP(d.threshold)}${u}`;
  return tpl.querySelector("article");
}

function renderDecision(d, prepend) {
  const prev = decisionsById.get(d.id);
  if (prev) {
    // Keep local edits: the server copy may lag a note or grade typed a moment ago.
    if (noteDrafts.has(d.id)) d.note = prev.note ?? d.note;
    if (prev.verdict !== undefined && d.verdict == null) d.verdict = prev.verdict;
    if (prev.userProbability != null && d.userProbability == null) d.userProbability = prev.userProbability;
  }
  decisionsById.set(d.id, d);
  if (state.awaiting?.decisionId === d.id) renderCurrent();
  const existing = cardEls.get(d.id);
  if (existing && isEditing(existing)) { scheduleReviewRender(); return; }
  const article = buildCard(d);
  keepScroll(() => {
    const feed = $("decisions");
    feed.querySelector(".empty")?.remove();
    if (existing) existing.replaceWith(article);
    else prepend ? feed.prepend(article) : feed.appendChild(article);
    article.hidden = state.awaiting?.decisionId === d.id;
    cardEls.set(d.id, article);
    // Keep only the most recent few in the Swipe tab; the Review tab has everything.
    while (feed.children.length > 8) feed.lastElementChild.remove();
  });
  scheduleReviewRender();
}

// ---------- review tab ----------
let reviewTimer = null;
let pendingReview = 0; // background updates held back while you're reading the list
function scheduleReviewRender() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => renderReview(false), 150);
}
function updatePendingPill() {
  const pill = $("reviewPending");
  pill.hidden = pendingReview === 0;
  if (pendingReview) pill.textContent = `${pendingReview} new ${pendingReview === 1 ? "entry" : "entries"} · click to update the list`;
}
// Batches: real ids going forward; older entries are grouped by gaps of more than 15 minutes.
function assignBatches(all) {
  const sorted = [...all].sort((a, b) => (a.at < b.at ? -1 : 1));
  let pseudo = null, lastT = 0;
  for (const d of sorted) {
    const t = new Date(d.at).getTime();
    if (d.batchId) { d._batch = d.batchId; pseudo = null; }
    else {
      if (!pseudo || t - lastT > 15 * 60_000) pseudo = "~" + d.at;
      d._batch = pseudo;
    }
    lastT = t;
  }
  const groups = new Map();
  for (const d of sorted) { const g = groups.get(d._batch) ?? { id: d._batch, start: d.at, n: 0 }; g.n++; groups.set(d._batch, g); }
  return [...groups.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
}
function refreshBatchOptions(groups) {
  const sel = $("fBatch"); const cur = sel.value;
  const label = (g) => `${new Date(g.start).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${g.n} profiles${g.id.startsWith("~") ? " (grouped by time)" : ""}`;
  const wanted = ["all", ...groups.map((g) => g.id)];
  if ([...sel.options].map((o) => o.value).join("|") !== wanted.join("|")) {
    sel.innerHTML = '<option value="all">All batches</option>' + groups.map((g) => `<option value="${g.id}">${label(g)}</option>`).join("");
    sel.value = wanted.includes(cur) ? cur : "all";
  }
}

let reviewDirty = false;
const REVIEW_PAGE = 40;
let reviewLimit = REVIEW_PAGE;
function renderReview(userInitiated = true) {
  const list = $("reviewList");
  if ($("tab-review").hidden) { reviewDirty = true; return; } // render when the tab is shown
  if (isEditing(list)) { reviewDirty = true; return; } // finish typing first; re-render on blur
  // A background update while you're scrolled into the list would move things under you. Hold it.
  if (!userInitiated && window.scrollY > 150 && list.children.length) { pendingReview++; reviewDirty = true; updatePendingPill(); return; }
  pendingReview = 0; updatePendingPill();
  reviewDirty = false;
  const all = Array.from(decisionsById.values());
  refreshBatchOptions(assignBatches(all));
  const fBatch = $("fBatch").value;
  $("reviewCount").textContent = all.length ? `(${all.length})` : "";
  const minP = parseFloat($("minP").value);
  $("minPVal").textContent = fmtP(minP);
  const fAction = $("fAction").value, fSwipe = $("fSwipe").value, fSort = $("fSort").value, fVerdict = $("fVerdict").value;
  const which = $("minPWhich").value;
  const fSortNow = $("fSort").value;
  document.body.classList.toggle("show-intp", which === "int" || fSortNow === "int"); // exception probability shows only when filtering or sorting by it
  document.body.classList.toggle("show-arith", $("fProb").value === "both");
  const scoreOf = (d) => (which === "int" ? d.classification?.intellectual_probability : d.classification?.probability);
  const intOf = (d) => d.classification?.intellectual_probability ?? -1;
  let rows = all.filter((d) => {
    if (fBatch !== "all" && d._batch !== fBatch) return false;
    const p = scoreOf(d);
    if (minP > 0 && (p === undefined || p < minP)) return false;
    if (fVerdict === "ungraded" && d.verdict) return false;
    if (["higher", "lower", "about_right"].includes(fVerdict) && d.verdict !== fVerdict) return false;
    if (fAction === "like" && !/like$/.test(d.action)) return false;
    if (fAction === "pass" && !/pass$/.test(d.action)) return false;
    if (fAction === "skipped" && d.action !== "skipped") return false;
    if (fAction === "exception" && !d.classification?.intellectual_exception) return false;
    if (fSwipe === "like" && d.userSwipe !== "like" && d.action !== "like") return false;
    if (fSwipe === "pass" && d.userSwipe !== "pass" && d.action !== "pass") return false;
    if (fSwipe === "none" && (d.userSwipe || d.action === "like" || d.action === "pass")) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (fSort === "prob") return (b.classification?.probability ?? -1) - (a.classification?.probability ?? -1) || (b.at > a.at ? 1 : -1);
    if (fSort === "int") {
      // Your flagged reference cases first, then the model's own exceptions, then by probability.
      const rank = (d) => (d.exemplar === "intellectual" ? 2 : d.classification?.intellectual_exception ? 1 : 0);
      return rank(b) - rank(a) || intOf(b) - intOf(a) || (b.at > a.at ? 1 : -1);
    }
    if (fSort === "oldest") return a.at < b.at ? -1 : 1;
    if (fSort === "near") return (distanceOf(a) ?? 9999) - (distanceOf(b) ?? 9999) || (b.at > a.at ? 1 : -1);
    return a.at < b.at ? 1 : -1;
  });
  const above = all.filter((d) => (scoreOf(d) ?? -1) >= minP).length;
  const swipedRows = rows.filter((d) => ["like", "superlike", "pass"].includes(d.action));
  const likedRows = swipedRows.filter((d) => d.action !== "pass").length;
  const likeRate = swipedRows.length ? ` · like rate ${Math.round((100 * likedRows) / swipedRows.length)}% (${likedRows} of ${swipedRows.length})` : "";
  $("filterSummary").textContent = all.length
    ? `${rows.length} of ${all.length} profiles shown · ${above} scored at or above ${fmtP(minP)}${likeRate}`
    : "Nothing evaluated yet.";
  // Reuse existing cards (same decision object => same card), so typed text and open <details> survive.
  const shown = rows.slice(0, reviewLimit);
  keepScroll(() => {
    const keep = new Set(shown.map((d) => d.id));
    for (const [id, entry] of reviewCards) if (!keep.has(id)) { entry.el.remove(); reviewCards.delete(id); }
    for (const d of shown) {
      let entry = reviewCards.get(d.id);
      if (!entry || entry.ref !== d) {
        if (entry) entry.el.remove();
        entry = { el: buildCard(d), ref: d };
        reviewCards.set(d.id, entry);
      }
      list.appendChild(entry.el); // appending in order moves existing nodes into place
    }
    list.querySelector(".empty")?.remove();
    if (rows.length > reviewLimit) {
      const more = document.createElement("button"); more.className = "empty more"; more.textContent = `Show more (${shown.length} of ${rows.length})`;
      more.onclick = () => { reviewLimit += REVIEW_PAGE; renderReview(); };
      list.appendChild(more);
    }
  });
}
document.addEventListener("focusout", () => { if (reviewDirty) setTimeout(() => { if (!isEditing($("reviewList"))) renderReview(false); }, 50); });
$("reviewPending").onclick = () => { window.scrollTo({ top: 0 }); renderReview(true); };
window.addEventListener("scroll", () => { if (pendingReview && window.scrollY <= 150 && !$("tab-review").hidden) renderReview(true); }, { passive: true });
for (const id of ["minP", "minPWhich", "fAction", "fSwipe", "fSort", "fVerdict", "fProb", "fBatch"]) $(id).addEventListener("input", () => { reviewLimit = REVIEW_PAGE; renderReview(); });

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("tab-swipe").hidden = name !== "swipe";
  $("tab-review").hidden = name !== "review";
  try { localStorage.setItem("tab", name); } catch {}
  if (name === "review") renderReview(true);
}
document.querySelectorAll(".tabs .tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- init ----------
async function init() {
  const st = await (await fetch("/api/state")).json();
  fillSettings(st.settings); setStats(st.stats);
  for (const e of st.log) appendLog(e);
  const decisions = await (await fetch("/api/decisions?limit=100000")).json();
  if (!decisions.length) $("decisions").innerHTML = '<div class="empty">No decisions yet.</div>';
  for (const d of decisions.slice(0, 8)) renderDecision(d, false);
  for (const d of decisions) decisionsById.set(d.id, d);
  setState(st.state);
  let tab = "swipe";
  try { tab = localStorage.getItem("tab") || "swipe"; } catch {}
  showTab(tab);

  const es = new EventSource("/api/events");
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener("state", async (e) => { const st = JSON.parse(e.data); if (["launching"].includes(st.status)) { settings = (await (await fetch("/api/state")).json()).settings; } setState(st); });
  es.addEventListener("decision", (e) => { renderDecision(JSON.parse(e.data), true); refreshStats(); });
}

async function startRun(mode) {
  const res = await fetch("/api/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  if (res.ok) { settings.mode = mode; }
}
$("startBtn").onclick = () => startRun("auto");
$("stopBtn").onclick = () => fetch("/api/stop", { method: "POST" });
$("saveBtn").onclick = saveSettings;
for (const f of ["threshold", "prior", "continuous", "quickPassBelow", "superLikeEnabled", "superLikeThreshold", "model"]) $(f).addEventListener("input", renderSettingsDerived);
init();
