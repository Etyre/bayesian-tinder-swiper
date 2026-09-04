import "dotenv/config";
import express from "express";
import { PUBLIC_DIR, PHOTOS_DIR } from "./paths.js";
import { loadSettings, updateSettings } from "./config.js";
import { readDecisions, setVerdict, stats } from "./store.js";
import { Swiper } from "./swiper.js";

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/photos", express.static(PHOTOS_DIR, { maxAge: "1d" }));

const swiper = new Swiper();
const recentLog: { at: string; message: string }[] = [];
swiper.on("log", (entry) => {
  recentLog.push(entry);
  if (recentLog.length > 200) recentLog.shift();
  console.log(`[${entry.at}] ${entry.message}`);
});

// --- Server-sent events for live updates ---
const clients = new Set<express.Response>();
function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
swiper.on("log", (e) => broadcast("log", e));
swiper.on("state", (s) => broadcast("state", s));
swiper.on("decision", (d) => broadcast("decision", d));

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  clients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(swiper.state)}\n\n`);
  req.on("close", () => clients.delete(res));
});

// --- REST ---
app.get("/api/state", (_req, res) => {
  res.json({ state: swiper.state, settings: loadSettings(), stats: stats(), log: recentLog.slice(-50) });
});
app.get("/api/decisions", (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 100_000);
  res.json(readDecisions(limit));
});
app.post("/api/decisions/:id/verdict", (req, res) => {
  const v = req.body?.verdict;
  if (v !== "agree" && v !== "disagree" && v !== null) return res.status(400).json({ error: "verdict must be agree, disagree, or null" });
  const d = setVerdict(String(req.params.id), v);
  if (!d) return res.status(404).json({ error: "decision not found" });
  res.json({ decision: d, stats: stats() });
});
app.post("/api/swipe", (req, res) => {
  const { decisionId, direction } = req.body ?? {};
  if (direction !== "like" && direction !== "pass") return res.status(400).json({ error: "direction must be like or pass" });
  const r = swiper.requestSwipe(String(decisionId), direction);
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ ok: true });
});
app.post("/api/settings", (req, res) => {
  try {
    res.json(updateSettings(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.post("/api/start", async (req, res) => {
  const mode = req.body?.mode === "review" ? "review" : "auto";
  void swiper.start(mode);
  res.json({ ok: true, mode });
});
app.post("/api/stop", async (_req, res) => {
  await swiper.stop();
  res.json({ ok: true });
});

app.get("/api/debug/inspect", async (req, res) => {
  try {
    res.json(await swiper.inspect(req.query.open === "1"));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const port = parseInt(process.env.PORT ?? "4747", 10);
app.listen(port, "127.0.0.1", () => {
  console.log(`Dashboard: http://localhost:${port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await swiper.shutdown();
    process.exit(0);
  });
}
