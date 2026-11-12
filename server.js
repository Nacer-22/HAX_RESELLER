"use strict";
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);

if (JWT_SECRET.length < 48) {
  console.error("JWT_SECRET must contain at least 48 random characters.");
  process.exit(1);
}
if (!ADMIN_USERNAME || ADMIN_PASSWORD.length < 14) {
  console.error("Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 14 characters.");
  process.exit(1);
}

app.use(helmet());
if (allowedOrigins.length) {
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS."));
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  }));
}
app.use(express.json({ limit: "20kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "محاولات كثيرة. حاول مرة أخرى بعد قليل." }
});

const durations = {
  "3600000": { label: "ساعة واحدة", price: 0.5 },
  "10800000": { label: "3 ساعات", price: 1 },
  "21600000": { label: "6 ساعات", price: 1.5 },
  "43200000": { label: "12 ساعة", price: 2 },
  "86400000": { label: "24 ساعة", price: 2.5 },
  "259200000": { label: "3 أيام", price: 3.5 },
  "604800000": { label: "7 أيام", price: 4.5 },
  "1296000000": { label: "15 يوماً", price: 6 },
  "2592000000": { label: "30 يوماً", price: 10 }
};

const emptyStore = () => ({ resellers: [], keys: [], createdAt: new Date().toISOString() });
let queue = Promise.resolve();

async function readStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      resellers: Array.isArray(parsed.resellers) ? parsed.resellers : [],
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      createdAt: parsed.createdAt || new Date().toISOString()
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(data) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const temp = DATA_FILE + "." + crypto.randomBytes(5).toString("hex") + ".tmp";
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, DATA_FILE);
}

function mutateStore(operation) {
  const task = queue.then(async () => {
    const store = await readStore();
    const result = await operation(store);
    await writeStore(store);
    return result;
  });
  queue = task.catch(() => {});
  return task;
}

const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const newId = () => crypto.randomUUID();
const newCode = prefix => prefix + "-" + crypto.randomBytes(9).toString("hex").toUpperCase();
const cleanLabel = value => String(value || "").trim().replace(/[<>]/g, "").slice(0, 60);

function issueToken(subject, role) {
  return jwt.sign({ sub: subject, role }, JWT_SECRET, { expiresIn: "8h", issuer: "hax-reseller" });
}

function requireAuth(role) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token) return res.status(401).json({ error: "يلزم تسجيل الدخول." });
      const payload = jwt.verify(token, JWT_SECRET, { issuer: "hax-reseller" });
      if (payload.role !== role) return res.status(403).json({ error: "ليس لديك صلاحية لهذا الإجراء." });
      if (role === "reseller") {
        const store = await readStore();
        const reseller = store.resellers.find(item => item.id === payload.sub);
        if (!reseller) return res.status(401).json({ error: "حساب الموزع غير موجود أو تم حذفه." });
        req.reseller = reseller;
      }
      req.auth = payload;
      next();
    } catch {
      return res.status(401).json({ error: "انتهت الجلسة. سجّل الدخول مجدداً." });
    }
  };
}

function publicReseller(store, reseller) {
  return {
    id: reseller.id,
    label: reseller.label,
    displayCode: reseller.displayCode,
    balance: reseller.balance,
    createdAt: reseller.createdAt,
    keysCount: store.keys.filter(key => key.resellerId === reseller.id).length
  };
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "HAX_RESELLER" }));

app.post("/api/auth/admin/login", authLimiter, async (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const expectedHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const validUser = username === ADMIN_USERNAME;
  const validPass = await bcrypt.compare(password, expectedHash);
  if (!validUser || !validPass) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
  return res.json({ token: issueToken("admin", "admin"), role: "admin", expiresIn: 28800 });
});

app.post("/api/auth/reseller/login", authLimiter, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (code.length < 12 || code.length > 80) return res.status(401).json({ error: "رمز الموزع غير صحيح." });
  const store = await readStore();
  const reseller = store.resellers.find(item => item.codeHash === sha256(code));
  if (!reseller) return res.status(401).json({ error: "رمز الموزع غير صحيح." });
  return res.json({ token: issueToken(reseller.id, "reseller"), role: "reseller", expiresIn: 28800 });
});

app.get("/api/admin/overview", requireAuth("admin"), async (_req, res) => {
  const store = await readStore();
  res.json({
    resellers: store.resellers.length,
    keys: store.keys.length,
    activeKeys: store.keys.filter(key => new Date(key.expiresAt).getTime() > Date.now()).length,
    balance: Number(store.resellers.reduce((sum, item) => sum + Number(item.balance || 0), 0).toFixed(2))
  });
});

app.get("/api/admin/resellers", requireAuth("admin"), async (_req, res) => {
  const store = await readStore();
  res.json({ resellers: store.resellers.map(item => publicReseller(store, item)) });
});

app.post("/api/admin/resellers", requireAuth("admin"), async (req, res) => {
  const label = cleanLabel(req.body?.label);
  const balance = Number(req.body?.balance ?? 0);
  if (!label) return res.status(400).json({ error: "أدخل اسم الموزع." });
  if (!Number.isFinite(balance) || balance < 0 || balance > 1000000) return res.status(400).json({ error: "قيمة الرصيد غير صالحة." });
  const code = newCode("HAX-R");
  const reseller = {
    id: newId(), label, codeHash: sha256(code),
    displayCode: code.slice(0, 10) + "••••••",
    balance: Number(balance.toFixed(2)),
    createdAt: new Date().toISOString()
  };
  await mutateStore(store => { store.resellers.push(reseller); });
  res.status(201).json({ reseller: { id: reseller.id, label, displayCode: reseller.displayCode, balance: reseller.balance }, accessCode: code });
});

