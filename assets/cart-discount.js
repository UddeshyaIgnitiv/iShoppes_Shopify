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
 */

/**
 * @extends {Component<CartDiscountComponentRefs>}
 */
class CartDiscount extends Component {
  requiredRefs = ['cartDiscountError', 'cartDiscountErrorDiscountCode', 'cartDiscountErrorShipping'];
  #buyXGetYCode = 'BUY2GET1FREE';

  /** @type {AbortController | null} */
  #activeFetch = null;
  #isAutoAddingFreeItems = false;

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
    const { cartDiscountError, cartDiscountErrorDiscountCode, cartDiscountErrorShipping } = this.refs;

    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const discountCode = form.querySelector('input[name="discount"]');
    if (!(discountCode instanceof HTMLInputElement) || typeof this.dataset.sectionId !== 'string') return;

    const discountCodeValue = discountCode.value;

    const abortController = this.#createAbortController();

    try {
      const existingDiscounts = this.#existingDiscounts();
      if (existingDiscounts.includes(discountCodeValue)) return;

      cartDiscountError.classList.add('hidden');
      cartDiscountErrorDiscountCode.classList.add('hidden');
      cartDiscountErrorShipping.classList.add('hidden');

      const config = fetchConfig('json', {
        body: JSON.stringify({
          discount: [...existingDiscounts, discountCodeValue].join(','),
          sections: [this.dataset.sectionId],
        }),
      });

      const response = await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal: abortController.signal,
      });

      const data = await response.json();

      if (
        data.discount_codes.find((/** @type {{ code: string; applicable: boolean; }} */ discount) => {
          return discount.code === discountCodeValue && discount.applicable === false;
        })
      ) {
        discountCode.value = '';
        this.#handleDiscountError('discount_code');
        return;
      }

      const newHtml = data.sections[this.dataset.sectionId];
      const parsedHtml = new DOMParser().parseFromString(newHtml, 'text/html');
      const section = parsedHtml.getElementById(`shopify-section-${this.dataset.sectionId}`);
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
          discountCode.value = '';
          return;
        }
      }

      const autoAddedSectionHtml = await this.#autoAddBuy2Get1FreeItems(discountCodeValue);

      document.dispatchEvent(new DiscountUpdateEvent(data, this.id));
      morphSection(this.dataset.sectionId, autoAddedSectionHtml || newHtml);
    } catch (error) {
    } finally {
      this.#activeFetch = null;
      cartPerformance.measureFromEvent('discount-update:user-action', event);
    }
  };

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

  /**
   * Automatically adds missing free items for BUY2GET1FREE.
   * @param {string} discountCode
   * @returns {Promise<string | null>}
   */
  async #autoAddBuy2Get1FreeItems(discountCode) {
    if (this.#isAutoAddingFreeItems || discountCode.trim().toUpperCase() !== this.#buyXGetYCode) {
      return null;
    }

    this.#isAutoAddingFreeItems = true;

    try {
      const cartResponse = await fetch(`${Theme.routes.cart_url}.js`);
      const cart = await cartResponse.json();
      const additions = this.#getMissingFreeItemAdditions(cart, discountCode);

      if (!additions.length) return null;

      let latestSectionHtml = null;

      for (const addition of additions) {
        const formData = new FormData();
        formData.append('id', String(addition.id));
        formData.append('quantity', String(addition.quantity));
        formData.append('sections', this.dataset.sectionId || '');

        const fetchCfg = fetchConfig('javascript', { body: formData });
        const response = await fetch(Theme.routes.cart_add_url, {
          ...fetchCfg,
          headers: {
            ...fetchCfg.headers,
            Accept: 'text/html',
          },
        });
        const data = await response.json();
        latestSectionHtml = data.sections?.[this.dataset.sectionId];
      }

      return latestSectionHtml;
    } catch (error) {
      console.error(error);
      return null;
    } finally {
      this.#isAutoAddingFreeItems = false;
    }
  }

  /**
   * Calculates free-item additions needed to satisfy BUY2GET1FREE.
   * @param {{ items?: Array<any> }} cart
   * @param {string} discountCode
   * @returns {Array<{ id: number, quantity: number }>}
   */
  #getMissingFreeItemAdditions(cart, discountCode) {
    if (!Array.isArray(cart.items)) return [];

    const normalizedCode = discountCode.trim().toUpperCase();
    /** @type {Array<{ id: number, quantity: number }>} */
    const additions = [];

    for (const item of cart.items) {
      const quantity = Number(item.quantity) || 0;
      const variantId = Number(item.id);
      const unitPrice = Number(item.original_price) || 0;
      if (!variantId || quantity <= 0 || unitPrice <= 0) continue;

      const currentFreeUnits = this.#countDiscountedUnitsForCode(item, normalizedCode, unitPrice);
      const paidUnits = Math.max(0, quantity - currentFreeUnits);
      const expectedFreeUnits = Math.floor(paidUnits / 2);
      const missingFreeUnits = Math.max(0, expectedFreeUnits - currentFreeUnits);

      if (missingFreeUnits > 0) {
        additions.push({ id: variantId, quantity: missingFreeUnits });
      }
    }

    return additions;
  }

  /**
   * Estimates how many units are already free for a discount code.
   * @param {{ discount_allocations?: Array<any> }} item
   * @param {string} normalizedCode
   * @param {number} unitPrice
   * @returns {number}
   */
  #countDiscountedUnitsForCode(item, normalizedCode, unitPrice) {
    if (!Array.isArray(item.discount_allocations)) return 0;

    const totalDiscountAmount = item.discount_allocations.reduce((sum, allocation) => {
      const application = allocation?.discount_application;
      const codeMatch =
        typeof application?.code === 'string' && application.code.trim().toUpperCase() === normalizedCode;
      const titleMatch =
        typeof application?.title === 'string' && application.title.trim().toUpperCase() === normalizedCode;

      if (!codeMatch && !titleMatch) return sum;

      const allocationAmount = Number(allocation.amount) || 0;
      return sum + allocationAmount;
    }, 0);

    if (totalDiscountAmount <= 0) return 0;

    return Math.max(0, Math.round(totalDiscountAmount / unitPrice));
  }
}

if (!customElements.get('cart-discount-component')) {
  customElements.define('cart-discount-component', CartDiscount);
}
