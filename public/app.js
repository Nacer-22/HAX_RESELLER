(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const apiBase = String((window.HAX_SITE_CONFIG || {}).API_BASE_URL || "").replace(/\/+$/, "");
  const HAPP = "happ://crypt5/fzvd4YgqdTHtPvjHwhZcw54y24f7Dk0goBe2Fa1lwDobLeD1wJ/QO6q6l24H6Re0xAiw9PskIQB2kP+rco9tRM+3dKIoFMLXly9M+D4ldIR6piO1jP7rKBCMbFuluqrSjPTdvZ2GCrgAw2Od9N3Z3smxJidBwT/Pp5nygdjj4WjatLy07EI3tGhREKTcj1lohQIQ4V8w/OxgmvwGOWRHsEYL2m2PjGST1R3JY/aHOV5x6R4X5OUqBwJMzCt9str+x4gOEen5haEsE33G4fLDuFio0JJrTwH5+J57flABwGFeJ6xUeHvMj3trh12dB6jUOikacLaWDr1K/iiFBmQ/49+Z7erc2SrSba4m7OLM+JytVfUKOcoLliCftLpHJrq3MqsOPstNkTvOx0uQZSTJ7mlsI38vWVjl/eSznEASBgSz8yViHbJuMJdocMub07L3xHO8aWMbln9vVzUlDyD2KaeD9qIQfbVXusHpuitOMCHwuGxWARZcRPA7MzW8D/BZMq4X1FqKBaJYzHBEYbzqGaT4J1fEZ3clHpeOgcdEB8z4fQ/IbdLlTpZFO2l+ueHhPzLRVpINU9aRXCDz3VFFAnJO8PZ5CFpT1N+ixLmQb2fEhyVexHC6MOnF8nRQ630G7z5ierJOGT6MlSVmdKh504SbEPIHCimLjDq6zWFD8WqmbIjEdl5kra6NnqjllRCOpZ9gLA5EHp3ItLgeYLheipP697OxUq/wLnZqrTEtOLrbjH7+aDudlSJrvNlWau7Ar2HWst3QvwP4o2hUVtQSal8jSc7cDJr53xBdEh3Ftba0/NNB4wCh1aP2hTvXeK/wkfgWbzhJwmkeu0rjGcXVUJBqH7lFuHd79qrXyLA2YPyrewPrqC1qbtG1ivYGcD1SQrG/hX+f6ZzI3oG5r7o96dM7Y5GDfdBlfV8oSrrAkz1VQsiqviGG19jWmfoE=ff";
  let token = "", resellerCode = "", busy = false, priceBusy = false, timer = 0;
  let resellers = [];

  async function api(path, options) {
    options = options || {};
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", "Bearer " + token);
    const response = await fetch(apiBase + path, Object.assign({}, options, { headers }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
    return data;
  }

  async function refreshResellerMaintenance() {
    try {
      const response = await fetch(apiBase + "/api/public/maintenance", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const active = !!(data.maintenance && data.maintenance.reseller);
      const screen = $("haxResellerMaintenance");
      const app = $("appRoot");
      if (screen) screen.style.display = active ? "flex" : "none";
      if (app) app.style.display = active ? "none" : "";
    } catch (_) {
      // Fail open if the public maintenance status cannot be reached.
    }
  }

  function safe(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[ch]));
  }
  function msg(text, color) {
    const el = $("msg");
    el.textContent = text;
    el.style.color = color || "var(--accent-glow)";
    clearTimeout(timer);
    timer = setTimeout(() => { el.textContent = ""; }, 5000);
  }
  function toggleAccordion(header) {
    header.classList.toggle("active");
    if (header.nextElementSibling) header.nextElementSibling.classList.toggle("show");
  }
  function showAdminLogin() {
    $("resellerLoginView").classList.add("hidden");
    $("adminLoginView").classList.remove("hidden");
  }
  function showResellerLogin() {
    $("adminLoginView").classList.add("hidden");
    $("resellerLoginView").classList.remove("hidden");
  }
  function logout() {
    token = "";
    resellerCode = "";
    $("resellerPanel").classList.add("hidden");
    $("adminPanel").classList.add("hidden");
    $("adminLoginView").classList.add("hidden");
    $("resellerLoginView").classList.remove("hidden");
    $("resellerInputCode").value = "";
    $("adminInputPass").value = "";
    $("newKeysResultBox").classList.add("hidden");
    $("newKeysListContent").innerHTML = "";
    msg("تم تسجيل الخروج.");
  }
  async function loginAsReseller() {
    const code = $("resellerInputCode").value.trim().toUpperCase();
    if (!code) return msg("أدخل رمز الموزع.", "var(--danger-red)");
    msg("جارٍ التحقق...");
    try {
      const data = await api("/api/auth/reseller/login", { method:"POST", body:JSON.stringify({code}) });
      token = data.token;
      resellerCode = code;
      $("resellerLoginView").classList.add("hidden");
      $("adminLoginView").classList.add("hidden");
      $("adminPanel").classList.add("hidden");
      $("resellerPanel").classList.remove("hidden");
      await loadResellerPanelData();
      msg("تم تسجيل الدخول بنجاح.", "var(--success-green)");
    } catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function loginAsAdmin() {
    const password = $("adminInputPass").value;
    if (!password) return msg("أدخل كلمة المرور.", "var(--danger-red)");
    msg("جارٍ تسجيل الدخول...");
    try {
      const data = await api("/api/auth/admin/login", { method:"POST", body:JSON.stringify({password}) });
      token = data.token;
      $("adminLoginView").classList.add("hidden");
      $("resellerLoginView").classList.add("hidden");
      $("resellerPanel").classList.add("hidden");
      $("adminPanel").classList.remove("hidden");
      await loadAdminDashboard();
      msg("تم تسجيل دخول الإدارة.", "var(--success-green)");
    } catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function loadResellerPanelData() {
    const pair = await Promise.all([api("/api/reseller/me"), api("/api/reseller/keys")]);
    $("resellerDisplayCode").textContent = resellerCode || pair[0].displayCode || "";
    $("resellerDisplayBalance").textContent = Number(pair[0].balance || 0).toFixed(2);
    const keys = Array.isArray(pair[1].keys) ? pair[1].keys : [];
    $("resellerKeysCountBadge").textContent = keys.length;
    $("resellerKeysList").innerHTML = keys.length ? keys.map((k, i) => {
      const expired = !k.expiresAt || Date.parse(k.expiresAt) <= Date.now();
      const active = k.isActive !== false && !expired;
      const status = active ? "ACTIVE" : (k.isActive === false ? "STOPPED" : "EXPIRED");
      return '<div style="background:rgba(10,13,20,.9);border:1px solid var(--card-border);padding:12px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
       '<div style="min-width:0"><div class="code-text">#' + (i + 1) + ' ' + safe(k.code) + '</div><div style="font-size:.7rem;color:var(--text-muted)">' + safe(k.durationLabel) + ' | Devices: ' + safe(k.devices) + ' | ' + status + '</div><div style="font-size:.72rem;color:#ff7180;margin-top:5px">الأجهزة المستخدمة: ' + (Array.isArray(k.activations) && k.activations.length ? k.activations.map(a => safe(a.model || "الموديل غير متاح")).join('، ') : 'لم يتم تفعيل المفتاح بعد') + '</div></div>' +
       '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn-share-vibrant" type="button" data-act="copykey" data-k="' + safe(k.code) + '">نسخ الكود</button><button class="btn-share-vibrant" type="button" data-act="sharekey" data-k="' + safe(k.code) + '">مشاركة</button><button class="btn-trash" data-act="delkey" data-k="' + safe(k.id) + '">حذف</button></div></div>';
    }).join("") : '<div style="text-align:center;color:var(--text-muted)">لا توجد مفاتيح بعد.</div>';
  }
  async function generateKeys() {
    if (busy) return;
    const durationMs = Number($("keyDurationSelect").value);
    const devices = Number($("keyMaxDevicesSelect").value);
    const quantity = Number.parseInt($("keyQuantityInput").value, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return msg("الكمية من 1 إلى 10.", "var(--danger-red)");
    busy = true;
    $("generateBtn").disabled = true;
    msg("جارٍ إنشاء المفاتيح...");
    try {
      const data = await api("/api/reseller/keys", { method:"POST", body:JSON.stringify({durationMs, devices, quantity}) });
      const keys = data.keys || [];
      $("newKeysCountNum").textContent = keys.length;
      $("newKeysListContent").innerHTML = keys.map((k, i) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;background:rgba(3,4,7,.9);padding:10px 14px;border-radius:10px;border:1px solid rgba(0,230,118,.3)"><span class="code-text">' + (i + 1) + ". " + safe(k.code) + '</span><button class="btn-share-vibrant" type="button" data-act="copykey" data-k="' + safe(k.code) + '">نسخ الكود</button><button class="btn-share-vibrant" type="button" data-act="sharekey" data-k="' + safe(k.code) + '">مشاركة</button></div>'
      ).join("");
      $("newKeysResultBox").classList.toggle("hidden", !keys.length);
      await loadResellerPanelData();
      msg("تم إنشاء " + keys.length + " مفتاح.", "var(--success-green)");
    } catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
    finally { busy = false; $("generateBtn").disabled = false; }
  }
  async function deleteResellerKey(id) {
    if (!id || !confirm("حذف هذا المفتاح؟")) return;
    try { await api("/api/reseller/keys/" + encodeURIComponent(id), {method:"DELETE"}); await loadResellerPanelData(); msg("تم حذف المفتاح.", "var(--success-green)"); }
    catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function deleteAllResellerKeys() {
    if (!confirm("حذف كل مفاتيحك؟")) return;
    try { const x = await api("/api/reseller/keys", {method:"DELETE"}); $("newKeysResultBox").classList.add("hidden"); await loadResellerPanelData(); msg("تم حذف " + x.deleted + " مفتاح.", "var(--success-green)"); }
    catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function loadAdminDashboard() {
    const all = await Promise.all([api("/api/admin/overview"), api("/api/admin/resellers"), api("/api/admin/settings")]);
    const overview = all[0], settings = all[2];
    resellers = all[1].resellers || [];
    $("statResellers").textContent = overview.resellers || 0;
    $("statKeys").textContent = overview.keys || 0;
    $("statBalance").textContent = Number(overview.balance || 0).toFixed(2);
    $("statPrice").textContent = Number(settings.basePrice || 0).toFixed(2);
    $("currentPriceDisplay").textContent = Number(settings.basePrice || 0).toFixed(2);
    $("basePriceInput").value = Number(settings.basePrice || 0).toFixed(2);
    $("totalResellersCount").textContent = resellers.length + " TOTAL";
    $("adminResellersTableBody").innerHTML = resellers.length ? resellers.map((r, i) =>
      '<tr><td><input type="checkbox" class="reseller-cb" value="' + safe(r.id) + '"></td><td class="code-text">' + safe(r.label) + '<br><small>' + safe(r.displayCode) + '</small></td><td class="val-green">' + Number(r.balance || 0).toFixed(2) + '</td><td class="val-num">' + Number(r.keysCount || 0) + '</td><td style="text-align:center"><button class="btn-trash" data-act="delres" data-c="' + safe(r.id) + '">حذف</button></td></tr>'
    ).join("") : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">لا يوجد موزعون.</td></tr>';
    $("chargeSelectReseller").innerHTML = '<option value="">اختر الموزع</option>' + resellers.map(r =>
      '<option value="' + safe(r.id) + '">' + safe(r.label) + ' · ' + Number(r.balance || 0).toFixed(2) + '</option>'
    ).join("");
    $("selectAllCb").checked = false;
  }
  async function deleteAllSystemKeys() {
    if (!confirm("حذف جميع مفاتيح النظام؟")) return;
    try { const x = await api("/api/admin/keys", {method:"DELETE"}); await loadAdminDashboard(); msg("تم حذف " + x.deleted + " مفتاح.", "var(--success-green)"); }
    catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function updateBasePrice() {
    if (priceBusy) return;
    const price = Number($("basePriceInput").value);
    if (!Number.isFinite(price) || price < 0) return msg("أدخل سعراً صالحاً.", "var(--danger-red)");
    priceBusy = true;
    $("updatePriceBtn").disabled = true;
    try {
      const data = await api("/api/admin/settings", {method:"PATCH", body:JSON.stringify({price})});
      $("currentPriceDisplay").textContent = Number(data.basePrice).toFixed(2);
      $("statPrice").textContent = Number(data.basePrice).toFixed(2);
      msg("تم تحديث السعر.", "var(--success-green)");
    } catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
    finally { priceBusy = false; $("updatePriceBtn").disabled = false; }
  }
  async function addNewReseller() {
    const code = $("addResellerCode").value.trim().toUpperCase();
    const balance = Number($("addResellerBal").value);
    if (!code) return msg("أدخل رمز الموزع.", "var(--danger-red)");
    if (!Number.isFinite(balance) || balance < 0) return msg("الرصيد غير صالح.", "var(--danger-red)");
    try {
      const data = await api("/api/admin/resellers", {method:"POST", body:JSON.stringify({code, label:code, balance})});
      await loadAdminDashboard();
      $("addResellerCode").value = "";
      $("addResellerBal").value = "10";
      await copyText(data.accessCode);
      msg("تم إنشاء الموزع. رمز الدخول: " + data.accessCode, "var(--success-green)");
    } catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function chargeResellerBalance(action) {
    const id = $("chargeSelectReseller").value;
    const amount = Number($("chargeAmount").value);
    if (!id || !Number.isFinite(amount) || amount <= 0) return msg("اختر موزعاً وأدخل مبلغاً.", "var(--danger-red)");
    try {
      await api("/api/admin/resellers/" + encodeURIComponent(id) + "/balance", {method:"PATCH", body:JSON.stringify({amount, action})});
      $("chargeAmount").value = "";
      await loadAdminDashboard();
      msg("تم تحديث الرصيد.", "var(--success-green)");
    } catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function deleteReseller(id) {
    if (!confirm("حذف الموزع وكل مفاتيحه؟")) return;
    try { await api("/api/admin/resellers/" + encodeURIComponent(id), {method:"DELETE"}); await loadAdminDashboard(); msg("تم حذف الموزع.", "var(--success-green)"); }
    catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  function toggleSelectAll(master) {
    document.querySelectorAll(".reseller-cb").forEach(cb => { cb.checked = master.checked; });
  }
  async function deleteSelectedResellers() {
    const ids = Array.from(document.querySelectorAll(".reseller-cb:checked")).map(cb => cb.value);
    if (!ids.length) return msg("حدد موزعاً أولاً.", "var(--danger-red)");
    if (!confirm("حذف " + ids.length + " موزع؟")) return;
    try {
      for (const id of ids) await api("/api/admin/resellers/" + encodeURIComponent(id), {method:"DELETE"});
      await loadAdminDashboard();
      msg("تم حذف الموزعين المحددين.", "var(--success-green)");
    } catch (e) { msg("خطأ: " + e.message, "var(--danger-red)"); }
  }
  async function copyText(value) {
    try { await navigator.clipboard.writeText(String(value || "")); msg("تم النسخ.", "var(--success-green)"); }
    catch {
      const area = document.createElement("textarea");
      area.value = String(value || ""); area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {}
      area.remove(); msg(ok ? "تم النسخ." : "تعذر النسخ.", ok ? "var(--success-green)" : "var(--danger-red)");
    }
  }
  function shareKey(key) {
    copyText(key);
  }
  document.addEventListener("click", event => {
    const control = event.target.closest("[data-ui-click]");
    if (!control) return;
    const action = control.dataset.uiClick;
    if (action === "toggleAccordion") toggleAccordion(control);
    else if (action === "chargeAdd") chargeResellerBalance("add");
    else if (action === "chargeDeduct") chargeResellerBalance("deduct");
    else if (typeof window[action] === "function") window[action]();
  });
  document.addEventListener("change", event => {
    const control = event.target.closest('[data-ui-change="toggleSelectAll"]');
    if (control) toggleSelectAll(control);
  });
  document.addEventListener("click", event => {
    const el = event.target.closest("[data-act]");
    if (!el) return;
    if (el.dataset.act === "copykey") copyText(el.dataset.k);
    else if (el.dataset.act === "sharekey") {
      const modal = $("shareKeyModal");
      modal.dataset.key = el.dataset.k || "";
      modal.classList.remove("hidden");
    }
    else if (el.dataset.act === "close-share") $("shareKeyModal").classList.add("hidden");
    else if (el.dataset.act === "shareplatform") {
      const modal = $("shareKeyModal");
      const key = modal.dataset.key || "";
      if (!key) { msg("لم يتم تحديد كود للمشاركة.", "var(--danger-red)"); return; }
      const message = "الكود الخاص بك: " + key;
      const platform = el.dataset.platform;
      let url = "";
      if (platform === "telegram") url = "https://t.me/share/url?url=&text=" + encodeURIComponent(message);
      else if (platform === "whatsapp") url = "https://wa.me/?text=" + encodeURIComponent(message);
      else if (platform === "instagram") url = "https://www.instagram.com/direct/inbox/";
      else if (platform === "tiktok") url = "https://www.tiktok.com/messages";
      if (!url) return;
      window.open(url, "_blank", "noopener,noreferrer");
      if (platform === "instagram" || platform === "tiktok") copyText(key);
      modal.classList.add("hidden");
    }
    else if (el.dataset.act === "copyall") {
      const codes = Array.from(document.querySelectorAll('#newKeysListContent [data-act="copykey"]'))
        .map(button => button.dataset.k).filter(Boolean);
      if (codes.length) copyText(codes.join(String.fromCharCode(10)));
      else msg("لا توجد مفاتيح لنسخها.", "var(--danger-red)");
    }
    else if (el.dataset.act === "share") shareKey(el.dataset.k);
    else if (el.dataset.act === "delkey") deleteResellerKey(el.dataset.k);
    else if (el.dataset.act === "delres") deleteReseller(el.dataset.c);
  });
  $("resellerInputCode").addEventListener("keydown", e => { if (e.key === "Enter") loginAsReseller(); });
  $("adminInputPass").addEventListener("keydown", e => { if (e.key === "Enter") loginAsAdmin(); });
  refreshResellerMaintenance();
  setInterval(refreshResellerMaintenance, 12000);

  window.toggleAccordion = toggleAccordion;
  window.showAdminLogin = showAdminLogin;
  window.showResellerLogin = showResellerLogin;
  window.loginAsReseller = loginAsReseller;
  window.loginAsAdmin = loginAsAdmin;
  window.logout = logout;
  window.generateKeys = generateKeys;
  window.deleteAllResellerKeys = deleteAllResellerKeys;
  window.deleteAllSystemKeys = deleteAllSystemKeys;
  window.updateBasePrice = updateBasePrice;
  window.addNewReseller = addNewReseller;
  window.chargeResellerBalance = chargeResellerBalance;
  window.toggleSelectAll = toggleSelectAll;
  window.deleteSelectedResellers = deleteSelectedResellers;
})();