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
const ADMIN_PASSWORD_HASH = bcrypt.hash(ADMIN_PASSWORD, 10);
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

const emptyStore = () => ({ resellers: [], keys: [], activations: [], createdAt: new Date().toISOString() });
let queue = Promise.resolve();

async function readStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      resellers: Array.isArray(parsed.resellers) ? parsed.resellers : [],
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      activations: Array.isArray(parsed.activations) ? parsed.activations : [],
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
const newLicenseCode = () => `Nacer-${crypto.randomBytes(2).toString("hex").toUpperCase()}_${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
const normalizeLicenseCode = value => String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const isSupportedLicenseCode = value => /^NACER[A-F0-9]{12}$/.test(value) || /^HAXK[A-F0-9]{18}$/.test(value);
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
  const expectedHash = await ADMIN_PASSWORD_HASH;
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
    activeKeys: store.keys.filter(key => key.isActive !== false && new Date(key.expiresAt).getTime() > Date.now()).length,
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
    const removedIds = new Set(store.keys.filter(key => key.resellerId === req.params.id).map(key => key.id));
    store.keys = store.keys.filter(key => key.resellerId !== req.params.id);
    store.activations = store.activations.filter(item => !removedIds.has(item.keyId));
    return store.resellers.length !== before;
  });
  if (!removed) return res.status(404).json({ error: "الموزع غير موجود." });
  res.json({ ok: true });
});

app.get("/api/admin/keys", requireAuth("admin"), async (_req, res) => {
  const store = await readStore();
  const keys = store.keys.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(key => {
    const reseller = store.resellers.find(item => item.id === key.resellerId);
    const usedDevices = store.activations.filter(item => item.keyId === key.id).length;
    const expired = !key.expiresAt || new Date(key.expiresAt).getTime() <= Date.now();
    return { ...key, resellerLabel: reseller ? reseller.label : "الإدارة", usedDevices, expired, isActive: key.isActive !== false };
  });
  res.json({ keys });
});

app.post("/api/admin/keys", requireAuth("admin"), async (req, res) => {
  const durationMs = String(req.body?.durationMs || "");
  const quantity = Number(req.body?.quantity);
  const devices = Number(req.body?.devices);
  if (!durations[durationMs]) return res.status(400).json({ error: "مدة المفتاح غير صالحة." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return res.status(400).json({ error: "الكمية يجب أن تكون بين 1 و50." });
  if (![1, 2, 3, 5].includes(devices)) return res.status(400).json({ error: "عدد الأجهزة غير صالح." });
  const created = await mutateStore(store => {
    const now = Date.now();
    const keys = Array.from({ length: quantity }, () => {
      const key = {
        id: newId(), code: newLicenseCode(), resellerId: null,
        durationMs: Number(durationMs), durationLabel: durations[durationMs].label,
        devices, isActive: true, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + Number(durationMs)).toISOString()
      };
      store.keys.push(key);
      return key;
    });
    return keys;
  });
  res.status(201).json({ keys: created });
});

app.patch("/api/admin/keys/:id", requireAuth("admin"), async (req, res) => {
  const { isActive, expiresAt, devices } = req.body || {};
  if (isActive !== undefined && typeof isActive !== "boolean") return res.status(400).json({ error: "حالة المفتاح غير صالحة." });
  if (devices !== undefined && ![1, 2, 3, 5].includes(Number(devices))) return res.status(400).json({ error: "عدد الأجهزة غير صالح." });
  if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) return res.status(400).json({ error: "تاريخ الانتهاء غير صالح." });
  const updated = await mutateStore(store => {
    const key = store.keys.find(item => item.id === req.params.id);
    if (!key) return null;
    if (devices !== undefined) {
      const used = store.activations.filter(item => item.keyId === key.id).length;
      if (Number(devices) < used) return { conflict: true };
      key.devices = Number(devices);
    }
    if (isActive !== undefined) key.isActive = isActive;
    if (expiresAt !== undefined) key.expiresAt = new Date(expiresAt).toISOString();
    return key;
  });
  if (!updated) return res.status(404).json({ error: "المفتاح غير موجود." });
  if (updated.conflict) return res.status(409).json({ error: "عدد الأجهزة أقل من عدد الأجهزة المستخدمة حالياً." });
  res.json({ key: updated });
});

app.post("/api/admin/keys/:id/reset", requireAuth("admin"), async (req, res) => {
  const result = await mutateStore(store => {
    if (!store.keys.some(item => item.id === req.params.id)) return null;
    const before = store.activations.length;
    store.activations = store.activations.filter(item => item.keyId !== req.params.id);
    return before - store.activations.length;
  });
  if (result === null) return res.status(404).json({ error: "المفتاح غير موجود." });
  res.json({ ok: true, resetDevices: result });
});

app.delete("/api/admin/keys/:id", requireAuth("admin"), async (req, res) => {
  const deleted = await mutateStore(store => {
    const before = store.keys.length;
    store.keys = store.keys.filter(item => item.id !== req.params.id);
    store.activations = store.activations.filter(item => item.keyId !== req.params.id);
    return store.keys.length !== before;
  });
  if (!deleted) return res.status(404).json({ error: "المفتاح غير موجود." });
  res.json({ ok: true });
});

app.delete("/api/admin/keys", requireAuth("admin"), async (_req, res) => {
  const count = await mutateStore(store => {
    const previous = store.keys.length;
    store.keys = [];
    store.activations = [];
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
  const keys = store.keys.filter(key => key.resellerId === req.reseller.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(key => ({ ...key, usedDevices: store.activations.filter(item => item.keyId === key.id).length, isActive: key.isActive !== false }));
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
        id: newId(), code: newLicenseCode(),
        resellerId: reseller.id,
        durationMs: Number(durationMs),
        durationLabel: durations[durationMs].label,
        devices, isActive: true,
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
    const [removed] = store.keys.splice(index, 1);
    store.activations = store.activations.filter(item => item.keyId !== removed.id);
    return true;
  });
  if (!deleted) return res.status(404).json({ error: "المفتاح غير موجود." });
  res.json({ ok: true });
});

app.delete("/api/reseller/keys", requireAuth("reseller"), async (req, res) => {
  const count = await mutateStore(store => {
    const before = store.keys.length;
    const removedIds = new Set(store.keys.filter(key => key.resellerId === req.reseller.id).map(key => key.id));
    store.keys = store.keys.filter(key => key.resellerId !== req.reseller.id);
    store.activations = store.activations.filter(item => !removedIds.has(item.keyId));
    return before - store.keys.length;
  });
  res.json({ ok: true, deleted: count });
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { valid: false, reason: "too_many_requests" }
});

app.post("/api/check", verifyLimiter, async (req, res) => {
  const code = normalizeLicenseCode(req.body?.code);
  if (!isSupportedLicenseCode(code)) return res.json({ valid: false, reason: "invalid_format" });
  const store = await readStore();
  const key = store.keys.find(item => normalizeLicenseCode(item.code) === code);
  if (!key) return res.json({ valid: false, reason: "code_not_found" });
  if (key.isActive === false) return res.json({ valid: false, reason: "code_disabled" });
  if (!key.expiresAt || new Date(key.expiresAt).getTime() <= Date.now()) return res.json({ valid: false, reason: "code_expired" });
  return res.json({ valid: true, expires_at: key.expiresAt, created_at: key.createdAt, max_devices: key.devices, code: key.code });
});

app.post("/api/verify", verifyLimiter, async (req, res) => {
  const code = normalizeLicenseCode(req.body?.code);
  const deviceId = String(req.body?.device_id || "").trim();
  if (!isSupportedLicenseCode(code)) return res.json({ valid: false, reason: "invalid_format" });
  if (deviceId.length < 8 || deviceId.length > 200) return res.json({ valid: false, reason: "missing_params" });
  const result = await mutateStore(store => {
    const key = store.keys.find(item => normalizeLicenseCode(item.code) === code);
    if (!key) return { valid: false, reason: "code_not_found" };
    if (key.isActive === false) return { valid: false, reason: "code_disabled" };
    if (!key.expiresAt || new Date(key.expiresAt).getTime() <= Date.now()) return { valid: false, reason: "code_expired" };
    const existing = store.activations.find(item => item.keyId === key.id && item.deviceId === deviceId);
    if (existing) return { valid: true, expires_at: key.expiresAt, max_devices: key.devices };
    const used = store.activations.filter(item => item.keyId === key.id).length;
    if (used >= Number(key.devices || 1)) return { valid: false, reason: "max_devices_reached" };
    store.activations.push({ id: newId(), keyId: key.id, deviceId, activatedAt: new Date().toISOString() });
    return { valid: true, expires_at: key.expiresAt, max_devices: key.devices };
  });
  return res.json(result);
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
