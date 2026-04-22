(function () {
  if (!window.PriceGuard || !window.PriceGuard.customerLoggedIn) return;

  const proxyBase = window.PriceGuard.proxyBase;

  function formatMoney(amount, currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode || "GBP",
      }).format(Number(amount || 0));
    } catch {
      return `${currencyCode || "GBP"} ${Number(amount || 0).toFixed(2)}`;
    }
  }

  function getProductId() {
    if (window.meta && window.meta.product && window.meta.product.id) {
      return window.meta.product.id;
    }

    const jsonNodes = Array.from(document.querySelectorAll('script[type="application/json"]'));
    for (const node of jsonNodes) {
      try {
        const parsed = JSON.parse(node.textContent || "{}");
        if (parsed && parsed.id && parsed.variants) {
          return parsed.id;
        }
      } catch {}
    }

    const productForm = document.querySelector('form[action*="/cart/add"]');
    if (productForm && productForm.dataset.productid) {
      return productForm.dataset.productid;
    }

    return null;
  }

  async function fetchResolvedPrice(productId) {
    const url = `${proxyBase}?product_id=${encodeURIComponent(productId)}`;
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`Proxy failed with ${res.status}`);
    return res.json();
  }

  function findMainPriceNode() {
    const selectors = [
      ".price-item--regular",
      ".price__regular .price-item",
      ".product__info-container .price-item",
      ".price .price-item",
      "[data-product-price]"
    ];

    return selectors.map((s) => document.querySelector(s)).find(Boolean) || null;
  }

  function renderPrice(data) {
    if (!data || !data.ok || !data.active) return;

    const node = findMainPriceNode();
    if (!node) return;

    const originalText = formatMoney(data.base_price, data.currency_code);
    const finalText = formatMoney(data.final_price, data.currency_code);

    node.textContent = finalText;

    let badge = document.querySelector(".priceguard-tier-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "priceguard-tier-badge";
      node.insertAdjacentElement("afterend", badge);
    }
    badge.textContent = `${data.tier_name} price`;

    if (data.base_price !== data.final_price) {
      let compare = document.querySelector(".priceguard-compare-price");
      if (!compare) {
        compare = document.createElement("div");
        compare.className = "priceguard-compare-price";
        badge.insertAdjacentElement("afterend", compare);
      }
      compare.textContent = `Standard price: ${originalText}`;
    }
  }

  async function init() {
    const productId = getProductId();
    if (!productId) return;

    try {
      const data = await fetchResolvedPrice(productId);
      renderPrice(data);
    } catch (err) {
      console.warn("[PriceGuard] product page pricing failed", err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
