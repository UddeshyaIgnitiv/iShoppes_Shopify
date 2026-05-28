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
      console.log('nithin1',`GA triggered for event ${eventName} with parameters ${JSON.stringify(payload)}`);
      window.gtag('event', eventName, payload);
    } else if (Array.isArray(window.dataLayer)) {
      console.log('nithin2','GA not triggered',`${eventName} with parameters ${JSON.stringify(payload)}`)
      window.dataLayer.push(Object.assign({ event: eventName }, payload));
    }

    if (typeof Shopify !== 'undefined' && Shopify.analytics && typeof Shopify.analytics.publish === 'function') {
      try {
        Shopify.analytics.publish(CUSTOM_EVENT_PREFIX + eventName, payload);
        console.log('nithin3','GA triggered successully with GA account')
      } catch (e) {
        console.log('nithin4','GA not transferred into GA account')
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
    console.log('[GA Debug] initHomeSliderTracking called');

    // Only run on the homepage (support both root and trailing slash)
    const isHomePage = window.location.pathname === '/' || window.location.pathname === '';
    console.log('[GA Debug] Current pathname:', window.location.pathname, 'isHomePage:', isHomePage);

    if (!isHomePage) {
      console.log('[GA Debug] Not homepage, exiting initHomeSliderTracking');
      return;
    }

    console.log('[GA Debug] Homepage detected, attaching click listener (capture phase)');

    // Use capture phase to catch clicks before the slideshow's internal handlers
    window.addEventListener('click', function(event) {
      console.log('[GA Debug] Global click event captured (phase: capture)', 'target:', event.target);

      // Find the clickable slide link (the actual <a> that wraps the image)
      const slideLink = event.target.closest('.slide__image-container');
      console.log('[GA Debug] .slide__image-container found?', slideLink);

      if (!slideLink) {
        console.log('[GA Debug] Not a banner click, ignoring');
        return;
      }

      console.log('[GA Debug] Banner click detected, slideLink:', slideLink);

      // Prevent double-triggering if multiple listeners fire (optional)
      const alreadyTracked = slideLink.getAttribute('data-ga-tracked') === 'true';
      console.log('[GA Debug] Already tracked?', alreadyTracked);
      if (alreadyTracked) return;

      slideLink.setAttribute('data-ga-tracked', 'true');
      console.log('[GA Debug] Set data-ga-tracked="true" on slideLink');

      setTimeout(() => {
        slideLink.removeAttribute('data-ga-tracked');
        console.log('[GA Debug] Removed data-ga-tracked attribute after 500ms');
      }, 500);

      // --- Extract required parameters ---
      // link_url: the href of the banner
      const linkUrl = slideLink.getAttribute('href') || '';
      console.log('[GA Debug] link_url extracted:', linkUrl);

      // banner_name: use image alt text, or slide index + URL as fallback
      const img = slideLink.querySelector('img');
      let bannerName = img?.getAttribute('alt') || '';
      console.log('[GA Debug] img element found?', img, 'alt text:', bannerName);

      if (!bannerName) {
        console.log('[GA Debug] No alt text, falling back to slide index');
        // Fallback: try to get slide index from parent <slideshow-slide>
        const slide = slideLink.closest('slideshow-slide');
        const slides = slide?.parentElement?.querySelectorAll('slideshow-slide') || [];
        const index = Array.from(slides).indexOf(slide);
        bannerName = index !== -1 ? `Slide ${index + 1}` : 'Home Banner';
        console.log('[GA Debug] Fallback banner_name:', bannerName, 'slide index:', index);
      }

      // link_text: any text inside the anchor (if present), otherwise fallback to banner_name
      let linkText = slideLink.innerText?.trim() || '';
      if (!linkText) linkText = bannerName;
      console.log('[GA Debug] link_text extracted:', linkText);

      // Get slide index for extra metadata
      let slideIndex = -1;
      try {
        const slide = slideLink.closest('slideshow-slide');
        const slides = slide?.parentElement?.querySelectorAll('slideshow-slide') || [];
        slideIndex = Array.from(slides).indexOf(slide);
        console.log('[GA Debug] slide_index computed:', slideIndex);
      } catch (err) {
        console.error('[GA Debug] Error computing slide_index:', err);
      }

      // Send GA4 event
      const eventParams = {
        link_text: linkText,
        link_url: linkUrl,
        banner_name: bannerName,
        slide_index: slideIndex,
      };
      console.log('[GA Debug] About to send event "home_banner_click" with params:', eventParams);

      try {
        sendEvent('home_banner_click', eventParams);
        console.log('[GA Debug] sendEvent executed successfully');
      } catch (err) {
        console.error('[GA Debug] sendEvent threw an error:', err);
      }

      console.log('[GA Debug] Banner click tracking complete for:', linkUrl);
    }, true); // capture phase ensures we get the event before the slideshow component

    console.log('[GA Debug] Click listener attached successfully');
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
