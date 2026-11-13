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

const defaultSettings = () => ({ basePrice: 1, maintenance: { client: false, reseller: false }, adminPasswordHash: "", adminSessionVersion: 0, adminPasswordChangedAt: null });
const emptyStore = () => ({ resellers: [], keys: [], activations: [], settings: defaultSettings(), createdAt: new Date().toISOString() });
let queue = Promise.resolve();

async function readStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      resellers: Array.isArray(parsed.resellers) ? parsed.resellers : [],
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      activations: Array.isArray(parsed.activations) ? parsed.activations : [],
      settings: (() => {
        const saved = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
        const maintenance = saved.maintenance && typeof saved.maintenance === "object" ? saved.maintenance : {};
        const basePrice = Number(saved.basePrice);
        const sessionVersion = Number(saved.adminSessionVersion);
        return {
          basePrice: Number.isFinite(basePrice) && basePrice >= 0 ? basePrice : 1,
          maintenance: { client: maintenance.client === true, reseller: maintenance.reseller === true },
          adminPasswordHash: typeof saved.adminPasswordHash === "string" ? saved.adminPasswordHash : "",
          adminSessionVersion: Number.isSafeInteger(sessionVersion) && sessionVersion >= 0 ? sessionVersion : 0,
          adminPasswordChangedAt: saved.adminPasswordChangedAt || null
        };
      })(),
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

function issueToken(subject, role, sessionVersion = 0) {
  return jwt.sign({ sub: subject, role, ...(role === "admin" ? { sessionVersion } : {}) }, JWT_SECRET, { expiresIn: "8h", issuer: "hax-reseller" });
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
        if (store.settings.maintenance.reseller) return res.status(503).json({ error: "لوحة الموزعين تحت الصيانة حالياً." });
        const reseller = store.resellers.find(item => item.id === payload.sub);
        if (!reseller) return res.status(401).json({ error: "حساب الموزع غير موجود أو تم حذفه." });
        req.reseller = reseller;
      } else if (role === "admin") {
        const store = await readStore();
        if (Number(payload.sessionVersion || 0) !== Number(store.settings.adminSessionVersion || 0)) {
          return res.status(401).json({ error: "تم إبطال هذه الجلسة. سجّل الدخول مجدداً." });
        }
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
  const username = String(req.body?.username || ADMIN_USERNAME);
  const password = String(req.body?.password || "");
  const store = await readStore();
  const expectedHash = store.settings.adminPasswordHash || await ADMIN_PASSWORD_HASH;
  const validUser = username === ADMIN_USERNAME;
  const validPass = await bcrypt.compare(password, expectedHash);
  if (!validUser || !validPass) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
  return res.json({ token: issueToken("admin", "admin", store.settings.adminSessionVersion || 0), role: "admin", expiresIn: 28800 });
});

app.post("/api/auth/reseller/login", authLimiter, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (code.length < 8 || code.length > 80) return res.status(401).json({ error: "رمز الموزع غير صحيح." });
  const store = await readStore();
  if (store.settings.maintenance.reseller) return res.status(503).json({ error: "لوحة الموزعين تحت الصيانة حالياً." });
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

const isStrongAdminPassword = password =>
  typeof password === "string" && password.length >= 14 && password.length <= 128 &&
  /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) &&
  /[^A-Za-z0-9]/.test(password);

app.get("/api/admin/settings", requireAuth("admin"), async (_req, res) => {
  const store = await readStore();
  res.json({ basePrice: store.settings.basePrice, maintenance: store.settings.maintenance,
    adminPasswordChangedAt: store.settings.adminPasswordChangedAt });
});

app.patch("/api/admin/settings", requireAuth("admin"), async (req, res) => {
  const price = Number(req.body?.price);
  if (!Number.isFinite(price) || price < 0 || price > 1000000)
    return res.status(400).json({ error: "السعر يجب أن يكون رقماً صالحاً بين 0 و1000000." });
  await mutateStore(store => { store.settings.basePrice = Number(price.toFixed(2)); });
  res.json({ ok: true, basePrice: Number(price.toFixed(2)) });
});

