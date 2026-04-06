import { fetchConfig } from '@theme/utilities';
import { ThemeEvents } from '@theme/events';

const PROBE_KEY = '_pdp_discount_probe';

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
 * Reads automatic / line-level discount titles the same way the cart does, using the Cart Ajax API.
 * When the PDP has no matching cart line, briefly adds the variant with a hidden property, reads
 * `discounts` from /cart.js, then removes that line.
 */
class ProductDiscountPromotion extends HTMLElement {
  /** @type {AbortController | undefined} */
  #abort;

  connectedCallback() {
    this.#refresh();
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

    const probeEnabled = this.dataset.probeEnabled !== 'false';
    const probeQty = Math.max(1, Math.min(20, parseInt(this.dataset.probeQuantity || '1', 10) || 1));

    try {
      const cart = await this.#fetchCart(signal);
      let titles = this.#titlesFromCart(cart, productId, variantId);

      if (titles.length === 0 && probeEnabled) {
        titles = await this.#probe(variantId, probeQty, signal);
      }

      if (titles.length > 0) {
        this.#renderLines(titles, 'ajax');
      } else if (this.dataset.fallbackText) {
        this.#renderSingle(this.dataset.fallbackText, 'metafield');
      } else if (!this.innerHTML.trim()) {
        this.replaceChildren();
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (this.dataset.fallbackText) {
        this.#renderSingle(this.dataset.fallbackText, 'metafield');
      }
    }
  }

  /**
   * @param {AbortSignal} signal
   */
  async #fetchCart(signal) {
    const url = this.dataset.cartJsUrl || (globalThis.Theme?.routes?.cart_url ? `${globalThis.Theme.routes.cart_url}.js` : null);
    if (!url) throw new Error('missing cart url');
    const res = await fetch(url, { signal });
    return parseCartJson(res);
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
      if (this.#isProbeLine(item)) continue;
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
   * @param {any} item
   * @param {string} [token] If set, match exact probe token; otherwise any probe line.
   */
  #isProbeLine(item, token) {
    const v = item.properties?.[PROBE_KEY];
    if (v == null || v === '') return false;
    if (token != null && token !== '') return String(v) === String(token);
    return true;
  }

  /**
   * @param {string} variantId
   * @param {number} quantity
   * @param {AbortSignal} signal
   */
  async #probe(variantId, quantity, signal) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const addUrl = this.dataset.cartAddUrl || globalThis.Theme?.routes?.cart_add_url;
    if (!addUrl) throw new Error('missing cart add url');

    try {
      const addRes = await fetch(addUrl, {
        ...fetchConfig('json', {
          body: JSON.stringify({
            items: [
              {
                id: Number(variantId),
                quantity,
                properties: { [PROBE_KEY]: token },
              },
            ],
          }),
        }),
        signal,
      });
      await parseCartJson(addRes);

      const cart = await this.#fetchCart(signal);
      const idx = (cart.items || []).findIndex((item) => this.#isProbeLine(item, token));
      if (idx === -1) return [];
      return lineDiscountTitles(cart.items[idx]);
    } finally {
      await this.#cleanupProbeLine(token, signal);
    }
  }

  /**
   * @param {string} token
   * @param {AbortSignal} signal
   */
  async #cleanupProbeLine(token, signal) {
    try {
      const cart = await this.#fetchCart(signal);
      const idx = (cart.items || []).findIndex((item) => this.#isProbeLine(item, token));
      if (idx === -1) return;
      await this.#setLineQuantity(idx + 1, 0, signal);
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {number} line 1-based
   * @param {number} quantity
   * @param {AbortSignal} signal
   */
  async #setLineQuantity(line, quantity, signal) {
    const changeUrl = this.dataset.cartChangeUrl || globalThis.Theme?.routes?.cart_change_url;
    if (!changeUrl) throw new Error('missing cart change url');
    const changeRes = await fetch(changeUrl, {
      ...fetchConfig('json', {
        body: JSON.stringify({ line, quantity }),
      }),
      signal,
    });
    await parseCartJson(changeRes);
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
  const out = [];
  const discounts = line.discounts;
  if (Array.isArray(discounts)) {
    for (const d of discounts) {
      const t = d?.title || d?.discount_application?.title;
      if (t) out.push(String(t));
    }
  }
  if (out.length === 0 && Array.isArray(line.line_level_discount_allocations)) {
    for (const alloc of line.line_level_discount_allocations) {
      const t = alloc?.discount_application?.title;
      if (t) out.push(String(t));
    }
  }
  return out;
}

if (!customElements.get('product-discount-promotion')) {
  customElements.define('product-discount-promotion', ProductDiscountPromotion);
}
