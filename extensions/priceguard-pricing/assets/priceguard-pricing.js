(function () {
  if (!window.PriceGuard || !window.PriceGuard.customerLoggedIn) return;

  const PG = window.PriceGuard;
  const proxyBase = PG.proxyBase;
  let lastAppliedSignature = "";
  let inFlight = false;

  function log(...args) {
    if (PG.debug) console.log("[PriceGuard]", ...args);
  }

  function formatMoney(amount, currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode || "GBP"
      }).format(Number(amount || 0));
    } catch {
      return `${currencyCode || "GBP"} ${Number(amount || 0).toFixed(2)}`;
    }
  }

  function normalizeText(str) {
    return String(str || "").replace(/\s+/g, " ").trim();
  }

  function isLikelyMoneyText(text) {
    const t = normalizeText(text);
    return /[$£€]\s?\d/.test(t) || /\d[\d,.]*\s?(GBP|USD|EUR)/i.test(t);
  }

  function getProductId() {
    if (PG.productId) return String(PG.productId);

    if (window.meta && window.meta.product && window.meta.product.id) {
      return String(window.meta.product.id);
    }

    const productJsonCandidates = [
      document.querySelector('script[type="application/json"][data-product-json]'),
      ...Array.from(document.querySelectorAll('script[type="application/json"]'))
    ].filter(Boolean);

    for (const node of productJsonCandidates) {
      try {
        const parsed = JSON.parse(node.textContent || "{}");
        if (parsed && parsed.id && (parsed.variants || parsed.title || parsed.handle)) {
          return String(parsed.id);
        }
      } catch {}
    }

    const formSelectors = [
      'form[action*="/cart/add"][data-productid]',
      'product-form form[data-productid]',
      'form[action*="/cart/add"]'
    ];

    for (const sel of formSelectors) {
      const form = document.querySelector(sel);
      if (!form) continue;
      if (form.dataset.productid) return String(form.dataset.productid);
      if (form.dataset.productId) return String(form.dataset.productId);
    }

    const input = document.querySelector('input[name="product-id"], input[data-product-id]');
    if (input) return String(input.value || input.dataset.productId || "");

    return null;
  }

  function findPriceCandidates() {
    const selectors = [
      '.product .price__current',
      '.product .price-item--regular',
      '.product .price__regular .price-item',
      '.product .price .price-item',
      '.product__info-container .price-item',
      '.product__info-container .price',
      '.product__info-wrapper .price',
      '.product__info-wrapper .price-item',
      '.product-form__buttons ~ .price',
      '.product-form__submit ~ .price',
      'price-per-item .price-item',
      '.price-item',
      '.price'
    ];

    const nodes = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((node) => {
        if (!node) return;
        if (!document.body.contains(node)) return;
        const text = normalizeText(node.textContent);
        if (!isLikelyMoneyText(text)) return;
        nodes.push(node);
      });
    }

    const unique = Array.from(new Set(nodes));

    unique.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      const aScore = aRect.top + aRect.left;
      const bScore = bRect.top + bRect.left;
      return aScore - bScore;
    });

    return unique;
  }

  function chooseMainPriceNode() {
    const candidates = findPriceCandidates();
    if (!candidates.length) return null;

    const strong = candidates.find((node) =>
      node.closest('.product__info-container, .product__info-wrapper, main, product-info')
    );

    return strong || candidates[0];
  }

  function ensureWrapper(node) {
    let wrap = document.querySelector(".priceguard-price-wrap");
    if (wrap && wrap.contains(node)) return wrap;

    wrap = document.createElement("div");
    wrap.className = "priceguard-price-wrap";

    node.parentNode.insertBefore(wrap, node);
    wrap.appendChild(node);

    return wrap;
  }

  function ensureOriginalNode(wrap, originalText) {
    let el = wrap.querySelector(".priceguard-original-price");
    if (!el) {
      el = document.createElement("div");
      el.className = "priceguard-original-price";
      wrap.appendChild(el);
    }
    el.textContent = originalText;
    return el;
  }

  function ensureBadgeNode(wrap, tierName) {
    let el = wrap.querySelector(".priceguard-tier-badge");
    if (!el) {
      el = document.createElement("div");
      el.className = "priceguard-tier-badge";
      wrap.appendChild(el);
    }
    el.textContent = `${tierName} price`;
    return el;
  }

  function removeInjectedNodes() {
    document.querySelectorAll(".priceguard-original-price, .priceguard-tier-badge").forEach((n) => n.remove());
  }

  function applyResolvedPrice(data) {
    if (!data || !data.ok || !data.active) {
      log("No active resolved price to apply", data);
      return;
    }

    const node = chooseMainPriceNode();
    if (!node) {
      log("Could not find a product price node");
      return;
    }

    const originalText = formatMoney(data.base_price, data.currency_code);
    const finalText = formatMoney(data.final_price, data.currency_code);
    const signature = `${data.product_id}:${data.final_price}:${data.tier_name}`;

    if (lastAppliedSignature === signature) {
      log("Price already applied");
      return;
    }

    log("Applying price", {
      productId: data.product_id,
      base: data.base_price,
      final: data.final_price,
      tier: data.tier_name,
      nodeTextBefore: normalizeText(node.textContent)
    });

    const wrap = ensureWrapper(node);

    if (data.base_price !== data.final_price) {
      ensureOriginalNode(wrap, originalText);
    } else {
      const old = wrap.querySelector(".priceguard-original-price");
      if (old) old.remove();
    }

    ensureBadgeNode(wrap, data.tier_name);

    node.classList.add("priceguard-final-price");
    node.textContent = finalText;

    lastAppliedSignature = signature;
  }

  async function fetchResolvedPrice(productId) {
    const url = `${proxyBase}?product_id=${encodeURIComponent(productId)}`;
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });

    if (!res.ok) {
      throw new Error(`Proxy failed with ${res.status}`);
    }

    const json = await res.json();
    log("Proxy response", json);
    return json;
  }

  async function refreshPrice(reason) {
    if (inFlight) return;
    const productId = getProductId();
    if (!productId) {
      log("No product id found");
      return;
    }

    inFlight = true;
    try {
      log("Refreshing price because:", reason, "productId:", productId);
      const data = await fetchResolvedPrice(productId);
      applyResolvedPrice(data);
    } catch (err) {
      console.warn("[PriceGuard] pricing refresh failed", err);
    } finally {
      inFlight = false;
    }
  }

  function wireVariantListeners() {
    document.addEventListener("change", (event) => {
      const t = event.target;
      if (!t) return;

      if (
        t.matches('select[name="id"]') ||
        t.matches('input[name="id"]') ||
        t.matches('variant-selects select') ||
        t.matches('fieldset input[type="radio"]') ||
        t.closest('variant-selects') ||
        t.closest('product-form')
      ) {
        setTimeout(() => refreshPrice("variant change"), 200);
      }
    });

    document.addEventListener("variant:change", () => {
      setTimeout(() => refreshPrice("variant:change event"), 100);
    });

    document.addEventListener("shopify:section:load", () => {
      setTimeout(() => refreshPrice("section load"), 200);
    });

    const observer = new MutationObserver(() => {
      const node = chooseMainPriceNode();
      if (!node) return;
      if (!document.querySelector(".priceguard-tier-badge")) {
        setTimeout(() => refreshPrice("mutation observer"), 100);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    removeInjectedNodes();
    refreshPrice("init");
    wireVariantListeners();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