app.patch("/api/admin/settings/maintenance", requireAuth("admin"), async (req, res) => {
  const { client, reseller } = req.body || {};
  if ((client !== undefined && typeof client !== "boolean") ||
      (reseller !== undefined && typeof reseller !== "boolean") ||
      (client === undefined && reseller === undefined))
    return res.status(400).json({ error: "حالة الصيانة غير صالحة." });
  const maintenance = await mutateStore(store => {
    if (client !== undefined) store.settings.maintenance.client = client;
    if (reseller !== undefined) store.settings.maintenance.reseller = reseller;
    return store.settings.maintenance;
  });
  res.json({ ok: true, maintenance });
});

app.get("/api/public/maintenance", async (_req, res) => {
  const store = await readStore();
  res.json({ maintenance: store.settings.maintenance });
});

app.post("/api/admin/settings/password", requireAuth("admin"), async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!isStrongAdminPassword(newPassword))
    return res.status(400).json({ error: "كلمة المرور الجديدة تحتاج 14 حرفاً على الأقل، وأحرفاً كبيرة وصغيرة ورقماً ورمزاً." });
  if (currentPassword === newPassword)
    return res.status(400).json({ error: "اختر كلمة مرور مختلفة عن الحالية." });
  const newHash = await bcrypt.hash(newPassword, 12);
  const result = await mutateStore(async store => {
    const currentHash = store.settings.adminPasswordHash || await ADMIN_PASSWORD_HASH;
    if (!await bcrypt.compare(currentPassword, currentHash)) return { error: "كلمة المرور الحالية غير صحيحة." };
    store.settings.adminPasswordHash = newHash;
    store.settings.adminSessionVersion = Number(store.settings.adminSessionVersion || 0) + 1;
    store.settings.adminPasswordChangedAt = new Date().toISOString();
    return { lastChangedAt: store.settings.adminPasswordChangedAt };
  });
  if (result.error) return res.status(401).json({ error: result.error });
  res.json({ ok: true, lastChangedAt: result.lastChangedAt, message: "تم تغيير كلمة المرور وإبطال الجلسات السابقة." });
});

app.get("/api/admin/resellers", requireAuth("admin"), async (_req, res) => {
  const store = await readStore();
  res.json({ resellers: store.resellers.map(item => publicReseller(store, item)) });
});

app.post("/api/admin/resellers", requireAuth("admin"), async (req, res) => {
  const label = cleanLabel(req.body?.label || req.body?.code);
  const balance = Number(req.body?.balance ?? 0);
  if (!label) return res.status(400).json({ error: "أدخل اسم الموزع." });
  if (!Number.isFinite(balance) || balance < 0 || balance > 1000000) return res.status(400).json({ error: "قيمة الرصيد غير صالحة." });
  const requestedCode = String(req.body?.code || "").trim();
  const code = requestedCode || newCode("HAX-R");
  if (code.length < 8 || code.length > 80 || !/^[A-Za-z0-9_-]+$/.test(code)) {
    return res.status(400).json({ error: "رمز الموزع يجب أن يكون من 8 إلى 80 حرفاً أو رقماً." });
  }
  const codeHash = sha256(code.toUpperCase());
  const reseller = {
    id: newId(), label: label || code, codeHash,
    displayCode: code.length > 12 ? code.slice(0, 8) + "••••" : code,
    balance: Number(balance.toFixed(2)),
    createdAt: new Date().toISOString()
  };
  const duplicate = (await readStore()).resellers.some(item => item.codeHash === codeHash);
  if (duplicate) return res.status(409).json({ error: "رمز الموزع مستخدم مسبقاً." });
  await mutateStore(store => { store.resellers.push(reseller); });
  res.status(201).json({ reseller: { id: reseller.id, label: reseller.label, displayCode: reseller.displayCode, balance: reseller.balance }, accessCode: code });
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
    const activations = store.activations.filter(item => item.keyId === key.id);
    const usedDevices = activations.length;
    const expired = !key.expiresAt || new Date(key.expiresAt).getTime() <= Date.now();
    return { ...key, resellerLabel: reseller ? reseller.label : "الإدارة", usedDevices, activations: activations.map(item => ({ model: item.deviceModel || "الموديل غير متاح", platform: item.devicePlatform || "", activatedAt: item.activatedAt })), expired, isActive: key.isActive !== false };
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
  const keys = store.keys.filter(key => key.resellerId === req.reseller.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(key => {
    const activations = store.activations.filter(item => item.keyId === key.id);
    return { ...key, usedDevices: activations.length, activations: activations.map(item => ({ model: item.deviceModel || "الموديل غير متاح", platform: item.devicePlatform || "", activatedAt: item.activatedAt })), isActive: key.isActive !== false };
  });
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
    const unitPrice = Number(store.settings.basePrice ?? 1);
    const total = Number((unitPrice * quantity).toFixed(2));
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
  if (store.settings.maintenance.client) return res.json({ valid: false, reason: "maintenance" });
  const key = store.keys.find(item => normalizeLicenseCode(item.code) === code);
  if (!key) return res.json({ valid: false, reason: "code_not_found" });
  if (key.isActive === false) return res.json({ valid: false, reason: "code_disabled" });
  if (!key.expiresAt || new Date(key.expiresAt).getTime() <= Date.now()) return res.json({ valid: false, reason: "code_expired" });
  return res.json({ valid: true, expires_at: key.expiresAt, created_at: key.createdAt, max_devices: key.devices, code: key.code });
});

function inferDeviceFromUserAgent(userAgent) {
  const ua = String(userAgent || "");
  const android = ua.match(/Android\s[\d.]+\s*;\s*([^;)]+)/i);
  if (android) {
    const candidate = android[1].replace(/\s+Build\/.*/i, "").trim();
    if (candidate && !/^(?:k|wv|mobile|linux|unknown)$/i.test(candidate)) return candidate.slice(0, 80);
  }
  if (/iPhone/i.test(ua)) return "iPhone (الموديل الدقيق مخفي من المتصفح)";
  if (/iPad/i.test(ua)) return "iPad (الموديل الدقيق مخفي من المتصفح)";
  if (/Windows NT/i.test(ua)) return "كمبيوتر Windows (الموديل غير متاح من المتصفح)";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac (الموديل غير متاح من المتصفح)";
  if (/CrOS/i.test(ua)) return "Chromebook";
  if (/Linux/i.test(ua)) return "كمبيوتر Linux (الموديل غير متاح من المتصفح)";
  return "الموديل غير متاح من المتصفح";
}

