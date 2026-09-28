import test from 'node:test';
import assert from 'node:assert/strict';
import { readStore, resetStore } from '../src/store.mjs';
import { calculateCart, checkInventory, createOrder, searchProducts, simulatePayment, requestPayment, ORDER_STATES } from '../src/domain.mjs';

test('product resolver surfaces ambiguous catalog aliases instead of hiding candidates', async () => {
  const s = await resetStore();
  const r = searchProducts(s,'big SunGold');
  assert.ok(r.length >= 2);
  assert.ok(r.some(x => x.id === 'SKU-SG-2L'));
  assert.ok(r.some(x => x.id === 'SKU-SG-3L'));
});

test('inventory check blocks oversell', async () => {
  const s = await resetStore();
  const r = checkInventory(s,'SKU-WT-10L',99);
  assert.equal(r.ok,false); assert.equal(r.code,'OUT_OF_STOCK');
});

test('evidence gate blocks missing confirmation', async () => {
  const s = await resetStore();
  assert.throws(()=>createOrder(s,{items:[{productId:'SKU-WT-10L',quantity:2}],zone:'CBD',idempotencyKey:'x1',evidence:{latestUserText:'two water please',records:[{field:'product',value:'Mineral Water 10L',quote:'water'},{field:'quantity',value:2,quote:'two'},{field:'zone',value:'CBD',quote:'CBD'}]}}),/Explicit confirmation/);
});

test('idempotent order creation does not double-deduct stock', async () => {
  const s = await resetStore();
  const evidence={latestUserText:'yes place the order',records:[{field:'product',value:'Mineral Water 10L',quote:'water'},{field:'quantity',value:2,quote:'two'},{field:'zone',value:'CBD',quote:'CBD'}]};
  const a=createOrder(s,{items:[{productId:'SKU-WT-10L',quantity:2}],zone:'CBD',idempotencyKey:'dup-1',evidence});
  const b=createOrder(s,{items:[{productId:'SKU-WT-10L',quantity:2}],zone:'CBD',idempotencyKey:'dup-1',evidence});
  assert.equal(a.order.id,b.order.id); assert.equal(b.idempotent,true);
  assert.equal(s.products.find(p=>p.id==='SKU-WT-10L').stock,10);
});

test('payment lifecycle is explicit and sandbox-labelled', async () => {
  const s = await resetStore();
  const evidence={latestUserText:'yes place the order',records:[{field:'product',value:'Mineral Water 10L',quote:'water'},{field:'quantity',value:1,quote:'one'},{field:'zone',value:'CBD',quote:'CBD'}]};
  const {order}=createOrder(s,{items:[{productId:'SKU-WT-10L',quantity:1}],zone:'CBD',idempotencyKey:'pay-1',evidence});
  const p=requestPayment(s,order.id); assert.equal(p.mode,'sandbox'); assert.equal(s.orders[0].status,ORDER_STATES.PAYMENT_PENDING);
  const paid=simulatePayment(s,order.id); assert.equal(paid.status,ORDER_STATES.PAID);
});


test('store write queue recovers after a rejected mutation', async () => {
  const { withStore } = await import('../src/store.mjs');
  await resetStore();
  await assert.rejects(() => withStore(async () => { throw new Error('intentional failure'); }), /intentional failure/);
  await withStore(async s => { s.events.push({type:'QUEUE_RECOVERED'}); });
  const s = await readStore();
  assert.ok(s.events.some(e => e.type === 'QUEUE_RECOVERED'));
});
