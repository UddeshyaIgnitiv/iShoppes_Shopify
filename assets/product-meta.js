import { ThemeEvents } from '@theme/events';

/**
 * Updates SKU and Size (or matched option) in the product description meta when the PDP variant changes.
 */
class ProductMeta extends HTMLElement {
  /** @type {EventTarget | undefined} */
  #eventRoot;

  connectedCallback() {
    // Variant picker often lives in a different `.shopify-section` than this block (e.g. accordion
    // below the main product section). `variant:update` bubbles through shared ancestors only.
    this.#eventRoot =
      this.closest('#MainContent') ?? this.closest('.shopify-section, dialog') ?? document;
    this.#eventRoot.addEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate);
  }

  disconnectedCallback() {
    this.#eventRoot?.removeEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate);
    this.#eventRoot = undefined;
  }

  /**
   * @param {import('@theme/events').VariantUpdateEvent} event
   */
  #onVariantUpdate = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.target instanceof HTMLElement && event.target.dataset.productId !== this.dataset.productId) {
      return;
    }

    const variant = event.detail.resource;
    if (!variant) return;

    const skuEl = this.querySelector('[data-product-meta-sku]');
    if (skuEl) {
      skuEl.textContent = variant.sku ?? '';
    }

    const sizeOptionIndex = Number(this.dataset.sizeOptionIndex) || 1;
    const optKey = `option${sizeOptionIndex}`;
    const raw = variant[optKey];
    const sizeVal = raw && raw !== 'Default Title' ? String(raw) : '';

    const sizeRow = this.querySelector('[data-product-meta-size-row]');
    const sizeEl = this.querySelector('[data-product-meta-size]');
    if (sizeEl) {
      sizeEl.textContent = sizeVal;
    }
    if (sizeRow) {
      sizeRow.hidden = !sizeVal;
    }
  };
}

if (!customElements.get('product-meta')) {
  customElements.define('product-meta', ProductMeta);
}