app.post("/api/verify", verifyLimiter, async (req, res) => {
  const code = normalizeLicenseCode(req.body?.code);
  const deviceId = String(req.body?.device_id || "").trim();
  res.setHeader("Accept-CH", "Sec-CH-UA-Model, Sec-CH-UA-Platform");
  res.setHeader("Vary", "User-Agent, Sec-CH-UA-Model");
  const rawModel = String(req.body?.device_model || "").trim();
  const rawPlatform = String(req.body?.device_platform || req.get("sec-ch-ua-platform") || "").trim();
  const hintedModel = String(req.get("sec-ch-ua-model") || "").replace(/^"|"$/g, "").trim();
  const uaModel = inferDeviceFromUserAgent(req.get("user-agent"));
  const suppliedModel = rawModel && rawModel !== "الموديل غير متاح من المتصفح" ? rawModel : "";
  const deviceModel = (suppliedModel || hintedModel || uaModel).replace(/[<>\u0000-\u001f]/g, "").slice(0, 80);
  const devicePlatform = rawPlatform.replace(/[<>\u0000-\u001f]/g, "").slice(0, 40);
  if (!isSupportedLicenseCode(code)) return res.json({ valid: false, reason: "invalid_format" });
  if (deviceId.length < 8 || deviceId.length > 200) return res.json({ valid: false, reason: "missing_params" });
  const result = await mutateStore(store => {
    if (store.settings.maintenance.client) return { valid: false, reason: "maintenance" };
    const key = store.keys.find(item => normalizeLicenseCode(item.code) === code);
    if (!key) return { valid: false, reason: "code_not_found" };
    if (key.isActive === false) return { valid: false, reason: "code_disabled" };
    if (!key.expiresAt || new Date(key.expiresAt).getTime() <= Date.now()) return { valid: false, reason: "code_expired" };
    const existing = store.activations.find(item => item.keyId === key.id && item.deviceId === deviceId);
    if (existing) {
      if (deviceModel !== "الموديل غير متاح") existing.deviceModel = deviceModel;
      if (devicePlatform) existing.devicePlatform = devicePlatform;
      return { valid: true, expires_at: key.expiresAt, max_devices: key.devices };
    }
    const used = store.activations.filter(item => item.keyId === key.id).length;
    if (used >= Number(key.devices || 1)) return { valid: false, reason: "max_devices_reached" };
    store.activations.push({ id: newId(), keyId: key.id, deviceId, deviceModel, devicePlatform, activatedAt: new Date().toISOString() });
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
