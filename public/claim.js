(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const state = {
    config: null,
    captchaToken: "",
    widgetId: null,
    busy: false,
    toastTimer: null
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
    $("createButton").disabled = value || !state.config?.ready || !state.captchaToken;
    $("buttonText").textContent = value ? "جارٍ إنشاء الرابط والمفتاح…" : "اختصر الرابط وأنشئ المفتاح";
  }

  function resetCaptcha() {
    state.captchaToken = "";
    if (window.turnstile && state.widgetId !== null) {
      try { window.turnstile.reset(state.widgetId); } catch (_) {}
    }
    setBusy(false);
    $("captchaHint").textContent = "أكمل اختبار الحماية لتفعيل زر الإنشاء.";
  }

  function loadTurnstile(siteKey) {
    return new Promise((resolve, reject) => {
      if (window.turnstile) return resolve();
      const existing = document.querySelector('script[data-turnstile-loader="1"]');
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.turnstileLoader = "1";
      script.onload = resolve;
      script.onerror = () => reject(new Error("تعذر تحميل خدمة Cloudflare. تحقق من الاتصال ثم أعد تحميل الصفحة."));
      document.head.appendChild(script);
    });
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
      if (!response.ok || !config.ready || !config.siteKey) {
        $("captchaHint").textContent = "البوابة غير مفعّلة بعد. على صاحب الموقع إضافة مفاتيح ShrinkMe وCloudflare في Railway.";
        setStatus(config.error || "الخدمة قيد الإعداد. لم يتم إصدار أي مفتاح.", "error");
        return;
      }
      state.config = config;
      await loadTurnstile(config.siteKey);
      state.widgetId = window.turnstile.render("#turnstileWidget", {
        sitekey: config.siteKey,
        theme: "dark",
        size: "flexible",
        callback: token => {
          state.captchaToken = String(token || "");
          $("captchaHint").textContent = state.captchaToken ? "تم اجتياز اختبار الحماية." : "أكمل اختبار الحماية.";
          setBusy(false);
        },
        "expired-callback": resetCaptcha,
        "error-callback": () => {
          resetCaptcha();
          $("captchaHint").textContent = "تعذر إكمال الاختبار. أعد المحاولة.";
        }
      });
      $("captchaHint").textContent = "أكمل اختبار الحماية لتفعيل زر الإنشاء.";
    } catch (error) {
      $("captchaHint").textContent = "تعذر تحميل الحماية حالياً.";
      setStatus(error.message || "تعذر الاتصال بالخادم.", "error");
    }
  }

  function validateUrl(value) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function validateAlias(value) {
    return !value || /^[A-Za-z0-9_-]{1,30}$/.test(value);
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

  function showResult(data) {
    $("shortUrlText").textContent = data.shortUrl;
    $("shortUrlText").href = data.shortUrl;
    $("issuedKey").textContent = data.key;
    $("resultPanel").hidden = false;
    $("resultPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    setStatus("تم إصدار مفتاح واحد بنجاح.", "success");
  }

  async function submitForm(event) {
    event.preventDefault();
    if (state.busy) return;

    const longUrl = $("longUrl").value.trim();
    const alias = $("alias").value.trim();

    if (!validateUrl(longUrl)) {
      setStatus("أدخل رابطاً صحيحاً يبدأ بـ https:// أو http://.", "error");
      $("longUrl").focus();
      return;
    }
    if (!validateAlias(alias)) {
      setStatus("الاسم المختصر غير صالح. استخدم حروفاً إنجليزية وأرقاماً و- و_.", "error");
      $("alias").focus();
      return;
    }
    if (!state.config?.ready) {
      setStatus("الخدمة غير مفعّلة على الخادم بعد.", "error");
      return;
    }
    if (!state.captchaToken) {
      setStatus("أكمل اختبار الحماية أولاً.", "error");
      return;
    }

    setBusy(true);
    setStatus("يتم الآن التحقق واختصار الرابط…", "");
    $("resultPanel").hidden = true;

    try {
      const response = await fetch("/api/public/shorten-and-claim", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ longUrl, alias, captchaToken: state.captchaToken })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true || !data.key || !data.shortUrl) {
        throw new Error(data.error || "تعذر إنشاء الرابط أو المفتاح.");
      }
      showResult(data);
      $("longUrl").value = "";
      $("alias").value = "";
      resetCaptcha();
    } catch (error) {
      setStatus(error.message || "حدث خطأ. حاول مجدداً.", "error");
      resetCaptcha();
    }
  }

  $("claimForm").addEventListener("submit", submitForm);
  $("copyKeyButton").addEventListener("click", () => {
    const key = $("issuedKey").textContent.trim();
    if (key && key !== "—") copyText(key);
  });
  $("copyLinkButton").addEventListener("click", () => {
    const link = $("shortUrlText").href;
    if (link && link !== "#") copyText(link);
  });
  $("createAnotherButton").addEventListener("click", () => {
    $("resultPanel").hidden = true;
    setStatus("أدخل رابطاً جديداً لإنشاء مفتاح آخر.", "");
    $("longUrl").focus();
  });

  initialize();
})();