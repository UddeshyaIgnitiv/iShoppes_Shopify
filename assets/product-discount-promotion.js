import { ThemeEvents, CartUpdateEvent } from '@theme/events';
import { fetchConfig } from '@theme/utilities';

/** @param {Response} res */
async function parseCartJson(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data?.description || data?.message || 'request failed');
  const s = data?.status;
  if (s != null && s !== '' && s !== 200 && s !== '200') {
    throw new Error(data.description || data.message || 'cart error');
  }
  return data;
}

/**
 * Cart Ajax: GET /cart.js for discount titles when the variant is already in the cart. If not,
 * optionally POST /cart/add.js then /cart/change.js to read real automatic discount allocations,
 * then restore the cart (see data-preview-discounts). Metafield custom.discount_promotion_text
 * is fallback when preview is off or requests fail.
 */
class ProductDiscountPromotion extends HTMLElement {
  /** @type {AbortController | undefined} */
  #abort;

  connectedCallback() {
    requestAnimationFrame(() => {
      this.#refresh();
    });
    const section = this.closest('.shopify-section, dialog');
    section?.addEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate);
  }

  disconnectedCallback() {
    const section = this.closest('.shopify-section, dialog');
    section?.removeEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate);
    this.#abort?.abort();
  }

  #onVariantUpdate = (event) => {
    const detail = /** @type {CustomEvent} */ (event).detail;
    const productId = detail?.data?.productId;
    if (productId && String(productId) !== this.dataset.productId) return;

    const variantId = detail?.resource?.id;
    if (variantId) this.dataset.variantId = String(variantId);
    this.#refresh();
  };

  async #refresh() {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;

    const productId = this.dataset.productId;
    const variantId = this.dataset.variantId;
    if (!productId || !variantId) return;

    this.dataset.automaticDiscount = 'checking';
    delete this.dataset.discountSource;

    try {
      const cart = await this.#fetchCart(signal);
      console.log('nithincart',cart)
      const lineTitles = this.#titlesFromCart(cart, productId, variantId);
      const cartLevel = cartLevelDiscountTitles(cart);
      let titles = mergeUniqueTitles(lineTitles, cartLevel);

      if (titles.length === 0 && this.#previewDiscountsEnabled() && !this.#hasVariantLine(cart, productId, variantId)) {
        const previewTitles = await this.#previewAutomaticDiscounts(signal, productId, variantId);
        if (previewTitles?.length) titles = previewTitles;
      }

      if (titles.length > 0) {
        const src = 'cart';
        this.dataset.automaticDiscount = 'eligible';
        this.dataset.discountSource = src;
        this.#renderLines(titles, src);
        this.#emitResolved(true, src, titles);
      } else if (this.dataset.fallbackText) {
        this.dataset.automaticDiscount = 'fallback';
        this.dataset.discountSource = 'metafield';
        this.#renderSingle(this.dataset.fallbackText, 'metafield');
        this.#emitResolved(false, 'metafield', []);
      } else if (!this.innerHTML.trim()) {
        this.dataset.automaticDiscount = 'none';
        this.#emitResolved(false, 'none', []);
        this.replaceChildren();
      } else {
        this.dataset.automaticDiscount = 'none';
        this.#emitResolved(false, 'none', []);
        this.replaceChildren();
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        delete this.dataset.automaticDiscount;
        delete this.dataset.discountSource;
        return;
      }
      if (this.dataset.fallbackText) {
        this.dataset.automaticDiscount = 'fallback';
        this.dataset.discountSource = 'metafield';
        this.#renderSingle(this.dataset.fallbackText, 'metafield');
        this.#emitResolved(false, 'metafield', []);
      } else {
        this.dataset.automaticDiscount = 'error';
        this.#emitResolved(false, 'error', []);
      }
    }
  }

  /**
   * @param {boolean} automaticEligible
   * @param {'cart' | 'metafield' | 'none' | 'error'} source
   * @param {string[]} titles
   */
  #emitResolved(automaticEligible, source, titles) {
    this.dispatchEvent(
      new CustomEvent('product-discount-promotion:resolved', {
        bubbles: true,
        detail: { automaticEligible, source, titles },
      })
    );
  }

  /**
   * @param {AbortSignal} signal
   */
  async #fetchCart(signal) {
    const url = this.dataset.cartJsUrl || (globalThis.Theme?.routes?.cart_url ? `${globalThis.Theme.routes.cart_url}.js` : null);
    if (!url) throw new Error('missing cart url');
    const res = await fetch(url, { credentials: 'same-origin', signal });
    return parseCartJson(res);
  }

  #previewDiscountsEnabled() {
    return this.dataset.previewDiscounts !== 'false';
  }

  /**
   * @param {any} cart
   * @param {string} productId
   * @param {string} variantId
   */
  #hasVariantLine(cart, productId, variantId) {
    for (const item of cart.items || []) {
      if (String(item.product_id) === String(productId) && String(item.variant_id) === String(variantId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Temporarily add one unit, read discount titles, remove the line, notify cart UI.
   * @param {AbortSignal} signal
   * @param {string} productId
   * @param {string} variantId
   * @returns {Promise<string[] | null>}
   */
  async #previewAutomaticDiscounts(signal, productId, variantId) {
    const addUrl = globalThis.Theme?.routes?.cart_add_url || this.dataset.cartAddUrl;
    const changeUrl = globalThis.Theme?.routes?.cart_change_url || this.dataset.cartChangeUrl;
    if (!addUrl || !changeUrl) return null;

    const variantIdNum = Number.parseInt(String(variantId), 10);
    if (Number.isNaN(variantIdNum)) return null;

    let lineKey = null;
    try {
      const addRes = await fetch(addUrl, {
        ...fetchConfig('json', {
          body: JSON.stringify({ items: [{ id: variantIdNum, quantity: 1 }] }),
        }),
        credentials: 'same-origin',
        signal,
      });
      const addData = await parseCartJson(addRes);
      const line = this.#findLine(addData, productId, variantId);
      if (!line?.key) return null;

      lineKey = line.key;
      const lineT = lineDiscountTitles(line);
      const cartLevel = cartLevelDiscountTitles(addData);
      const titles = mergeUniqueTitles(lineT, cartLevel);

      await this.#removeCartLine(changeUrl, lineKey, signal);

      const finalCart = await this.#fetchCart(signal);
      document.dispatchEvent(
        new CartUpdateEvent(finalCart, 'product-discount-promotion', {
          itemCount: finalCart.item_count ?? 0,
          source: 'product-discount-promotion',
        })
      );

      return titles.length > 0 ? titles : null;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (lineKey) {
        try {
          await this.#removeCartLine(
            globalThis.Theme?.routes?.cart_change_url || this.dataset.cartChangeUrl,
            lineKey,
            signal
          );
          const finalCart = await this.#fetchCart(signal);
          document.dispatchEvent(
            new CartUpdateEvent(finalCart, 'product-discount-promotion', {
              itemCount: finalCart.item_count ?? 0,
              source: 'product-discount-promotion',
            })
          );
        } catch (_) {
          /* best-effort cleanup */
        }
      }
      return null;
    }
  }

  /**
   * @param {any} cart
   * @param {string} productId
   * @param {string} variantId
   */
  #findLine(cart, productId, variantId) {
    const items = cart.items || (cart.item ? [cart.item] : []);
    for (const item of items) {
      if (String(item.product_id) === String(productId) && String(item.variant_id) === String(variantId)) {
        return item;
      }
    }
    return null;
  }

  /**
   * @param {string} changeUrl
   * @param {string} lineKey
   * @param {AbortSignal} signal
   */
  async #removeCartLine(changeUrl, lineKey, signal) {
    const res = await fetch(changeUrl, {
      ...fetchConfig('json', {
        body: JSON.stringify({ line: lineKey, quantity: 0 }),
      }),
      credentials: 'same-origin',
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = 'change failed';
      try {
        const err = JSON.parse(text);
        msg = err?.description || err?.message || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    try {
      const data = JSON.parse(text);
      if (data?.errors) throw new Error(data.errors);
    } catch (e) {
      if (e instanceof SyntaxError) return;
      throw e;
    }
  }

  /**
   * @param {any} cart
   * @param {string} productId
   * @param {string} variantId
   */
  #titlesFromCart(cart, productId, variantId) {
    const titles = [];
    const seen = new Set();
    for (const item of cart.items || []) {
      if (String(item.product_id) !== String(productId)) continue;
      if (String(item.variant_id) !== String(variantId)) continue;
      for (const t of lineDiscountTitles(item)) {
        if (t && !seen.has(t)) {
          seen.add(t);
          titles.push(t);
        }
      }
    }
    return titles;
  }

  /**
   * @param {string[]} titles
   * @param {string} source
   */
  #renderLines(titles, source) {
    const prefix = this.dataset.promoPrefix || '';
    const wrap = document.createElement('div');
    wrap.className = 'offer-text';
    wrap.dataset.offerSource = source;

    let prefixShown = false;
    for (const title of titles) {
      const line = document.createElement('div');
      line.className = 'offer-text__line';
      if (!prefixShown && prefix) {
        const pre = document.createElement('span');
        pre.className = 'offer-text__prefix';
        pre.textContent = prefix;
        line.appendChild(pre);
        prefixShown = true;
      }
      const body = document.createElement('span');
      body.className = 'offer-text__body';
      body.textContent = title;
      line.appendChild(body);
      wrap.appendChild(line);
    }
    this.replaceChildren(wrap);
  }

  /**
   * @param {string} text
   * @param {string} source
   */
  #renderSingle(text, source) {
    const prefix = this.dataset.promoPrefix || '';
    const wrap = document.createElement('div');
    wrap.className = 'offer-text';
    wrap.dataset.offerSource = source;

    const line = document.createElement('div');
    line.className = 'offer-text__line';
    if (prefix) {
      const pre = document.createElement('span');
      pre.className = 'offer-text__prefix';
      pre.textContent = prefix;
      line.appendChild(pre);
    }
    const body = document.createElement('span');
    body.className = 'offer-text__body';
    body.textContent = text;
    line.appendChild(body);
    wrap.appendChild(line);
    this.replaceChildren(wrap);
  }
}