app.patch("/api/admin/resellers/:id/balance", requireAuth("admin"), async (req, res) => {
  const amount = Number(req.body?.amount);
  const action = req.body?.action;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || !["add", "deduct"].includes(action)) {
    return res.status(400).json({ error: "تحقق من المبلغ ونوع العملية." });
  }
  const updated = await mutateStore(store => {
    const reseller = store.resellers.find(item => item.id === req.params.id);
    if (!reseller) return null;
    const next = Number((reseller.balance + (action === "add" ? amount : -amount)).toFixed(2));
    if (next < 0) return { insufficient: true };
    reseller.balance = next;
    return publicReseller(store, reseller);
  });
  if (!updated) return res.status(404).json({ error: "الموزع غير موجود." });
  if (updated.insufficient) return res.status(409).json({ error: "الرصيد لا يسمح بهذه العملية." });
  res.json({ reseller: updated });
});

app.delete("/api/admin/resellers/:id", requireAuth("admin"), async (req, res) => {
  const removed = await mutateStore(store => {
    const before = store.resellers.length;
    store.resellers = store.resellers.filter(item => item.id !== req.params.id);
    store.keys = store.keys.filter(key => key.resellerId !== req.params.id);
    return store.resellers.length !== before;
  });
  if (!removed) return res.status(404).json({ error: "الموزع غير موجود." });
  res.json({ ok: true });
});

app.delete("/api/admin/keys", requireAuth("admin"), async (_req, res) => {
  const count = await mutateStore(store => {
    const previous = store.keys.length;
    store.keys = [];
    return previous;
  });
  res.json({ ok: true, deleted: count });
});

app.get("/api/reseller/me", requireAuth("reseller"), async (req, res) => {
  const store = await readStore();
  const current = store.resellers.find(item => item.id === req.reseller.id);
  if (!current) return res.status(404).json({ error: "الحساب غير موجود." });
  res.json(publicReseller(store, current));
});

app.get("/api/reseller/keys", requireAuth("reseller"), async (req, res) => {
  const store = await readStore();
  const keys = store.keys.filter(key => key.resellerId === req.reseller.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ keys });
});

app.post("/api/reseller/keys", requireAuth("reseller"), async (req, res) => {
  const durationMs = String(req.body?.durationMs || "");
  const quantity = Number(req.body?.quantity);
  const devices = Number(req.body?.devices);
  if (!durations[durationMs]) return res.status(400).json({ error: "مدة المفتاح غير صالحة." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return res.status(400).json({ error: "الكمية يجب أن تكون بين 1 و10." });
  if (![1, 2, 3, 5].includes(devices)) return res.status(400).json({ error: "عدد الأجهزة غير صالح." });
  const result = await mutateStore(store => {
    const reseller = store.resellers.find(item => item.id === req.reseller.id);
    if (!reseller) return { error: "الحساب غير موجود.", status: 404 };
    const total = Number((durations[durationMs].price * quantity).toFixed(2));
    if (reseller.balance < total) return { error: "رصيدك غير كافٍ لإنشاء هذه المفاتيح.", status: 409 };
    const now = Date.now();
    const created = Array.from({ length: quantity }, () => {
      const key = {
        id: newId(), code: newCode("HAX-K"),
        resellerId: reseller.id,
        durationMs: Number(durationMs),
        durationLabel: durations[durationMs].label,
        devices,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + Number(durationMs)).toISOString()
      };
      store.keys.push(key);
      return key;
    });
    reseller.balance = Number((reseller.balance - total).toFixed(2));
    return { keys: created, total, balance: reseller.balance };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result);
});

app.delete("/api/reseller/keys/:id", requireAuth("reseller"), async (req, res) => {
  const deleted = await mutateStore(store => {
    const index = store.keys.findIndex(key => key.id === req.params.id && key.resellerId === req.reseller.id);
    if (index < 0) return false;
    store.keys.splice(index, 1);
    return true;
  });
  if (!deleted) return res.status(404).json({ error: "المفتاح غير موجود." });
  res.json({ ok: true });
});

app.delete("/api/reseller/keys", requireAuth("reseller"), async (req, res) => {
  const count = await mutateStore(store => {
    const before = store.keys.length;
    store.keys = store.keys.filter(key => key.resellerId !== req.reseller.id);
    return before - store.keys.length;
  });
  res.json({ ok: true, deleted: count });
});

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.use((error, _req, res, _next) => {
  console.error(error.message);
  if (res.headersSent) return;
  const status = error.message === "Origin is not allowed by CORS." ? 403 : 500;
  res.status(status).json({ error: status === 403 ? "هذا النطاق غير مسموح." : "حدث خطأ داخلي." });
});

async function start() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try { await fs.access(DATA_FILE); }
  catch { await writeStore(emptyStore()); }
  app.listen(PORT, () => console.log("HAX_RESELLER listening on port " + PORT));
}
start().catch(error => { console.error("Startup failed:", error); process.exit(1); });
