const $ = (id) => document.getElementById(id);
const fields = ["threshold", "prior", "batchMinMinutes", "batchMaxMinutes", "continuous", "breakMinMinutes", "breakMaxMinutes", "activeStartHour", "activeEndHour", "maxSwipesPerSession", "minDelayMs", "maxDelayMs", "humanize", "photoFlipChance", "maxPhotos", "model", "effort", "browserChannel"];
const boolFields = new Set(["humanize", "continuous"]);
let settings = {};
let state = { status: "idle", awaiting: null, swiping: false };
const decisionsById = new Map();
const cardEls = new Map();
let currentDecisionId = null;

function fmtP(p) { return (p * 100).toFixed(0) + "%"; }

// ---------- settings ----------
function renderSettingsDerived() {
  $("thresholdVal").textContent = fmtP(parseFloat($("threshold").value));
  const prior = parseFloat($("prior").value);
  $("priorVal").textContent = fmtP(prior);
  $("lrNeeded").textContent = ((1 - prior) / prior).toFixed(1);
  $("photoFlipVal").textContent = fmtP(parseFloat($("photoFlipChance").value));
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
  $("reviewBtn").disabled = busy;
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
  $("sSeen").textContent = s.seen; $("sLiked").textContent = s.liked; $("sRec").textContent = s.recommendedLike;
  $("sAgree").textContent = s.agreed; $("sDisagree").textContent = s.disagreed;
  const n = s.agreed + s.disagreed;
  $("sAgreeRate").textContent = n ? Math.round((100 * s.agreed) / n) + "%" : "–";
}
async function refreshStats() { setStats((await (await fetch("/api/state")).json()).stats); }

// ---------- shared card rendering ----------
function fillClassification(root, d) {
  const c = d.classification;
  root.querySelector(".name").textContent = `${d.name ?? "Unknown"}${d.age ? `, ${d.age}` : ""}`;
  const badge = root.querySelector(".action");
  badge.textContent = d.action.replace("_", " ");
  badge.className = "badge action " + d.action;
  if (c) {
    root.querySelector(".fill").style.width = fmtP(c.probability);
    root.querySelector(".thresh").style.left = fmtP(d.threshold);
    root.querySelector(".pval").textContent = fmtP(c.probability);
    root.querySelector(".diet").textContent = c.dietary_badge ? `Dietary badge: ${c.dietary_badge}` : "No dietary badge shown";
    const ul = root.querySelector(".evidence");
    ul.innerHTML = "";
    for (const e of c.evidence) {
      const li = document.createElement("li");
      li.className = e.direction;
      li.textContent = e.observation;
      const lr = document.createElement("span"); lr.className = "lr"; lr.textContent = `LR ${e.likelihood_ratio}×`; li.appendChild(lr);
      ul.appendChild(li);
    }
    root.querySelector(".reasoning").textContent = c.reasoning;
  } else {
    root.querySelector(".prob")?.remove();
    root.querySelector(".reasoning")?.closest("details")?.remove();
    root.querySelector(".diet").innerHTML = `<span class="error">${d.error ?? "Not classified"}</span>`;
  }
}
function fillPhotos(root, d, limit) {
  const photos = root.querySelector(".photos");
  photos.innerHTML = "";
  for (const url of d.photos.slice(0, limit)) {
    const img = document.createElement("img"); img.src = url; img.loading = "lazy";
    img.onclick = () => img.classList.toggle("zoom");
    photos.appendChild(img);
  }
}

