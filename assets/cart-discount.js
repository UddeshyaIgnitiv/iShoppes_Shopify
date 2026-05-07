import { Component } from '@theme/component';
import { morphSection } from '@theme/section-renderer';
import { DiscountUpdateEvent } from '@theme/events';
import { fetchConfig } from '@theme/utilities';
import { cartPerformance } from '@theme/performance';

/**
 * A custom element that applies a discount to the cart.
 *
 * @typedef {Object} CartDiscountComponentRefs
 * @property {HTMLElement} cartDiscountError - The error element.
 * @property {HTMLElement} cartDiscountErrorDiscountCode - The discount code error element.
 * @property {HTMLElement} cartDiscountErrorShipping - The shipping error element.
 * @property {HTMLElement} [cartDiscountErrorBxgyMin] - Error shown when cart has fewer than the BXGY "buy" quantity.
 * @property {HTMLElement} [cartDiscountInfo] - Container for informational messages (e.g. free item added).
 * @property {HTMLElement} [cartDiscountInfoText] - Text node for the informational message.
 */

/**
 * @typedef {Object} BxgyRule
 * @property {number} buy - Number of qualifying items the customer must have in cart.
 * @property {number} get - Number of free entitled items the discount adds.
 */

/**
 * @extends {Component<CartDiscountComponentRefs>}
 */
class CartDiscount extends Component {
  requiredRefs = ['cartDiscountError', 'cartDiscountErrorDiscountCode', 'cartDiscountErrorShipping'];

  /** @type {AbortController | null} */
  #activeFetch = null;

  #createAbortController() {
    if (this.#activeFetch) {
      this.#activeFetch.abort();
    }

