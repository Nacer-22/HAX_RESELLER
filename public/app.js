(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const apiBase = String(window.HAX_RESELLER_CONFIG?.API_BASE_URL || "").replace(/\/+$/, "");
  let token = "";
  let loginRole = "admin";
  let currentResellers = [];
  let toastTimer;

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", "Bearer " + token);
    const response = await fetch(apiBase + path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "تعذر إكمال الطلب.");
    return data;
  }
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function showView(id) {
    ["loginView", "adminView", "resellerView"].forEach(key => $(key).classList.toggle("hidden", key !== id));
  }
  function setRole(role) {
    loginRole = role;
    document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.role === role));
    $("loginLabel").textContent = role === "admin" ? "اسم المدير" : "رمز الموزّع";
    $("loginIdentity").placeholder = role === "admin" ? "اسم المستخدم" : "HAX-R-...";
    $("loginIdentity").autocomplete = role === "admin" ? "username" : "off";
    $("secretLabel").classList.toggle("hidden", role !== "admin");
    $("loginSecret").classList.toggle("hidden", role !== "admin");
    $("loginSecret").required = role === "admin";
  }
  document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => setRole(button.dataset.role)));

  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("loginMessage").textContent = "جارٍ التحقق...";
    try {
      const data = loginRole === "admin"
        ? await api("/api/auth/admin/login", { method: "POST", body: JSON.stringify({ username: $("loginIdentity").value.trim(), password: $("loginSecret").value }) })
        : await api("/api/auth/reseller/login", { method: "POST", body: JSON.stringify({ code: $("loginIdentity").value.trim() }) });
      token = data.token;
      $("loginMessage").textContent = "";
      if (data.role === "admin") {
        showView("adminView");
        await loadAdmin();
      } else {
        showView("resellerView");
        await loadReseller();
      }
    } catch (error) {
      $("loginMessage").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  async function loadAdmin() {
    const [overview, list] = await Promise.all([api("/api/admin/overview"), api("/api/admin/resellers")]);
    currentResellers = list.resellers;
    $("statResellers").textContent = overview.resellers;
    $("statKeys").textContent = overview.keys;
    $("statActive").textContent = overview.activeKeys;
    $("statBalance").textContent = Number(overview.balance).toFixed(2);
    $("resellerRows").innerHTML = currentResellers.length ? currentResellers.map(item => `
      <tr><td>${escapeHtml(item.label)}</td><td><code>${escapeHtml(item.displayCode)}</code></td><td>${Number(item.balance).toFixed(2)}</td><td>${item.keysCount}</td><td><button class="btn danger small" data-delete-reseller="${escapeHtml(item.id)}">حذف</button></td></tr>
    `).join("") : '<tr><td colspan="5" class="muted center">لا يوجد موزعون حالياً.</td></tr>';
    $("balanceReseller").innerHTML = '<option value="">اختر موزعاً</option>' + currentResellers.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${Number(item.balance).toFixed(2)}</option>`).join("");
  }
  $("addResellerForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = await api("/api/admin/resellers", { method: "POST", body: JSON.stringify({ label: $("newResellerLabel").value, balance: Number($("newResellerBalance").value) }) });
      $("newResellerResult").classList.remove("hidden");
      $("newResellerResult").innerHTML = '<b>تم إنشاء الحساب.</b><br>رمز الدخول يظهر مرة واحدة، انسخه واحتفظ به بأمان:<br><code id="oneTimeCode">' + escapeHtml(data.accessCode) + '</code><br><button class="btn ghost small" id="copyOneTimeCode" type="button">نسخ الرمز</button>';
      $("copyOneTimeCode").addEventListener("click", () => copyText(data.accessCode));
      $("addResellerForm").reset();
      $("newResellerBalance").value = "10";
      await loadAdmin();
      toast("تم إنشاء حساب الموزع.");
    } catch (error) { toast(error.message); }
  });
  $("balanceForm").addEventListener("submit", async event => {
    event.preventDefault();
    const action = event.submitter?.dataset.action || "add";
    try {
      await api("/api/admin/resellers/" + encodeURIComponent($("balanceReseller").value) + "/balance", {
        method: "PATCH", body: JSON.stringify({ amount: Number($("balanceAmount").value), action })
      });
      $("balanceAmount").value = "";
      await loadAdmin();
      toast(action === "add" ? "تمت إضافة الرصيد." : "تم خصم الرصيد.");
    } catch (error) { toast(error.message); }
  });
  $("resellerRows").addEventListener("click", async event => {
    const button = event.target.closest("[data-delete-reseller]");
    if (!button) return;
    if (!confirm("حذف هذا الموزع وجميع مفاتيحه؟")) return;
    try {
      await api("/api/admin/resellers/" + encodeURIComponent(button.dataset.deleteReseller), { method: "DELETE" });
      await loadAdmin();
      toast("تم حذف الموزع.");
    } catch (error) { toast(error.message); }
  });
  $("deleteAllKeys").addEventListener("click", async () => {
    if (!confirm("هل تريد حذف جميع المفاتيح من النظام؟ لا يمكن التراجع.")) return;
    try {
      const result = await api("/api/admin/keys", { method: "DELETE" });
      await loadAdmin();
      toast("تم حذف " + result.deleted + " مفتاح.");
    } catch (error) { toast(error.message); }
  });
  $("refreshAdmin").addEventListener("click", () => loadAdmin().then(() => toast("تم تحديث البيانات.")).catch(error => toast(error.message)));

  async function loadReseller() {
    const [me, keysData] = await Promise.all([api("/api/reseller/me"), api("/api/reseller/keys")]);
    $("resellerName").textContent = me.label;
    $("myCode").textContent = me.displayCode;
    $("myBalance").textContent = Number(me.balance).toFixed(2);
    $("myKeyCount").textContent = me.keysCount;
    $("myKeyRows").innerHTML = keysData.keys.length ? keysData.keys.map(key => `
      <tr><td><code>${escapeHtml(key.code)}</code></td><td>${escapeHtml(key.durationLabel)}</td><td>${key.devices}</td><td>${escapeHtml(new Date(key.expiresAt).toLocaleString("ar"))}</td><td><button class="btn danger small" data-delete-key="${escapeHtml(key.id)}">حذف</button></td></tr>
    `).join("") : '<tr><td colspan="5" class="muted center">لا توجد مفاتيح بعد.</td></tr>';
  }
  $("generateForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = await api("/api/reseller/keys", { method: "POST", body: JSON.stringify({
        durationMs: $("duration").value, quantity: Number($("quantity").value), devices: Number($("devices").value)
      }) });
      const allCodes = data.keys.map(key => key.code).join("\n");
      $("generatedResult").classList.remove("hidden");
      $("generatedResult").innerHTML = '<b>تم إنشاء ' + data.keys.length + ' مفتاح.</b><br>التكلفة: ' + data.total.toFixed(2) + ' · الرصيد المتبقي: ' + data.balance.toFixed(2) + '<br><code>' + escapeHtml(allCodes).replace(/\n/g, "<br>") + '</code><br><button class="btn ghost small" id="copyGeneratedKeys" type="button">نسخ المفاتيح</button>';
      $("copyGeneratedKeys").addEventListener("click", () => copyText(allCodes));
      await loadReseller();
      toast("تم إنشاء المفاتيح بنجاح.");
    } catch (error) { toast(error.message); }
  });
  $("myKeyRows").addEventListener("click", async event => {
    const button = event.target.closest("[data-delete-key]");
    if (!button || !confirm("حذف هذا المفتاح؟")) return;
    try {
      await api("/api/reseller/keys/" + encodeURIComponent(button.dataset.deleteKey), { method: "DELETE" });
      await loadReseller();
      toast("تم حذف المفتاح.");
    } catch (error) { toast(error.message); }
  });
  $("deleteMyKeys").addEventListener("click", async () => {
    if (!confirm("حذف جميع مفاتيحك؟ لا يمكن التراجع.")) return;
    try {
      const result = await api("/api/reseller/keys", { method: "DELETE" });
      await loadReseller();
      toast("تم حذف " + result.deleted + " مفتاح.");
    } catch (error) { toast(error.message); }
  });
  $("refreshReseller").addEventListener("click", () => loadReseller().then(() => toast("تم تحديث البيانات.")).catch(error => toast(error.message)));

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); toast("تم النسخ."); }
    catch { toast("تعذر النسخ التلقائي؛ حدّد النص وانسخه يدوياً."); }
  }
  document.querySelectorAll(".logout").forEach(button => button.addEventListener("click", () => {
    token = "";
    $("loginForm").reset();
    $("loginMessage").textContent = "";
    $("newResellerResult").classList.add("hidden");
    $("generatedResult").classList.add("hidden");
    showView("loginView");
  }));
  setRole("admin");
  showView("loginView");
})();