/**
 * @param {any} line
 * @returns {string[]}
 */
function lineDiscountTitles(line) {
  const seen = new Set();
  const out = [];
  const push = (/** @type {string | undefined} */ t) => {
    const s = t == null ? '' : String(t).trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const discounts = line.discounts;
  if (Array.isArray(discounts)) {
    for (const d of discounts) {
      push(d?.title || d?.discount_application?.title);
    }
  }
  if (Array.isArray(line.line_level_discount_allocations)) {
    for (const alloc of line.line_level_discount_allocations) {
      push(alloc?.discount_application?.title);
    }
  }
  return out;
}

/**
 * @param {any} cart
 * @returns {string[]}
 */
function cartLevelDiscountTitles(cart) {
  const apps = cart?.cart_level_discount_applications;
  if (!Array.isArray(apps)) return [];
  const seen = new Set();
  const out = [];
  for (const a of apps) {
    const t = a?.title || a?.discount_application?.title;
    const s = t == null ? '' : String(t).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function mergeUniqueTitles(a, b) {
  const seen = new Set();
  const out = [];
  for (const t of [...a, ...b]) {
    const s = String(t).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

if (!customElements.get('product-discount-promotion')) {
  customElements.define('product-discount-promotion', ProductDiscountPromotion);
}
