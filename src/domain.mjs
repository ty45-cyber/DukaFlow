import crypto from 'node:crypto';

export const ORDER_STATES = Object.freeze({
  DRAFT: 'DRAFT', CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED', RESERVED: 'RESERVED',
  PAYMENT_PENDING: 'PAYMENT_PENDING', PAID: 'PAID', FULFILLING: 'FULFILLING', COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED'
});

const CONFIRMATION_RE = /\b(yes|yeah|yep|confirm|confirmed|place|order|buy|go ahead|do it|that's right|that is right|send it|proceed)\b/i;

function cents(kesMinor) { return Math.round(kesMinor); }
function normalize(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function similarity(query, candidate) {
  const q = new Set(normalize(query).split(' ').filter(Boolean));
  const c = new Set(normalize(candidate).split(' ').filter(Boolean));
  if (!q.size || !c.size) return 0;
  let overlap = 0;
  for (const token of q) if (c.has(token)) overlap++;
  return overlap / Math.max(q.size, c.size);
}

export function money(minor) { return `KSh ${(minor / 100).toLocaleString('en-KE', {minimumFractionDigits: 2})}`; }

export function searchProducts(store, query) {
  const q = normalize(query);
  if (!q) return [];
  const active = store.products.filter(p => p.active);
  const exact = active.filter(p => normalize(p.name) === q);
  const source = exact.length ? exact : active;
  const scored = source.map(p => {
    const values = [p.name, ...(p.aliases ?? [])];
    const score = exact.includes(p) ? 1 : Math.max(...values.map(v => {
      const n = normalize(v);
      return n.includes(q) || q.includes(n) ? Math.min(0.99, 0.72 + Math.min(0.24, q.length / 200)) : similarity(q, n);
    }));
    return { product: p, score };
  }).filter(x => x.score >= 0.35).sort((a,b) => b.score - a.score);
  return scored.slice(0, 5).map(({product:p, score}) => ({id:p.id,name:p.name,aliases:p.aliases,priceMinor:p.priceMinor,price:money(p.priceMinor),stock:p.stock,score:Number(score.toFixed(2))}));
}

export function checkInventory(store, productId, quantity) {
  const p = store.products.find(x => x.id === productId && x.active);
  if (!p) return {ok:false, code:'PRODUCT_NOT_FOUND', message:'Product not found.'};
  if (!Number.isInteger(quantity) || quantity < 1) return {ok:false, code:'INVALID_QUANTITY', message:'Quantity must be a positive whole number.'};
  return {ok:p.stock >= quantity, code:p.stock >= quantity ? 'AVAILABLE' : 'OUT_OF_STOCK', productId, product:p.name, requested:quantity, available:p.stock};
}

export function calculateCart(store, items, zone) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Cart must contain at least one item.');
  const normalized = items.map(item => {
    const p = store.products.find(x => x.id === item.productId && x.active);
    if (!p) throw new Error(`Product ${item.productId} not found.`);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Invalid quantity for ${p.name}.`);
    return {productId:p.id, name:p.name, quantity, unitPriceMinor:p.priceMinor, lineTotalMinor:p.priceMinor * quantity};
  });
  const delivery = zone && Object.hasOwn(store.business.deliveryZones, zone) ? store.business.deliveryZones[zone] * 100 : 0;
  const subtotal = normalized.reduce((sum, i) => sum + i.lineTotalMinor, 0);
  return {items:normalized, subtotalMinor:cents(subtotal), deliveryMinor:cents(delivery), totalMinor:cents(subtotal + delivery), subtotal:money(subtotal), delivery:money(delivery), total:money(subtotal + delivery), zone:zone ?? null};
}

export function findExistingOrder(store, idempotencyKey) {
  return store.orders.find(o => o.idempotencyKey === idempotencyKey);
}

function transitionAllowed(from, to) {
  const allowed = {
    [ORDER_STATES.DRAFT]: [ORDER_STATES.CONFIRMATION_REQUIRED, ORDER_STATES.CANCELLED],
    [ORDER_STATES.CONFIRMATION_REQUIRED]: [ORDER_STATES.RESERVED, ORDER_STATES.CANCELLED],
    [ORDER_STATES.RESERVED]: [ORDER_STATES.PAYMENT_PENDING, ORDER_STATES.EXPIRED, ORDER_STATES.CANCELLED],
    [ORDER_STATES.PAYMENT_PENDING]: [ORDER_STATES.PAID, ORDER_STATES.EXPIRED, ORDER_STATES.CANCELLED],
    [ORDER_STATES.PAID]: [ORDER_STATES.FULFILLING, ORDER_STATES.CANCELLED],
    [ORDER_STATES.FULFILLING]: [ORDER_STATES.COMPLETED],
    [ORDER_STATES.COMPLETED]: [], [ORDER_STATES.CANCELLED]: [], [ORDER_STATES.EXPIRED]: []
  };
  return (allowed[from] ?? []).includes(to);
}

export function assertTransition(from, to) { if (!transitionAllowed(from, to)) throw new Error(`Illegal order transition ${from} → ${to}.`); }

export function createOrder(store, {items, zone, idempotencyKey, sessionId, evidence}) {
  const existing = findExistingOrder(store, idempotencyKey);
  if (existing) return {order:existing, idempotent:true};
  const cart = calculateCart(store, items, zone);
  const evidenceGate = validateEvidence({store, items:cart.items, zone, evidence});
  if (!evidenceGate.allowed) throw Object.assign(new Error(evidenceGate.message), {code:'EVIDENCE_GATE_BLOCKED', details:evidenceGate});
  for (const item of cart.items) {
    const p = store.products.find(x => x.id === item.productId);
    if (p.stock < item.quantity) throw Object.assign(new Error(`Insufficient stock for ${p.name}.`), {code:'OUT_OF_STOCK'});
  }
  for (const item of cart.items) {
    const p = store.products.find(x => x.id === item.productId);
    p.stock -= item.quantity;
    store.reservations.push({id:crypto.randomUUID(),orderId:null,productId:p.id,quantity:item.quantity,status:'RESERVED',createdAt:new Date().toISOString()});
  }
  const order = {
    id:`DF-${String(store.orders.length + 1048).padStart(4,'0')}`,
    idempotencyKey, sessionId:sessionId ?? null, items:cart.items, zone,
    subtotalMinor:cart.subtotalMinor, deliveryMinor:cart.deliveryMinor, totalMinor:cart.totalMinor,
    status:ORDER_STATES.RESERVED, paymentStatus:'PENDING', createdAt:new Date().toISOString(), evidence:evidenceGate.records
  };
  for (const r of store.reservations.filter(x => !x.orderId).slice(-cart.items.length)) r.orderId = order.id;
  store.orders.push(order);
  assertTransition(ORDER_STATES.RESERVED, ORDER_STATES.PAYMENT_PENDING);
  order.status = ORDER_STATES.PAYMENT_PENDING;
  store.events.push({type:'ORDER_CREATED',orderId:order.id,createdAt:new Date().toISOString()});
  return {order,idempotent:false,evidenceGate};
}

export function validateEvidence({store, items, zone, evidence}) {
  const records = Array.isArray(evidence?.records) ? evidence.records : [];
  const userText = String(evidence?.latestUserText ?? '');
  const normalizedUser = normalize(userText);
  const conversationText = normalize(String(evidence?.conversationUserText ?? ''));
  const failures = [];
  const required = [];
  for (const item of items) {
    const p = store.products.find(x => x.id === item.productId);
    const record = records.find(r => r.field === 'product' && r.value === p?.name) ?? records.find(r => r.field === 'product' && r.productId === item.productId);
    if (!record) failures.push(`No evidence for product ${p?.name ?? item.productId}.`);
    else if (record.quote && conversationText && !conversationText.includes(normalize(record.quote))) failures.push(`Product evidence is not present in the recorded conversation for ${p?.name ?? item.productId}.`);
    else required.push({field:'product',value:p.name,quote:record.quote});
    const qtyRecord = records.find(r => r.field === 'quantity' && Number(r.value) === item.quantity);
    if (!qtyRecord) failures.push(`No evidence for quantity ${item.quantity} of ${p?.name ?? item.productId}.`);
    else if (qtyRecord.quote && conversationText && !conversationText.includes(normalize(qtyRecord.quote))) failures.push(`Quantity evidence is not present in the recorded conversation for ${p?.name ?? item.productId}.`);
    else required.push({field:'quantity',value:item.quantity,quote:qtyRecord.quote});
  }
  if (zone) {
    const zoneRecord = records.find(r => r.field === 'zone' && normalize(r.value) === normalize(zone));
    if (!zoneRecord) failures.push(`No evidence for delivery zone ${zone}.`);
    else if (zoneRecord.quote && conversationText && !conversationText.includes(normalize(zoneRecord.quote))) failures.push(`Delivery-zone evidence is not present in the recorded conversation.`);
    else required.push({field:'zone',value:zone,quote:zoneRecord.quote});
  }
  if (!CONFIRMATION_RE.test(normalizedUser)) failures.push('Explicit confirmation was not found in the latest user turn.');
  else required.push({field:'authorization',value:true,quote:userText});
  return {allowed:failures.length === 0, failures, message:failures.join(' '), records:required};
}

export function requestPayment(store, orderId) {
  const order = store.orders.find(o => o.id === orderId);
  if (!order) throw new Error('Order not found.');
  if (order.status !== ORDER_STATES.PAYMENT_PENDING) throw new Error(`Payment cannot be requested from ${order.status}.`);
  order.paymentStatus = 'PENDING';
  order.paymentReference = `DEMO-MPESA-${order.id}`;
  order.paymentMode = 'sandbox';
  store.events.push({type:'PAYMENT_REQUESTED',orderId,reference:order.paymentReference,createdAt:new Date().toISOString()});
  return {orderId, status:'PENDING', mode:'sandbox', reference:order.paymentReference, message:'Sandbox payment request created. No real money moved.'};
}

export function simulatePayment(store, orderId) {
  const order = store.orders.find(o => o.id === orderId);
  if (!order) throw new Error('Order not found.');
  if (order.status !== ORDER_STATES.PAYMENT_PENDING) throw new Error(`Payment cannot be confirmed from ${order.status}.`);
  order.paymentStatus = 'VERIFIED'; order.status = ORDER_STATES.PAID;
  store.events.push({type:'PAYMENT_VERIFIED_SANDBOX',orderId,createdAt:new Date().toISOString()});
  return {orderId,status:order.status,paymentStatus:order.paymentStatus,mode:'sandbox'};
}

export function releaseOrder(store, orderId) {
  const order = store.orders.find(o => o.id === orderId);
  if (!order) throw new Error('Order not found.');
  if (![ORDER_STATES.RESERVED, ORDER_STATES.PAYMENT_PENDING].includes(order.status)) throw new Error('Order has no active reservation.');
  for (const item of order.items) {
    const p = store.products.find(x => x.id === item.productId);
    p.stock += item.quantity;
  }
  order.status = ORDER_STATES.CANCELLED; order.paymentStatus = 'NOT_APPLICABLE';
  for (const r of store.reservations.filter(x => x.orderId === order.id)) r.status = 'RELEASED';
  store.events.push({type:'ORDER_CANCELLED',orderId,createdAt:new Date().toISOString()});
  return order;
}

export function buildKeyterms(store) {
  return [...new Set(store.products.flatMap(p => [p.name, ...(p.aliases ?? [])]))].slice(0, 100);
}

export function metrics(store) {
  const orders = store.orders;
  const paid = orders.filter(o => o.status === ORDER_STATES.PAID || o.status === ORDER_STATES.FULFILLING || o.status === ORDER_STATES.COMPLETED).length;
  const confirmed = orders.length;
  const sessions = Object.keys(store.voiceSessions).length;
  const blocked = store.events.filter(e => e.type === 'EVIDENCE_GATE_BLOCKED').length;
  return {ordersToday:orders.length, paidOrders:paid, voiceSessions:sessions, evidenceBlocks:blocked, inventoryUnits:store.products.reduce((a,p)=>a+p.stock,0), falseExecutionsTarget:0};
}