    const abortController = new AbortController();
    this.#activeFetch = abortController;
    return abortController;
  }

  /**
   * Handles updates to the cart note.
   * @param {SubmitEvent} event - The submit event on our form.
   */
  applyDiscount = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const discountCode = form.querySelector('input[name="discount"]');
    if (!(discountCode instanceof HTMLInputElement) || typeof this.dataset.sectionId !== 'string') return;

    const discountCodeValue = discountCode.value.trim();
    if (!discountCodeValue) return;

    const sectionId = this.dataset.sectionId;
    if (typeof sectionId !== 'string') return;

    try {
      await this.#applyDiscountCode(discountCodeValue, discountCode, sectionId, { allowBxgyAutoAdd: true });
    } finally {
      cartPerformance.measureFromEvent('discount-update:user-action', event);
    }
  };

  /**
   * Attempts to apply a discount code, optionally auto-adding the free Y item for
   * Buy-X-Get-Y codes whose required quantity has not yet been reached.
   *
   * @param {string} discountCodeValue
   * @param {HTMLInputElement} discountCodeInput
   * @param {string} sectionId
   * @param {{ allowBxgyAutoAdd: boolean }} options
   */
  async #applyDiscountCode(discountCodeValue, discountCodeInput, sectionId, options) {
    const { cartDiscountError, cartDiscountErrorDiscountCode, cartDiscountErrorShipping } = this.refs;
    const abortController = this.#createAbortController();

    try {
      const existingDiscounts = this.#existingDiscounts();
      if (existingDiscounts.includes(discountCodeValue)) return;

      cartDiscountError.classList.add('hidden');
      cartDiscountErrorDiscountCode.classList.add('hidden');
      cartDiscountErrorShipping.classList.add('hidden');
      this.#hideBxgyMinError();

      const config = fetchConfig('json', {
        body: JSON.stringify({
          discount: [...existingDiscounts, discountCodeValue].join(','),
          sections: [sectionId],
        }),
      });

      const response = await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal: abortController.signal,
      });

      const data = await response.json();

      const notApplicable = data.discount_codes?.find(
        (/** @type {{ code: string; applicable: boolean; }} */ discount) =>
          discount.code === discountCodeValue && discount.applicable === false
      );

      if (notApplicable) {
        if (options.allowBxgyAutoAdd) {
          const handled = await this.#tryAutoAddForBxgy(discountCodeValue, discountCodeInput, sectionId);
          if (handled) return;
        }
        discountCodeInput.value = '';
        this.#handleDiscountError('discount_code');
        return;
      }

      const newHtml = data.sections[sectionId];
      const parsedHtml = new DOMParser().parseFromString(newHtml, 'text/html');
      const section = parsedHtml.getElementById(`shopify-section-${sectionId}`);
      const discountCodes = section?.querySelectorAll('.cart-discount__pill') || [];
      if (section) {
        const codes = Array.from(discountCodes)
          .map((element) => (element instanceof HTMLLIElement ? element.dataset.discountCode : null))
          .filter(Boolean);
        // Before morphing, we need to check if the shipping discount is applicable in the UI
        // we check the liquid logic compared to the cart payload to assess whether we leveraged
        // a valid shipping discount code.
        if (
          codes.length === existingDiscounts.length &&
          codes.every((/** @type {string} */ code) => existingDiscounts.includes(code)) &&
          data.discount_codes.find((/** @type {{ code: string; applicable: boolean; }} */ discount) => {
            return discount.code === discountCodeValue && discount.applicable === true;
          })
        ) {
          this.#handleDiscountError('shipping');
          discountCodeInput.value = '';
          return;
        }
      }

      document.dispatchEvent(new DiscountUpdateEvent(data, this.id));
      morphSection(sectionId, newHtml);
    } catch (error) {
      if (error?.name === 'AbortError') return;
    } finally {
      this.#activeFetch = null;
    }
  }

  /**
   * If the failed code matches a configured Buy-X-Get-Y rule and the cart is
   * short of the required total quantity, bump the cheapest cart line by the
   * missing quantity and retry the discount apply once.
   *
   * @param {string} discountCodeValue
   * @param {HTMLInputElement} discountCodeInput
   * @param {string} sectionId
   * @returns {Promise<boolean>} true when the case was handled (whether or not the retry succeeded)
   */
  async #tryAutoAddForBxgy(discountCodeValue, discountCodeInput, sectionId) {
    const rule = this.#findBxgyRule(discountCodeValue);
    if (!rule) return false;

    const requiredQty = Math.max(0, rule.buy + rule.get);
    if (requiredQty <= 0) return false;

    /** @type {{ items?: Array<{ key: string; quantity: number; final_price?: number; price?: number; product_title?: string; }>; item_count?: number }} */
    let cart;
    try {
      const cartUrl = `${Theme.routes.cart_url}.js`;
      const res = await fetch(cartUrl, { credentials: 'same-origin' });
      cart = await res.json();
    } catch (_e) {
      return false;
    }

    const totalQty = Number(cart?.item_count) || 0;
    const items = Array.isArray(cart?.items) ? cart.items : [];

    if (totalQty === 0) {
      discountCodeInput.value = '';
      this.#showBxgyMinError(rule.buy);
      return true;
    }

    if (totalQty < rule.buy) {
      discountCodeInput.value = '';
      this.#showBxgyMinError(rule.buy);
      return true;
    }

    const missing = requiredQty - totalQty;
    if (missing <= 0) {
      // Cart already has enough items; failure must be unrelated to qty (e.g.
      // products outside the discount's eligible collection). Surface the
      // standard error so the customer is not silently mis-charged.
      return false;
    }

    const cheapest = items
      .slice()
      .sort((a, b) => {
        const ap = Number(a.final_price ?? a.price ?? 0);
        const bp = Number(b.final_price ?? b.price ?? 0);
        return ap - bp;
      })[0];

    if (!cheapest) return false;

    try {
      const changeRes = await fetch(Theme.routes.cart_change_url, {
        ...fetchConfig('json', {
          body: JSON.stringify({
            id: cheapest.key,
            quantity: Number(cheapest.quantity || 0) + missing,
          }),
        }),
      });
      if (!changeRes.ok) return false;
    } catch (_e) {
      return false;
    }

    this.#showBxgyInfo(missing, cheapest.product_title || '');

    // Retry the discount apply, but disable further auto-add to avoid loops.
    await this.#applyDiscountCode(discountCodeValue, discountCodeInput, sectionId, { allowBxgyAutoAdd: false });
    return true;
  }

  /**
   * Looks up a BXGY rule by code (case-insensitive) from the data attribute
   * populated from the `shop.metafields.custom.bxgy_rules` JSON metafield.
   *
   * @param {string} code
   * @returns {BxgyRule | null}
   */
  #findBxgyRule(code) {
    const raw = this.dataset.bxgyRules;
    if (!raw) return null;
    /** @type {Record<string, unknown>} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const target = code.toUpperCase();
    for (const [key, value] of Object.entries(parsed)) {
      if (key.toUpperCase() !== target) continue;
      if (!value || typeof value !== 'object') return null;
      const buy = Number(/** @type {any} */ (value).buy);
      const get = Number(/** @type {any} */ (value).get);
      if (!Number.isFinite(buy) || !Number.isFinite(get) || buy <= 0 || get <= 0) return null;
      return { buy, get };
    }
    return null;
  }

  /**
   * @param {number} buyQty
   */
  #showBxgyMinError(buyQty) {
    const { cartDiscountError, cartDiscountErrorBxgyMin } = this.refs;
    if (!cartDiscountErrorBxgyMin) {
      this.#handleDiscountError('discount_code');
      return;
    }
    cartDiscountError.classList.remove('hidden');
    cartDiscountErrorBxgyMin.textContent = `Add at least ${buyQty} qualifying item${
      buyQty === 1 ? '' : 's'
    } to your cart before applying this code.`;
    cartDiscountErrorBxgyMin.classList.remove('hidden');
  }

  #hideBxgyMinError() {
    const { cartDiscountErrorBxgyMin } = this.refs;
    cartDiscountErrorBxgyMin?.classList.add('hidden');
    const { cartDiscountInfo } = this.refs;
    cartDiscountInfo?.classList.add('hidden');
  }

  /**
   * @param {number} qty
   * @param {string} title
   */
  #showBxgyInfo(qty, title) {
    const { cartDiscountInfo, cartDiscountInfoText } = this.refs;
    if (!cartDiscountInfo || !cartDiscountInfoText) return;
    const itemLabel = title ? `“${title}”` : 'item';
    cartDiscountInfoText.textContent =
      qty === 1
        ? `We added 1 free ${itemLabel} to your cart to qualify for the discount.`
        : `We added ${qty} free units of ${itemLabel} to your cart to qualify for the discount.`;
    cartDiscountInfo.classList.remove('hidden');
  }

  /**
   * Handles removing a discount from the cart.
   * @param {MouseEvent | KeyboardEvent} event - The mouse or keyboard event in our pill.
   */
  removeDiscount = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      (event instanceof KeyboardEvent && event.key !== 'Enter') ||
      !(event instanceof MouseEvent) ||
      !(event.target instanceof HTMLElement) ||
      typeof this.dataset.sectionId !== 'string'
    ) {
      return;
    }

    const pill = event.target.closest('.cart-discount__pill');
    if (!(pill instanceof HTMLLIElement)) return;

    const discountCode = pill.dataset.discountCode;
    if (!discountCode) return;

    const existingDiscounts = this.#existingDiscounts();
    const index = existingDiscounts.indexOf(discountCode);
    if (index === -1) return;

    existingDiscounts.splice(index, 1);

    const abortController = this.#createAbortController();

    try {
      const config = fetchConfig('json', {
        body: JSON.stringify({ discount: existingDiscounts.join(','), sections: [this.dataset.sectionId] }),
      });

      const response = await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal: abortController.signal,
      });

      const data = await response.json();

      document.dispatchEvent(new DiscountUpdateEvent(data, this.id));
      morphSection(this.dataset.sectionId, data.sections[this.dataset.sectionId]);
    } catch (error) {
    } finally {
      this.#activeFetch = null;
    }
  };

  /**
   * Handles the discount error.
   *
   * @param {'discount_code' | 'shipping'} type - The type of discount error.
   */
  #handleDiscountError(type) {
    const { cartDiscountError, cartDiscountErrorDiscountCode, cartDiscountErrorShipping } = this.refs;
    const target = type === 'discount_code' ? cartDiscountErrorDiscountCode : cartDiscountErrorShipping;
    cartDiscountError.classList.remove('hidden');
    target.classList.remove('hidden');
  }

  /**
   * Returns an array of existing discount codes.
   * @returns {string[]}
   */
  #existingDiscounts() {
    /** @type {string[]} */
    const discountCodes = [];
    const discountPills = this.querySelectorAll('.cart-discount__pill');
    for (const pill of discountPills) {
      if (pill instanceof HTMLLIElement && typeof pill.dataset.discountCode === 'string') {
        discountCodes.push(pill.dataset.discountCode);
      }
    }

    return discountCodes;
  }
}

if (!customElements.get('cart-discount-component')) {
  customElements.define('cart-discount-component', CartDiscount);
}
