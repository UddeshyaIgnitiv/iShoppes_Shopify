// @ts-nocheck
/**
 * GA4 ecommerce events for AB Google Analytics.
 * view_item_list, view_item, search, add_to_cart, begin_checkout, purchase
 */
(function () {
  'use strict';

  const STORAGE_FIRST_VISIT = 'ishoppes_ga_first_visit';
  const STORAGE_SESSION = 'ishoppes_ga_session';
  const STORAGE_PAGE_EVENT = 'ishoppes_ga_page_event';
  const STORAGE_PURCHASE = 'ishoppes_ga_purchase';
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const CUSTOM_EVENT_PREFIX = 'ishoppes_ga:';

  const config = window.__gaCustomEventsConfig || {};
  const formsStarted = new Set();
  const sliderSlidesSeen = new Set();

  /**
   * @param {string} eventName
   * @param {Record<string, unknown>} [params]
   */
  function sendEvent(eventName, params) {
    const payload = Object.assign(
      {
        event_name: eventName,
        page_location: window.location.href,
        page_path: window.location.pathname,
        currency: config.currency || '',
      },
      params || {}
    );

    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, payload);
    } else if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push(Object.assign({ event: eventName }, payload));
    }

    if (typeof Shopify !== 'undefined' && Shopify.analytics && typeof Shopify.analytics.publish === 'function') {
      try {
        Shopify.analytics.publish(CUSTOM_EVENT_PREFIX + eventName, payload);
      } catch (e) {
        /* unavailable in some contexts */
      }
    }
  }

  /**
   * @param {number} cents
   */
  function centsToMajor(cents) {
    return Number(cents) / 100;
  }

  /**
   * @param {Record<string, unknown>} item
   */
  function itemValue(item) {
    return (Number(item.price) || 0) * (Number(item.quantity) || 1);
  }

  /**
   * @param {Array<Record<string, unknown>>} items
   */
  function itemsTotalValue(items) {
    return items.reduce((sum, item) => sum + itemValue(item), 0);
  }

  /**
   * @param {Record<string, unknown>} line
   */
  function mapCartJsLine(line) {
    return {
      item_id: String(line.variant_id),
      item_name: line.product_title || line.title || '',
      item_variant: line.variant_title || '',
      item_brand: line.vendor || '',
      price: centsToMajor(line.price),
      quantity: Number(line.quantity) || 1,
    };
  }

  /**
   * @returns {Promise<{ items: Array<Record<string, unknown>>, total: number, currency: string }>}
   */
  async function fetchCartPayload() {
    if (config.cart && config.cart.items && config.cart.items.length) {
      return {
        items: config.cart.items,
        total: Number(config.cart.total) || itemsTotalValue(config.cart.items),
        currency: config.currency || '',
      };
    }

    const response = await fetch('/cart.js', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('cart fetch failed');
    const cart = await response.json();
    const items = (cart.items || []).map(mapCartJsLine);
    return {
      items,
      total: centsToMajor(cart.total_price),
      currency: cart.currency || config.currency || '',
    };
  }

  function trackSessionStart() {
    const now = Date.now();
    const stored = sessionStorage.getItem(STORAGE_SESSION);

    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed && now - parsed.ts < SESSION_TIMEOUT_MS) return;
      } catch (e) {
        /* ignore */
      }
    }

    sessionStorage.setItem(STORAGE_SESSION, JSON.stringify({ ts: now }));
    sendEvent('session_start');
  }

  function trackFirstVisit() {
    if (localStorage.getItem(STORAGE_FIRST_VISIT)) return;
    localStorage.setItem(STORAGE_FIRST_VISIT, '1');
    sendEvent('first_visit');
  }

  function trackPageEcommerceEvent() {
    if (!config.pageEvent) return;

    const dedupeKey = STORAGE_PAGE_EVENT + '::' + config.pageEvent + '::' + window.location.pathname + window.location.search;
    if (sessionStorage.getItem(dedupeKey)) return;
    sessionStorage.setItem(dedupeKey, '1');

    if (config.pageEvent === 'view_item' && config.product) {
      const p = config.product;
      const items = [
        {
          item_id: String(p.variantId || p.id),
          item_name: p.title,
          item_brand: p.vendor || '',
          item_category: p.type || '',
          item_variant: p.variantTitle || '',
          price: Number(p.price) || 0,
          quantity: 1,
        },
      ];
      sendEvent('view_item', {
        value: Number(p.price) || 0,
        items,
      });
      // Alias for easier reporting/mapping.
      sendEvent('item_view', {
        value: Number(p.price) || 0,
        items,
      });
      return;
    }

    if (config.pageEvent === 'view_item_list' && config.collection) {
      const items = config.listItems || [];
      sendEvent('view_item_list', {
        item_list_id: String(config.itemListId || config.collection.id),
        item_list_name: config.itemListName || config.collection.title,
        items,
      });
      const categoryPayload = {
        item_list_id: String(config.itemListId || config.collection.id),
        item_list_name: config.itemListName || config.collection.title,
        items,
      };
      sendEvent('view_category', categoryPayload);
      // Alias for easier reporting/mapping.
      sendEvent('category_page_view', categoryPayload);
      return;
    }

    if (config.pageEvent === 'search') {
      const term = config.searchTerm || new URLSearchParams(window.location.search).get('q') || '';
      if (!term) return;
      sendEvent('search', {
        search_term: term,
        items: config.searchItems || [],
      });
    }
  }

  function initViewItemOnVariantChange() {
    if (!config.product) return;

    document.addEventListener('variant:update', function (event) {
      const detail = event.detail || {};
      const variant = detail.resource;
      if (!variant || !variant.id) return;

      if (detail.data && detail.data.productId && String(detail.data.productId) !== String(config.product.id)) {
        return;
      }

      const price =
        typeof variant.price === 'number'
          ? centsToMajor(variant.price)
          : typeof variant.price === 'string'
            ? centsToMajor(Number(variant.price))
            : Number(config.product.price) || 0;

      const items = [
        {
          item_id: String(variant.id),
          item_name: config.product.title,
          item_brand: config.product.vendor || '',
          item_category: config.product.type || '',
          item_variant: variant.title || variant.public_title || '',
          price,
          quantity: 1,
        },
      ];

      sendEvent('view_item', { value: price, items });
      // Alias for easier reporting/mapping.
      sendEvent('item_view', { value: price, items });
    });
  }

  function initSearchTracking() {
    document.addEventListener(
      'submit',
      function (event) {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (!form.action || !form.action.includes('/search')) return;

        const input = form.querySelector('input[name="q"]');
        const term = input && 'value' in input ? String(input.value).trim() : '';
        if (!term) return;

        sendEvent('search', { search_term: term });
      },
      true
    );
  }

  function fireBeginCheckout() {
    fetchCartPayload()
      .then((cart) => {
        sendEvent('begin_checkout', {
          currency: cart.currency,
          value: cart.total,
          items: cart.items,
        });
      })
      .catch(() => {
        sendEvent('begin_checkout', { items: config.cart?.items || [] });
      });
  }

  function initBeginCheckoutTracking() {
    document.addEventListener(
      'click',
      function (event) {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const checkoutEl = target.closest(
          'button[name="checkout"], a[href*="/checkout"], [data-shopify="payment-button"], shopify-buy-it-now-button'
        );
        if (!checkoutEl) return;

        fireBeginCheckout();
      },
      true
    );
  }

  function initAddToCartTracking() {
    document.addEventListener('cart:update', function (event) {
      const detail = event.detail || {};
      const data = detail.data || {};

      if (data.didError) return;

      const addSources = ['product-form-component'];
      if (!addSources.includes(data.source) && !detail.sourceId) return;

      const variantId = String(detail.sourceId || data.variantId || '');
      let items = [];
      let value = 0;

      if (config.product && String(config.product.variantId) === variantId) {
        const p = config.product;
        items = [
          {
            item_id: variantId,
            item_name: p.title,
            item_brand: p.vendor || '',
            item_category: p.type || '',
            item_variant: p.variantTitle || '',
            price: Number(p.price) || 0,
            quantity: Number(data.itemCount) || 1,
          },
        ];
        value = itemValue(items[0]);
      }

      const sendAddToCart = (cartItems, cartValue) => {
        sendEvent('add_to_cart', {
          currency: config.currency || '',
          value: cartValue || value,
          items: cartItems.length ? cartItems : items,
        });
      };

      if (items.length) {
        sendAddToCart(items, value);
        return;
      }

      fetchCartPayload()
        .then((cart) => {
          const line = cart.items.find((item) => String(item.item_id) === variantId);
          if (line) {
            sendAddToCart([line], itemValue(line));
          } else {
            sendAddToCart(
              [
                {
                  item_id: variantId,
                  item_name: String(data.productId || ''),
                  quantity: Number(data.itemCount) || 1,
                },
              ],
              0
            );
          }
        })
        .catch(() => {
          sendAddToCart(items, value);
        });
    });
  }

  function initPurchaseTracking() {
    if (!config.purchase || !config.purchase.transactionId) return;

    const orderKey = String(config.purchase.transactionId);
    if (sessionStorage.getItem(STORAGE_PURCHASE + orderKey)) return;
    sessionStorage.setItem(STORAGE_PURCHASE + orderKey, '1');

    sendEvent('purchase', {
      transaction_id: orderKey,
      currency: config.purchase.currency || config.currency || '',
      value: Number(config.purchase.value) || 0,
      tax: Number(config.purchase.tax) || 0,
      shipping: Number(config.purchase.shipping) || 0,
      items: config.purchase.items || [],
    });
  }

  function initFormStartTracking() {
    document.addEventListener(
      'focusin',
      function (event) {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const field = target.closest('input, textarea, select');
        if (!field) return;

        const form = field.closest('form');
        if (!form) return;

        const formId = form.id || form.getAttribute('name') || form.action || 'unknown_form';
        const key = formId + '::' + window.location.pathname;
        if (formsStarted.has(key)) return;

        formsStarted.add(key);
        sendEvent('form_start', {
          form_id: formId,
          form_name: form.getAttribute('name') || formId,
          form_destination: form.action || window.location.href,
        });
      },
      true
    );
  }

  function initHomeSliderTracking() {
    if (!config.isHomePage) return;
alert(1);
    document.addEventListener('slideshow:select', function (event) {
      const slideshow = event.target;
      if (!(slideshow instanceof Element)) return;
      if (!slideshow.closest('.slideshow-margin-wrapper')) return;

      const detail = event.detail || {};
      const slideKey = (detail.id || '') + '::' + String(detail.index);

      if (!detail.userInitiated && sliderSlidesSeen.has(slideKey)) return;
      sliderSlidesSeen.add(slideKey);

      sendEvent('home_slider', {
        slide_index: detail.index,
        slide_id: detail.id || '',
        interaction_type: detail.userInitiated ? 'manual' : 'auto',
        trigger: detail.trigger || 'select',
      });

      // Alias specifically for user-initiated interaction.
      if (detail.userInitiated) {
        sendEvent('home_page_slider_click', {
          slide_index: detail.index,
          slide_id: detail.id || '',
          interaction_type: 'manual',
          trigger: detail.trigger || 'select',
        });
      }
    });
  }

  function init() {
    // trackSessionStart();
    // trackFirstVisit();
    trackPageEcommerceEvent();
    initViewItemOnVariantChange();
    // initSearchTracking();
    // initBeginCheckoutTracking();
    // initAddToCartTracking();
    // initPurchaseTracking();
    // initFormStartTracking();
    initHomeSliderTracking();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
