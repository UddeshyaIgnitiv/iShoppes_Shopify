/**
 * Shared Buy X Get Y helpers for free-item promotions.
 * Used when adding to cart / changing quantity so "Buy 3 Get 1 Free"
 * can top up the free unit automatically (Shopify only applies BXGY once Y is in cart).
 */

/**
 * @typedef {{ buyQuantity: number; freeQuantity: number }} BxgyPattern
 */

/**
 * Normalize metafield / dataset discount labels into a string array.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDiscountLabels(raw) {
  if (raw == null || raw === '') return [];

  if (Array.isArray(raw)) {
    return raw.map((value) => String(value)).filter(Boolean);
  }

  const text = String(raw).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value)).filter(Boolean);
    }
  } catch {
    // Not JSON — treat as a single label / comma-separated list.
  }

  return text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Parse a single BUY x GET y (free) style label/code.
 * @param {string} label
 * @returns {BxgyPattern | null}
 */
export function parseBuyXGetY(label) {
  if (!label) return null;

  const original = String(label);
  const normalized = original.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hasFreeToken = /FREE/i.test(original) || normalized.includes('FREE');

  // Code-style: BUY3GET1FREE, BUY2GET1, B3G1
  let match = normalized.match(/(?:BUY|B)(\d+)(?:GET|G)(\d+)/);

  // Readable-style: "Buy 3 Get 1 Free"
  if (!match) {
    const readable = original.match(/buy\s*(\d+)\s*get\s*(\d+)/i);
    if (readable) {
      match = /** @type {RegExpMatchArray} */ ([readable[0], readable[1], readable[2]]);
    }
  }

  if (!match) return null;

  const buyQuantity = Number(match[1]);
  const freeQuantity = Number(match[2]);

  if (!Number.isFinite(buyQuantity) || !Number.isFinite(freeQuantity)) return null;
  if (buyQuantity <= 0 || freeQuantity <= 0) return null;

  // Skip amount-off codes like BUY3GET26 (26 is % / value, not free qty).
  if (freeQuantity > 5 && !hasFreeToken) return null;

  // Prefer free-item promos; allow small GET counts without FREE (e.g. BUY2GET1).
  if (!hasFreeToken && freeQuantity > 2) return null;

  return { buyQuantity, freeQuantity };
}

/**
 * Collect all BXGY patterns from discount labels.
 * @param {unknown} rawLabels
 * @returns {BxgyPattern[]}
 */
export function parseBuyXGetYPatterns(rawLabels) {
  /** @type {BxgyPattern[]} */
  const patterns = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const label of normalizeDiscountLabels(rawLabels)) {
    const pattern = parseBuyXGetY(label);
    if (!pattern) continue;
    const key = `${pattern.buyQuantity}:${pattern.freeQuantity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push(pattern);
  }

  return patterns;
}

/**
 * Pick the best matching BXGY pattern for a target quantity.
 * @param {unknown} rawLabels
 * @param {number} [quantity]
 * @returns {BxgyPattern | null}
 */
export function pickBuyXGetYPattern(rawLabels, quantity) {
  const patterns = parseBuyXGetYPatterns(rawLabels);
  if (patterns.length === 0) return null;

  if (Number.isFinite(quantity) && /** @type {number} */ (quantity) > 0) {
    const qty = /** @type {number} */ (quantity);
    const matching = patterns.find((pattern) => {
      const setSize = pattern.buyQuantity + pattern.freeQuantity;
      return qty % setSize === pattern.buyQuantity;
    });
    if (matching) return matching;
  }

  return patterns[0] || null;
}

/**
 * If quantity is exactly the "buy" remainder of a BXGY set, add free units.
 * e.g. Buy 3 Get 1 Free: 3 → 4, 7 → 8
 * @param {number} quantity
 * @param {unknown} rawLabels
 * @returns {number}
 */
export function adjustQuantityForBuyXGetY(quantity, rawLabels) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return quantity;

  const pattern = pickBuyXGetYPattern(rawLabels, qty);
  if (!pattern) return qty;

  const setSize = pattern.buyQuantity + pattern.freeQuantity;
  if (qty % setSize === pattern.buyQuantity) {
    return qty + pattern.freeQuantity;
  }

  return qty;
}

/**
 * Adjust an add-to-cart quantity so the resulting cart line includes free units.
 * @param {number} existingQuantity
 * @param {number} addQuantity
 * @param {unknown} rawLabels
 * @returns {number}
 */
export function adjustAddQuantityForBuyXGetY(existingQuantity, addQuantity, rawLabels) {
  const existing = Number(existingQuantity) || 0;
  const addQty = Number(addQuantity) || 0;
  if (addQty <= 0) return addQuantity;

  const target = existing + addQty;
  const adjustedTarget = adjustQuantityForBuyXGetY(target, rawLabels);
  if (adjustedTarget === target) return addQty;

  return addQty + (adjustedTarget - target);
}
