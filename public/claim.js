(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const STORAGE_TOKEN = "hax_offerwall_claim_token";
  const STORAGE_URL = "hax_offerwall_claim_url";
  const STORAGE_NAME = "hax_offerwall_claim_name";
  const state = {
    config: null,
    busy: false,
    polling: false,
    pollTimer: null,
    toastTimer: null,
    sessionToken: "",
    shortlinkUrl: ""
  };

  function setStatus(message, type) {
    const el = $("statusMessage");
    el.textContent = message || "";
    el.className = "status-message" + (type ? " " + type : "");
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function setBusy(value) {
    state.busy = value;
    $("createButton").disabled = value || !state.config?.ready || Boolean(state.sessionToken);
    $("buttonText").textContent = value ? "جارٍ تجهيز مهمة الاختصار…" : "ابدأ مهمة الاختصار";
  }

  function clearSavedSession() {
    sessionStorage.removeItem(STORAGE_TOKEN);
    sessionStorage.removeItem(STORAGE_URL);
    sessionStorage.removeItem(STORAGE_NAME);
    state.sessionToken = "";
    state.shortlinkUrl = "";
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function showTask(data, restore) {
    state.sessionToken = data.sessionToken || state.sessionToken;
    state.shortlinkUrl = data.shortlinkUrl || state.shortlinkUrl;
    $("campaignName").textContent = data.campaignName || "رابط مختصر";
    $("campaignReward").textContent = "مفتاح HAX واحد بعد تأكيد الإكمال من المنصة";
    $("taskPanel").hidden = false;
    $("resultPanel").hidden = true;
    $("claimForm").classList.add("form-complete");
    $("createButton").disabled = true;
    if (!restore) {
      $("waitingMessage").textContent = "افتح الرابط المختصر وأكمل المهمة، ثم ارجع إلى هذه الصفحة.";
      setStatus("تم تجهيز المهمة. لن يصدر المفتاح قبل وصول تأكيد الإكمال.", "success");
    }
    startPolling();
  }

  async function initialize() {
    $("createButton").disabled = true;
    try {
      const response = await fetch("/api/public/gateway-config", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
      });
      const config = await response.json().catch(() => ({}));
      if (!response.ok || !config.ready) {
        $("buttonText").textContent = "الخدمة غير جاهزة حالياً";
        setStatus(config.error || "لم تكتمل إعدادات Offerwall.me على السيرفر بعد.", "error");
        return;
      }
      state.config = config;
      $("createButton").disabled = false;
      $("buttonText").textContent = "ابدأ مهمة الاختصار";
      setStatus("البوابة جاهزة. اضغط لبدء مهمة الاختصار.", "success");

      const savedToken = sessionStorage.getItem(STORAGE_TOKEN) || "";
      const savedUrl = sessionStorage.getItem(STORAGE_URL) || "";
      const savedName = sessionStorage.getItem(STORAGE_NAME) || "";
      if (savedToken && savedUrl) {
        showTask({ sessionToken: savedToken, shortlinkUrl: savedUrl, campaignName: savedName }, true);
        pollStatus();
      }
    } catch (error) {
      $("buttonText").textContent = "تعذر الاتصال بالخادم";
      setStatus(error.message || "تعذر الاتصال بالخادم. حاول مجدداً.", "error");
    }
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const field = document.createElement("textarea");
        field.value = value;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        const ok = document.execCommand("copy");
        field.remove();
        if (!ok) throw new Error("copy_failed");
      }
      toast("تم النسخ بنجاح");
    } catch (_) {
      toast("تعذر النسخ تلقائياً. اضغط مطولاً على النص لنسخه.");
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (state.busy) return;
    if (state.sessionToken) {
      setStatus("لديك مهمة مفتوحة بالفعل. أكملها أو انتظر تأكيدها قبل بدء مهمة أخرى.", "error");
      $("taskPanel").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!state.config?.ready) {
      setStatus("الخدمة غير مفعّلة على الخادم بعد.", "error");
      return;
    }

    setBusy(true);
    setStatus("يتم الآن البحث عن مهمة اختصار متاحة لبلدك…", "");
    $("taskPanel").hidden = true;
    $("resultPanel").hidden = true;

    try {
      const response = await fetch("/api/public/claim/start", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.sessionToken || !data.shortlinkUrl) {
        throw new Error(data.error || "تعذر تجهيز مهمة الاختصار.");
      }
      const target = new URL(data.shortlinkUrl);
      if (target.protocol !== "https:" || !(target.hostname === "offerwall.me" || target.hostname.endsWith(".offerwall.me"))) {
        throw new Error("رابط المهمة غير صالح؛ لم يتم حفظ الجلسة.");
      }
      sessionStorage.setItem(STORAGE_TOKEN, data.sessionToken);
      sessionStorage.setItem(STORAGE_URL, target.toString());
      sessionStorage.setItem(STORAGE_NAME, data.campaignName || "رابط مختصر");
      showTask(data, false);
    } catch (error) {
      setStatus(error.message || "حدث خطأ. حاول مجدداً.", "error");
      setBusy(false);
    }
  }

  function openShortlink() {
    if (!state.shortlinkUrl) {
      toast("ابدأ مهمة جديدة أولاً.");
      return;
    }
    const opened = window.open(state.shortlinkUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      toast("المتصفح منع فتح تبويب جديد. اسمح بالنوافذ المنبثقة لهذا الموقع أو افتح الرابط من جديد.");
      return;
    }
    $("waitingMessage").textContent = "تم فتح المهمة. أكمل الرابط المختصر ثم ارجع إلى تبويب HAX.";
    startPolling();
  }

  async function pollStatus() {
    if (!state.sessionToken || state.polling) return;
    state.polling = true;
    try {
      const response = await fetch("/api/public/claim/status", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ sessionToken: state.sessionToken })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 404 || data.state === "expired") {
        clearSavedSession();
        $("taskPanel").hidden = true;
        $("claimForm").classList.remove("form-complete");
        $("createButton").disabled = !state.config?.ready;
        setStatus(data.error || "انتهت جلسة المهمة. ابدأ من جديد.", "error");
        return;
      }
      if (!response.ok) throw new Error(data.error || "تعذر التحقق من حالة المهمة.");
      if (data.state === "completed" && data.key) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        $("issuedKey").textContent = data.key;
        $("taskPanel").hidden = true;
        $("resultPanel").hidden = false;
        $("claimForm").classList.remove("form-complete");
        $("resultPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
        setStatus("وصل إشعار الإكمال وتم إصدار مفتاحك بنجاح.", "success");
        clearSavedSession();
        $("createButton").disabled = false;
        return;
      }
      if (data.state === "reversed") {
        clearSavedSession();
        $("waitingMessage").textContent = data.error || "تم عكس عملية المكافأة.";
        setStatus("لم يعد بالإمكان إصدار المفتاح لهذه العملية.", "error");
        $("createButton").disabled = !state.config?.ready;
      } else {
        $("waitingMessage").textContent = "لم يصل تأكيد الإكمال بعد. أكمل المهمة في التبويب الآخر ثم عُد إلى هنا.";
      }
    } catch (_) {
      $("waitingMessage").textContent = "تعذر تحديث الحالة الآن. ستتم إعادة المحاولة تلقائياً.";
    } finally {
      state.polling = false;
    }
  }

  function startPolling() {
    if (!state.sessionToken || state.pollTimer) return;
    pollStatus();
    state.pollTimer = setInterval(pollStatus, 7000);
  }

  $("claimForm").addEventListener("submit", submitForm);
  $("openShortlinkButton").addEventListener("click", openShortlink);
  $("checkStatusButton").addEventListener("click", () => {
    $("waitingMessage").textContent = "جارٍ التحقق من تأكيد المنصة…";
    pollStatus();
  });
  $("copyKeyButton").addEventListener("click", () => {
    const key = $("issuedKey").textContent.trim();
    if (key && key !== "—") copyText(key);
  });
  $("createAnotherButton").addEventListener("click", () => {
    clearSavedSession();
    $("resultPanel").hidden = true;
    $("taskPanel").hidden = true;
    $("claimForm").classList.remove("form-complete");
    $("createButton").disabled = !state.config?.ready;
    setStatus("يمكنك الآن بدء مهمة جديدة.", "success");
    $("createButton").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.sessionToken) pollStatus();
  });
  window.addEventListener("pageshow", () => {
    if (state.sessionToken) pollStatus();
  });

  initialize();
})();