// ---------- current profile (review mode) ----------
function renderCurrent() {
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
  fillPhotos(tpl, d, 9);
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
  const vbtns = tpl.querySelectorAll(".vbtn");
  const paint = (v) => vbtns.forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  paint(d.verdict ?? null);
  vbtns.forEach((b) => {
    b.onclick = async () => {
      const next = b.classList.contains("on") ? null : b.dataset.v;
      const res = await fetch(`/api/decisions/${d.id}/verdict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verdict: next }) });
      if (res.ok) { const body = await res.json(); paint(body.decision.verdict ?? null); setStats(body.stats); }
    };
  });
  tpl.querySelector(".ptext").textContent = d.profileText || "(no profile text captured)";
  const u = d.usage ? ` · ${d.usage.input + d.usage.cacheRead} in / ${d.usage.output} out tokens` : "";
  tpl.querySelector(".meta").textContent = `${new Date(d.at).toLocaleString()} · ${d.mode} mode · threshold ${fmtP(d.threshold)}${u}`;
  return tpl.querySelector("article");
}

function renderDecision(d, prepend) {
  decisionsById.set(d.id, d);
  if (state.awaiting?.decisionId === d.id) renderCurrent();
  const existing = cardEls.get(d.id);
  const article = buildCard(d);
  const feed = $("decisions");
  feed.querySelector(".empty")?.remove();
  if (existing) existing.replaceWith(article);
  else prepend ? feed.prepend(article) : feed.appendChild(article);
  article.hidden = state.awaiting?.decisionId === d.id;
  cardEls.set(d.id, article);
  // Keep only the most recent few in the Swipe tab; the Review tab has everything.
  while (feed.children.length > 8) feed.lastElementChild.remove();
  scheduleReviewRender();
}

// ---------- review tab ----------
let reviewTimer = null;
function scheduleReviewRender() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(renderReview, 150);
}
function renderReview() {
  const all = Array.from(decisionsById.values());
  $("reviewCount").textContent = all.length ? `(${all.length})` : "";
  const minP = parseFloat($("minP").value);
  $("minPVal").textContent = fmtP(minP);
  const fAction = $("fAction").value, fSwipe = $("fSwipe").value, fSort = $("fSort").value;
  let rows = all.filter((d) => {
    const p = d.classification?.probability;
    if (minP > 0 && (p === undefined || p < minP)) return false;
    if (fAction === "like" && !/like$/.test(d.action)) return false;
    if (fAction === "pass" && !/pass$/.test(d.action)) return false;
    if (fAction === "skipped" && d.action !== "skipped") return false;
    if (fSwipe === "like" && d.userSwipe !== "like" && d.action !== "like") return false;
    if (fSwipe === "pass" && d.userSwipe !== "pass" && d.action !== "pass") return false;
    if (fSwipe === "none" && (d.userSwipe || d.action === "like" || d.action === "pass")) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (fSort === "prob") return (b.classification?.probability ?? -1) - (a.classification?.probability ?? -1) || (b.at > a.at ? 1 : -1);
    if (fSort === "oldest") return a.at < b.at ? -1 : 1;
    return a.at < b.at ? 1 : -1;
  });
  const above = all.filter((d) => (d.classification?.probability ?? -1) >= minP).length;
  $("filterSummary").textContent = all.length
    ? `${rows.length} of ${all.length} profiles shown · ${above} scored at or above ${fmtP(minP)}`
    : "Nothing evaluated yet.";
  const list = $("reviewList");
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const d of rows.slice(0, 300)) frag.appendChild(buildCard(d));
  list.appendChild(frag);
  if (rows.length > 300) {
    const more = document.createElement("div"); more.className = "empty"; more.textContent = `Showing 300 of ${rows.length}. Tighten the filter to see the rest.`;
    list.appendChild(more);
  }
}
for (const id of ["minP", "fAction", "fSwipe", "fSort"]) $(id).addEventListener("input", renderReview);

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("tab-swipe").hidden = name !== "swipe";
  $("tab-review").hidden = name !== "review";
  try { localStorage.setItem("tab", name); } catch {}
  if (name === "review") renderReview();
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
$("reviewBtn").onclick = () => startRun("review");
$("stopBtn").onclick = () => fetch("/api/stop", { method: "POST" });
$("saveBtn").onclick = saveSettings;
for (const f of ["threshold", "prior", "continuous", "photoFlipChance"]) $(f).addEventListener("input", renderSettingsDerived);
init();
