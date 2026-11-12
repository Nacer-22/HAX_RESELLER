(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const cfg = window.HAX_SITE_CONFIG || {};
  const apiBase = String(cfg.API_BASE_URL || "").replace(/\/+$/, "");
  let token = "";
  let activeResellerCode = "";
  let messageTimer = null;
  let busy = false;

  async function api(path, options = {}) {
    if (!apiBase && location.hostname.endsWith("github.io")) {
      throw new Error("واجهة الموقع جاهزة، لكن خادم HAX_RESELLER لم يُربط بعد. اضبط API_BASE_URL في assets/config.js.");
    }
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", "Bearer " + token);
    const response = await fetch(apiBase + path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  function showMsg(message, color) {
    const element = $("msg");
    if (!element) return;
    element.style.color = color || "var(--accent-glow)";
    element.textContent = message;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { element.textContent = ""; }, 4500);
  }

  function toggleAccordion(header) {
    if (!header) return;
    header.classList.toggle("active");
    const content = header.nextElementSibling;
    if (content) content.classList.toggle("show");
  }

  function showAdminLogin() {
    $("resellerLoginView").classList.add("hidden");
    $("adminLoginView").classList.remove("hidden");
  }

  function showResellerLogin() {
    $("adminLoginView").classList.add("hidden");
    $("resellerLoginView").classList.remove("hidden");
  }

  function showAdminPanel() {
    $("resellerPanel").classList.add("hidden");
    $("adminLoginView").classList.add("hidden");
    $("resellerLoginView").classList.add("hidden");
    $("adminPanel").classList.remove("hidden");
  }

  function showResellerPanel() {
    $("adminPanel").classList.add("hidden");
    $("adminLoginView").classList.add("hidden");
    $("resellerLoginView").classList.add("hidden");
    $("resellerPanel").classList.remove("hidden");
  }

  async function loginAsReseller() {
    const code = String($("resellerInputCode").value || "").trim().toUpperCase();
    if (!code) return showMsg("⚠ Enter your reseller code.", "var(--danger-red)");
    showMsg("⏳ Checking reseller code...");
    try {
      const result = await api("/api/auth/reseller/login", {
        method: "POST", body: JSON.stringify({ code })
      });
      token = result.token;
      activeResellerCode = code;
      showResellerPanel();
      await loadResellerPanelData();
      showMsg("✅ Welcome.", "var(--success-green)");
    } catch (error) {
      showMsg("❌ " + error.message, "var(--danger-red)");
    }
  }

  async function loginAsAdmin() {
    const username = String($("adminInputUser")?.value || "").trim();
    const password = String($("adminInputPass").value || "");
    if (!username || !password) return showMsg("⚠ Enter admin username and password.", "var(--danger-red)");
    showMsg("⏳ Signing in...");
    try {
      const result = await api("/api/auth/admin/login", {
        method: "POST", body: JSON.stringify({ username, password })
      });
      token = result.token;
      showAdminPanel();
      await loadAdminDashboard();
      showMsg("✅ Admin access granted.", "var(--success-green)");
    } catch (error) {
      showMsg("❌ " + error.message, "var(--danger-red)");
    }
  }

  function logout() {
    token = "";
    activeResellerCode = "";
    $("resellerInputCode").value = "";
    $("adminInputUser").value = "";
    $("adminInputPass").value = "";
    $("newKeysResultBox").classList.add("hidden");
    $("newKeysListContent").innerHTML = "";
    $("resellerPanel").classList.add("hidden");
    $("adminPanel").classList.add("hidden");
    $("adminLoginView").classList.add("hidden");
    $("resellerLoginView").classList.remove("hidden");
    showMsg("Logged out.");
  }

  async function loadResellerPanelData() {
    const values = await Promise.all([
      api("/api/reseller/me"), api("/api/reseller/keys")
    ]);
    const me = values[0];
    const keys = values[1].keys || [];
    $("resellerDisplayCode").textContent = activeResellerCode || me.displayCode;
    $("resellerDisplayBalance").textContent = Number(me.balance).toFixed(2);
    $("resellerKeysCountBadge").textContent = keys.length;
    const box = $("resellerKeysList");
    if (!keys.length) {
      box.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:.8rem;">No keys created yet</div>';
      return;
    }
    box.innerHTML = keys.map((key, index) =>
      '<div style="background:rgba(10,13,20,.9);border:1px solid var(--card-border);padding:12px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
        '<div style="min-width:0;"><div class="code-text" style="color:var(--accent-glow);"><span style="color:var(--text-muted);font-size:.75rem;">#' + (index + 1) + '</span> ' + escapeHtml(key.code) + '</div>' +
        '<div style="font-size:.7rem;color:var(--text-muted);">' + escapeHtml(key.durationLabel) + ' | 📱 Devices: ' + escapeHtml(key.devices) + ' <span style="color:var(--success-green);font-weight:700;">[READY]</span></div></div>' +
        '<div style="display:flex;gap:6px;align-items:center;"><button class="btn-share-vibrant" data-act="share" data-k="' + escapeHtml(key.code) + '" data-d="' + escapeHtml(key.durationLabel) + '" data-v="' + escapeHtml(key.devices) + '">📲 SHARE</button>' +
        '<button class="btn-trash" data-act="delkey" data-id="' + escapeHtml(key.id) + '">🗑</button></div></div>'
    ).join("");
  }

  async function generateKeys() {
    if (busy) return;
    const durationMs = Number($("keyDurationSelect").value);
    const devices = Number($("keyMaxDevicesSelect").value);
    const quantity = Number.parseInt($("keyQuantityInput").value, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return showMsg("⚠ Quantity must be between 1 and 10.", "var(--danger-red)");
    }
    busy = true;
    const button = $("generateBtn");
    button.disabled = true;
    showMsg("⏳ Generating keys...");
    try {
      const result = await api("/api/reseller/keys", {
        method: "POST",
        body: JSON.stringify({ durationMs, quantity, devices })
      });
      const keys = result.keys || [];
      $("newKeysCountNum").textContent = keys.length;
      $("newKeysListContent").innerHTML = keys.map((key, index) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;background:rgba(3,4,7,.9);padding:10px 14px;border-radius:10px;border:1px solid rgba(0,230,118,.3);">' +
          '<div style="min-width:0;"><span style="font-size:.75rem;color:var(--text-muted);">#' + (index + 1) + '</span> <span class="code-text" style="color:var(--success-green);">' + escapeHtml(key.code) + '</span></div>' +
          '<button class="btn-share-vibrant" data-act="share" data-k="' + escapeHtml(key.code) + '" data-d="' + escapeHtml(key.durationLabel) + '" data-v="' + escapeHtml(key.devices) + '">📲 SHARE</button></div>'
      ).join("");
      $("newKeysResultBox").classList.remove("hidden");
      await loadResellerPanelData();
      showMsg("✅ Keys generated successfully.", "var(--success-green)");
    } catch (error) {
      showMsg("❌ " + error.message, "var(--danger-red)");
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  async function deleteResellerKey(id) {
    if (!id || !confirm("Delete this key?")) return;
    try {
      await api("/api/reseller/keys/" + encodeURIComponent(id), { method: "DELETE" });
      await loadResellerPanelData();
      showMsg("✅ Key deleted.", "var(--success-green)");
    } catch (error) { showMsg("❌ " + error.message, "var(--danger-red)"); }
  }

  async function deleteAllResellerKeys() {
    if (!confirm("Delete all your keys? This cannot be undone.")) return;
    try {
      const result = await api("/api/reseller/keys", { method: "DELETE" });
      $("newKeysResultBox").classList.add("hidden");
      await loadResellerPanelData();
      showMsg("✅ Deleted " + result.deleted + " keys.", "var(--success-green)");
    } catch (error) { showMsg("❌ " + error.message, "var(--danger-red)"); }
  }

  async function loadAdminDashboard() {
    const values = await Promise.all([
      api("/api/admin/overview"), api("/api/admin/resellers")
    ]);
    const overview = values[0];
    currentResellers = Array.isArray(values[1].resellers) ? values[1].resellers : [];
    $("statResellers").textContent = overview.resellers;
    $("statKeys").textContent = overview.keys;
    $("statBalance").textContent = Number(overview.balance).toFixed(2);
    $("statPrice").textContent = overview.activeKeys;
    $("totalResellersCount").textContent = currentResellers.length + " TOTAL";
    const tbody = $("adminResellersTableBody");
    tbody.innerHTML = currentResellers.length ? currentResellers.map(item =>
      '<tr><td><input type="checkbox" class="reseller-cb" value="' + escapeHtml(item.id) + '"></td>' +
      '<td class="code-text">' + escapeHtml(item.label) + '<br><small>' + escapeHtml(item.displayCode) + '</small></td>' +
      '<td class="val-green">' + Number(item.balance).toFixed(2) + '</td><td class="val-num">' + Number(item.keysCount || 0) + '</td>' +
      '<td style="text-align:center"><button class="btn-trash" data-act="delres" data-id="' + escapeHtml(item.id) + '">🗑</button></td></tr>'
    ).join("") : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No resellers yet.</td></tr>';
    $("chargeSelectReseller").innerHTML = '<option value="">Select Reseller</option>' + currentResellers.map(item =>
      '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + ' · ' + Number(item.balance).toFixed(2) + '</option>'
    ).join("");
    $("selectAllCb").checked = false;
  }

  async function addNewReseller() {
    const label = String($("addResellerName").value || "").trim();
    const balance = Number($("addResellerBal").value);
    if (!label) return showMsg("⚠ Enter a reseller name.", "var(--danger-red)");
    if (!Number.isFinite(balance) || balance < 0) return showMsg("⚠ Enter a valid balance.", "var(--danger-red)");
    try {
      const result = await api("/api/admin/resellers", {
        method: "POST", body: JSON.stringify({ label, balance })
      });
      showMsg("✅ Reseller created. One-time access code: " + result.accessCode, "var(--success-green)");
      await copyText(result.accessCode);
      $("addResellerName").value = "";
      $("addResellerBal").value = "10";
      await loadAdminDashboard();
    } catch (error) { showMsg("❌ " + error.message, "var(--danger-red)"); }
  }

  async function chargeResellerBalance(action) {
    const id = $("chargeSelectReseller").value;
    const amount = Number($("chargeAmount").value);
    if (!id || !Number.isFinite(amount) || amount <= 0) {
      return showMsg("⚠ Select a reseller and enter a valid amount.", "var(--danger-red)");
    }
    try {
      await api("/api/admin/resellers/" + encodeURIComponent(id) + "/balance", {
        method: "PATCH", body: JSON.stringify({ amount, action })
      });
      $("chargeAmount").value = "";
      await loadAdminDashboard();
      showMsg(action === "add" ? "✅ Balance added." : "✅ Balance deducted.", "var(--success-green)");
    } catch (error) { showMsg("❌ " + error.message, "var(--danger-red)"); }
  }

  async function deleteReseller(id) {
    if (!id || !confirm("Delete this reseller and all their keys?")) return;
    try {
      await api("/api/admin/resellers/" + encodeURIComponent(id), { method: "DELETE" });
      await loadAdminDashboard();
      showMsg("✅ Reseller deleted.", "var(--success-green)");
    } catch (error) { showMsg("❌ " + error.message, "var(--danger-red)"); }
  }

  async function deleteAllSystemKeys() {
    if (!confirm("Delete every key in the system? This cannot be undone.")) return;
    try {
      const result = await api("/api/admin/keys", { method: "DELETE" });
      await loadAdminDashboard();
      showMsg("✅ Deleted " + result.deleted + " keys.", "var(--success-green)");
    } catch (error) { showMsg("❌ " + error.message, "var(--danger-red)"); }
  }

  function toggleSelectAll(input) {
    document.querySelectorAll(".reseller-cb").forEach(box => { box.checked = input.checked; });
  }

  async function deleteSelectedResellers() {
    const selected = Array.from(document.querySelectorAll(".reseller-cb:checked")).map(input => input.value);
    if (!selected.length) return showMsg("⚠ Select at least one reseller.", "var(--danger-red)");
    if (!confirm("Delete " + selected.length + " selected resellers?")) return;
    try {
      for (const id of selected) {
        await api("/api/admin/resellers/" + encodeURIComponent(id), { method: "DELETE" });
      }
      await loadAdminDashboard();
      showMsg("✅ Selected resellers deleted.", "var(--success-green)");
    } catch (error) { showMsg("❌ " + error.message, "var(--danger-red)"); }
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      showMsg("✅ Copied.", "var(--success-green)");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        if (document.execCommand("copy")) showMsg("✅ Copied.", "var(--success-green)");
        else showMsg("Copy failed.", "var(--danger-red)");
      } catch { showMsg("Copy failed.", "var(--danger-red)"); }
      textarea.remove();
    }
  }

  function shareKey(key, duration, devices) {
    const message = "🔥 HAX_NON_ROOT 🔥\n\n🔑 Key: " + key +
      "\n⏱ Duration: " + duration + "\n📱 Allowed Devices: " + devices +
      "\n\nEnjoy your access!";
    copyText(message);
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    if (button.dataset.act === "share") shareKey(button.dataset.k, button.dataset.d, button.dataset.v);
    if (button.dataset.act === "delkey") deleteResellerKey(button.dataset.id);
    if (button.dataset.act === "delres") deleteReseller(button.dataset.id);
  });

  window.toggleAccordion = toggleAccordion;
  window.showAdminLogin = showAdminLogin;
  window.showResellerLogin = showResellerLogin;
  window.loginAsReseller = loginAsReseller;
  window.loginAsAdmin = loginAsAdmin;
  window.logout = logout;
  window.generateKeys = generateKeys;
  window.deleteAllResellerKeys = deleteAllResellerKeys;
  window.deleteAllSystemKeys = deleteAllSystemKeys;
  window.addNewReseller = addNewReseller;
  window.chargeResellerBalance = chargeResellerBalance;
  window.toggleSelectAll = toggleSelectAll;
  window.deleteSelectedResellers = deleteSelectedResellers;
})();