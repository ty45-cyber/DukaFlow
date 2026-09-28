const $ = (id) => document.getElementById(id);

let ws = null;
let audioCtx = null;
let mediaStream = null;
let processor = null;
let sessionReady = false;
let sessionId = null;
let muted = false;
let latestUserText = '';
let userTurns = [];
let pendingTools = [];
let scheduledSources = [];
let playbackTime = 0;
let selectedPrompt = '';
let currentItems = [];
let currentZone = '';
let lastOrderId = null;
let demoMode = false;
let demoTimer = null;

const toolDefs = [
  {type:'function',name:'search_products',description:'Search the live merchant catalog. Never invent a product.',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}},
  {type:'function',name:'check_inventory',description:'Check live stock before making any availability claim.',parameters:{type:'object',properties:{productId:{type:'string'},quantity:{type:'integer'}},required:['productId','quantity']}},
  {type:'function',name:'calculate_cart',description:'Calculate exact current price and delivery total before final confirmation.',parameters:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{productId:{type:'string'},quantity:{type:'integer'}},required:['productId','quantity']}},zone:{type:'string'}},required:['items']}},
  {type:'function',name:'create_order',description:'Create the order only after explicit customer confirmation. Evidence is mandatory and server validated.',parameters:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{productId:{type:'string'},quantity:{type:'integer'}},required:['productId','quantity']}},zone:{type:'string'},idempotencyKey:{type:'string'},sessionId:{type:'string'},evidence:{type:'object'}},required:['items','idempotencyKey','sessionId']}},
  {type:'function',name:'request_payment',description:'Create a sandbox payment request for a confirmed order. No real money moves.',parameters:{type:'object',properties:{orderId:{type:'string'}},required:['orderId']}},
  {type:'function',name:'get_order_status',description:'Get a current order status.',parameters:{type:'object',properties:{orderId:{type:'string'}},required:['orderId']}}
];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const kes = (minor) => `KSh ${(Number(minor || 0) / 100).toLocaleString('en-KE',{minimumFractionDigits:2})}`;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function setAppStatus(text, live = false) {
  $('statusText')?.textContent && ($('statusText').textContent = text);
  $('sessionLabel').textContent = live ? 'Listening' : text;
  $('miniStatus').textContent = live ? 'Mic on · Speak naturally' : 'Mic off · Your turn starts the conversation';
  $('conversationBadge').textContent = live ? 'Live' : 'Idle';
  document.body.classList.toggle('status-live', live);
  $('connectBtn').classList.toggle('is-live', live);
  $('voiceButtonText').textContent = live ? 'End session' : 'Tap to talk';
  $('voiceButtonSub').textContent = live ? 'Listening' : 'Speak naturally';
  $('connectBtn').setAttribute('aria-label', live ? 'End voice session' : 'Start voice shopping');
  $('voiceHeadline').textContent = live ? 'I’m listening.' : 'Tell me what to buy.';
}

function setStage(stage) {
  document.querySelectorAll('[data-stage-label]').forEach(el => {
    const key = el.dataset.stageLabel;
    const rank = {say:1, check:2, confirm:3}[key];
    const current = {say:1, check:2, confirm:3}[stage] || 1;
    el.classList.toggle('active', rank === current);
    el.classList.toggle('complete', rank < current);
  });
}

function scrollToWorkspace() {
  $('workspace')?.scrollIntoView({behavior:'smooth',block:'start'});
}

function addBubble(role, text) {
  if (!text) return;
  const t = $('transcript');
  if (t.querySelector('.transcript-empty')) t.innerHTML = '';
  const d = document.createElement('div');
  d.className = `bubble ${role}`;
  d.textContent = text;
  t.appendChild(d);
  $('turnCount').textContent = `${t.querySelectorAll('.bubble').length} turns`;
  t.scrollTop = t.scrollHeight;
}

function addTool(text) {
  const t = $('transcript');
  if (t.querySelector('.transcript-empty')) t.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'tool';
  d.textContent = text;
  t.appendChild(d);
  t.scrollTop = t.scrollHeight;
}

async function post(path, payload) {
  const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Request failed');
  return j;
}

async function getJson(path) {
  const r = await fetch(path,{cache:'no-store'});
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  return r.json();
}

function updateReality(key, text, state = 'good') {
  const el = $(`${key}State`);
  if (!el) return;
  el.textContent = text;
  const item = el.closest('.reality-item');
  item.classList.toggle('good', state === 'good');
  item.classList.toggle('blocked', state === 'blocked');
}

function updateGate(fields, msg, state = 'locked') {
  const normalized = Array.isArray(fields) ? fields : [];
  const okCount = normalized.filter(f => f.ok).length;
  const total = normalized.length || 5;
  const progress = okCount / total * 100;

  $('gateItems').innerHTML = normalized.map(f => `<span class="${f.ok ? 'ok':''}">${f.ok ? '✓' : '○'} ${escapeHtml(f.label)}</span>`).join('');
  $('gateProgressText').textContent = `${okCount} / ${total}`;
  $('gateProgressBar').style.width = `${progress}%`;
  $('gateMsg').textContent = msg;
  $('confirmationStatus').textContent = state === 'ready'
    ? 'Complete: the order is ready for explicit confirmation.'
    : state === 'blocked'
      ? 'Blocked: the transaction cannot execute with the current evidence.'
      : 'Awaiting a complete, explicit confirmation.';

  const badge = $('lockBadge');
  badge.classList.toggle('ready', state === 'ready');
  badge.classList.toggle('blocked', state === 'blocked');
  badge.innerHTML = state === 'ready' ? '<span>●</span> Ready' : state === 'blocked' ? '<span>●</span> Blocked' : '<span>●</span> Locked';
  $('confirmationCard').classList.toggle('blocked-card', state === 'blocked');
  $('confirmationCard').classList.toggle('ready-card', state === 'ready');
  $('proofText').textContent = state === 'blocked'
    ? 'DukaFlow found a missing or conflicting fact, so the transaction stops here instead of guessing.'
    : state === 'ready'
      ? 'Every consequential field is resolved, and explicit authorization is the final gate.'
      : 'Each consequential field must trace back to customer intent plus live business state.';
}

function renderResolution(results, query = '') {
  const panel = $('resolutionPanel');
  if (!Array.isArray(results) || !results.length) {
    panel.className = 'resolution-panel resolution-empty';
    panel.innerHTML = '<div class="resolution-icon">!</div><strong>No confident product match</strong><span>DukaFlow will ask for a clearer product instead of inventing one.</span>';
    return;
  }

  const ambiguous = results.length > 1;
  panel.className = 'resolution-panel';
  panel.innerHTML = `
    <div class="resolution-header">
      <div><span class="resolution-label">${ambiguous ? 'AMBIGUOUS MATCH' : 'RESOLVED'}</span><strong>${ambiguous ? `“${escapeHtml(query)}” needs a choice` : escapeHtml(results[0].name)}</strong></div>
      <span class="match-score">${ambiguous ? results.length + ' candidates' : `${Math.round(results[0].score * 100)}% match`}</span>
    </div>
    <div class="match-list">${results.slice(0,4).map(x => `<div class="match-card"><strong>${escapeHtml(x.name)}</strong><small>${escapeHtml(x.price)} · ${escapeHtml(x.stock)} in stock</small><span class="match-score">${Math.round(x.score*100)}% match</span></div>`).join('')}</div>
    ${ambiguous ? '<div class="block-notice">Action paused. The agent must clarify the exact variant before a cart can be considered verified.</div>' : ''}
  `;
}

function updateCart(items, zone = '', totals = null) {
  currentItems = Array.isArray(items) ? items : [];
  currentZone = zone || currentZone;
  if (!currentItems.length) {
    $('cartPreview').innerHTML = '<div class="cart-empty"><strong>Order candidate is empty.</strong><span>Say what you need and we’ll build it from verified data.</span></div>';
    $('previewState').textContent = 'Waiting';
    return;
  }

  const subtotal = currentItems.reduce((sum, i) => sum + Number(i.lineTotalMinor ?? ((i.priceMinor || 0) * Number(i.quantity || 1))), 0);
  const delivery = Number(totals?.deliveryMinor || 0);
  const total = Number(totals?.totalMinor ?? subtotal + delivery);
  $('cartPreview').innerHTML = currentItems.map(i => `
    <div class="cart-item">
      <div><strong>${escapeHtml(i.name || i.productId)}</strong><small>${escapeHtml(i.quantity)} × ${kes(i.unitPriceMinor ?? i.priceMinor)}</small></div>
      <strong>${kes(i.lineTotalMinor ?? ((i.priceMinor || 0) * i.quantity))}</strong>
    </div>
  `).join('') + (zone ? `<div class="cart-item"><div><strong>Delivery</strong><small>${escapeHtml(zone)}</small></div><span class="live-tag">LIVE</span></div>` : '') + `<div class="cart-total"><span>Current calculated total</span><strong>${kes(total)}</strong></div>`;
  $('previewState').textContent = zone ? 'Verified' : 'Building';
}

function renderOrders(orders) {
  $('orderCount').textContent = `${orders.length} order${orders.length === 1 ? '' : 's'}`;
  $('orders').innerHTML = orders.length ? orders.map(x => `
    <div class="order">
      <div><strong>${escapeHtml(x.id)}</strong><small>${x.items.map(i => `${escapeHtml(i.quantity)}× ${escapeHtml(i.name)}`).join(', ')}${x.zone ? ` · ${escapeHtml(x.zone)}` : ''}<br>${kes(x.totalMinor)}</small></div>
      <div class="state">${escapeHtml(x.status)}</div>
    </div>`).join('') : '<div class="orders-empty">No orders yet.</div>';
}

function renderAudit(events) {
  $('audit').innerHTML = events.length ? events.slice(0,30).map(e => {
    const label = String(e.type || 'event').replaceAll('_',' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    const blocked = String(e.type || '').includes('BLOCKED');
    const detail = e.orderId ? `Order ${e.orderId}` : e.tool ? e.tool : e.sessionId ? 'Voice session' : '';
    return `<div class="auditrow"><span>${escapeHtml(new Date(e.createdAt || e.at || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</span><div>${escapeHtml(label)}<small>${escapeHtml(detail)}</small></div><strong class="${blocked ? 'audit-blocked':'audit-ok'}">${blocked ? 'Blocked' : 'Recorded'}</strong></div>`;
  }).join('') : '<div class="orders-empty">Your transaction trace will appear here.</div>';
}

async function refresh() {
  try {
    const [m, orders, events] = await Promise.all([getJson('/api/metrics'), getJson('/api/orders'), getJson('/api/events')]);
    $('mOrders').textContent = m.ordersToday;
    $('mPaid').textContent = m.paidOrders;
    $('mStock').textContent = m.inventoryUnits;
    $('mBlocks').textContent = m.evidenceBlocks;
    renderOrders(orders);
    renderAudit(events);
  } catch {
    $('miniStatus').textContent = 'Unable to refresh merchant view';
  }
}

function floatToPcmBase64(ab) {
  const bytes = new Uint8Array(ab);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToInt16(s) {
  const bin = atob(s), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function stopAudio() {
  for (const src of scheduledSources) { try { src.stop(); } catch {} }
  scheduledSources = [];
  playbackTime = audioCtx?.currentTime || 0;
}

function playPcm(b64) {
  if (!audioCtx) return;
  const pcm = base64ToInt16(b64);
  const buf = audioCtx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination);
  playbackTime = Math.max(playbackTime, audioCtx.currentTime);
  src.start(playbackTime); playbackTime += buf.duration;
  scheduledSources.push(src); src.onended = () => scheduledSources = scheduledSources.filter(x => x !== src);
}

async function buildEvidence(args) {
  const products = await getJson('/api/products');
  const conversation = userTurns.join(' ');
  const records = [];
  for (const item of (args.items || [])) {
    const p = products.find(x => x.id === item.productId);
    const aliases = [p?.name, ...(p?.aliases || [])].filter(Boolean);
    const productQuote = [...userTurns].reverse().find(t => aliases.some(a => t.toLowerCase().includes(a.toLowerCase()))) || conversation;
    const quantityWords = [String(item.quantity), item.quantity === 1 ? 'one' : '', item.quantity === 2 ? 'two' : '', item.quantity === 3 ? 'three' : '', item.quantity === 4 ? 'four' : '', item.quantity === 5 ? 'five' : ''].filter(Boolean);
    const quantityQuote = [...userTurns].reverse().find(t => quantityWords.some(a => t.toLowerCase().includes(a))) || conversation;
    records.push({field:'product',value:p?.name,quote:productQuote,productId:item.productId});
    records.push({field:'quantity',value:item.quantity,quote:quantityQuote});
  }
  if (args.zone) records.push({field:'zone',value:args.zone,quote:[...userTurns].reverse().find(t => t.toLowerCase().includes(String(args.zone).toLowerCase())) || conversation});
  return {records, latestUserText, conversationUserText:conversation};
}

async function handleToolCall(call) {
  const args = {...(call.arguments || {}), sessionId};
  if (call.name === 'search_products') {
    const result = await post('/api/tools',{name:call.name,arguments:args});
    renderResolution(result.result || [], args.query || '');
    const ambiguous = (result.result || []).length > 1;
    setStage('check');
    $('previewState').textContent = ambiguous ? 'Clarify' : 'Matched';
    updateReality('catalog', ambiguous ? 'Choice needed' : 'Resolved', ambiguous ? 'blocked' : 'good');
    if (ambiguous) updateGate([{label:'Product',ok:false},{label:'Variant',ok:false},{label:'Quantity',ok:false},{label:'Destination',ok:false},{label:'Authorization',ok:false}], 'Action paused: DukaFlow needs the exact product variant before moving forward.', 'blocked');
    return result.result;
  }

  if (call.name === 'check_inventory') {
    const result = await post('/api/tools',{name:call.name,arguments:args});
    updateReality('stock', result.result?.ok ? `${result.result.available} available` : 'Not available', result.result?.ok ? 'good' : 'blocked');
    return result.result;
  }

  if (call.name === 'calculate_cart') {
    const result = await post('/api/tools',{name:call.name,arguments:args});
    updateCart(result.result?.items || args.items || [], result.result?.zone || args.zone || '', result.result);
    currentZone = result.result?.zone || args.zone || currentZone;
    updateReality('price', result.result?.total || 'Calculated', 'good');
    updateReality('delivery', result.result?.zone ? result.result.zone : 'Pickup / unspecified', 'good');
    updateReality('catalog', 'Resolved', 'good');
    updateReality('stock', 'Checked', 'good');
    setStage('confirm');
    updateGate([
      {label:'Product',ok:true},{label:'Variant',ok:true},{label:'Quantity',ok:true},{label:'Destination',ok:Boolean(result.result?.zone)},{label:'Authorization',ok:false}
    ], 'Verified data is ready. The final step is explicit authorization.', 'locked');
    return result.result;
  }

  if (call.name === 'create_order') {
    args.evidence = await buildEvidence(args);
    args.idempotencyKey = args.idempotencyKey || `${sessionId}-${Date.now()}`;
    const result = await post('/api/tools',{name:call.name,arguments:args});
    if (result.result?.order) showOrderCreated(result.result.order);
    return result.result;
  }

  if (call.name === 'request_payment') {
    const result = await post('/api/tools',{name:call.name,arguments:args});
    $('previewState').textContent = 'Payment pending';
    $('gateMsg').textContent = 'Sandbox payment request created · no real money moved.';
    return result.result;
  }

  if (call.name === 'get_order_status' || call.name === 'simulate_payment' || call.name === 'cancel_order') {
    const result = await post('/api/tools',{name:call.name,arguments:args});
    return result.result;
  }

  return post('/api/tools',{name:call.name,arguments:args}).then(x => x.result);
}

function showOrderCreated(order) {
  lastOrderId = order.id;
  setStage('confirm');
  updateGate([
    {label:'Product',ok:true},{label:'Variant',ok:true},{label:'Quantity',ok:true},{label:'Destination',ok:true},{label:'Authorization',ok:true}
  ], `Order ${order.id} created. Stock is reserved and payment is a separate sandbox step.`, 'ready');
  $('previewState').textContent = 'Created';
  $('completionCard').hidden = false;
  $('completionTitle').textContent = `Order ${order.id} is ready.`;
  $('completionMessage').textContent = 'The transaction crossed the evidence gate. Payment remains a separate, explicitly sandboxed boundary.';
  $('completionSummary').innerHTML = `Total<strong>${kes(order.totalMinor)}</strong>`;
  $('completionCard').scrollIntoView({behavior:'smooth',block:'nearest'});
}

async function connect() {
  if (ws) { disconnect(); return; }
  demoMode = false;
  setAppStatus('Connecting…');
  const tk = await getJson('/api/voice-token');
  if (!tk.token) throw new Error(tk.error?.message || 'AssemblyAI is not configured.');

  sessionId = crypto.randomUUID();
  userTurns = [];
  latestUserText = '';
  pendingTools = [];
  sessionReady = false;
  currentItems = [];
  currentZone = '';
  $('completionCard').hidden = true;
  updateCart([]);
  updateGate([{label:'Product',ok:false},{label:'Variant',ok:false},{label:'Quantity',ok:false},{label:'Destination',ok:false},{label:'Authorization',ok:false}], 'DukaFlow will verify the order before it executes.', 'locked');

  audioCtx = new AudioContext({sampleRate:24000});
  await audioCtx.audioWorklet.addModule('/pcm-processor.js');
  mediaStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(tk.token)}`);

  ws.onopen = async () => {
    const keyterms = await getJson('/api/keyterms').then(x => x.keyterms);
    const systemPrompt = `You are DukaFlow, a strict but friendly voice procurement agent for Kisumu Fresh Mart. Keep replies to 1-2 short sentences. Use tools for live catalog, stock, prices and order status. Never invent products, stock or prices. Ask for clarification whenever product resolution is ambiguous. Before create_order, state final items, quantities, destination and total, then get explicit confirmation. Never claim payment succeeded; only request a sandbox payment and clearly call it sandbox. When the customer corrects product, quantity or destination, recalculate. Never create an order without evidence. For repeat orders, use current tools to revalidate stock and price before proposing the order. Memory is only a candidate, never authorization.`;
    ws.send(JSON.stringify({type:'session.update',session:{system_prompt:systemPrompt,greeting:'Hi — this is DukaFlow. Tell me what you need.',output:{voice:'anna'},tools:toolDefs,keyterms}}));
  };

  ws.onmessage = async (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'session.ready') {
      sessionReady = true; sessionId = ev.session_id || sessionId;
      setAppStatus('Listening', true); $('muteBtn').disabled = false; startMic();
      setStage('say');
    } else if (ev.type === 'transcript.user') {
      latestUserText = ev.text || '';
      userTurns.push(latestUserText);
      addBubble('user', latestUserText);
      $('voiceHint').textContent = 'Listening…';
      setStage('say');
      await post('/api/voice-events',{sessionId,type:'user',text:latestUserText}).catch(()=>{});
    } else if (ev.type === 'transcript.agent') {
      addBubble('agent',ev.text || '');
      $('voiceHint').textContent = 'Your turn — say the next thing.';
      await post('/api/voice-events',{sessionId,type:'agent',text:ev.text || ''}).catch(()=>{});
    } else if (ev.type === 'reply.audio') {
      if (!muted) playPcm(ev.data);
    } else if (ev.type === 'tool.call') {
      pendingTools.push(ev);
      addTool(`Checking ${String(ev.name).replaceAll('_',' ')}…`);
    } else if (ev.type === 'reply.done') {
      if (ev.status === 'interrupted') { pendingTools = []; stopAudio(); }
      else if (pendingTools.length) {
        for (const call of pendingTools) {
          try {
            const result = await handleToolCall(call);
            ws.send(JSON.stringify({type:'tool.result',call_id:call.call_id,result:JSON.stringify(result)}));
          } catch (err) {
            if (call.name === 'create_order') updateGate([{label:'Product',ok:false},{label:'Variant',ok:false},{label:'Quantity',ok:false},{label:'Destination',ok:false},{label:'Authorization',ok:false}], err.message, 'blocked');
            ws.send(JSON.stringify({type:'tool.result',call_id:call.call_id,result:JSON.stringify({error:err.message})}));
          }
        }
        pendingTools = [];
        refresh();
      }
    } else if (ev.type === 'session.ended') disconnect();
    else if (ev.type === 'error' || ev.type === 'session.error') {
      addBubble('agent',ev.message || 'Voice session error.');
      setAppStatus('Session error');
    }
  };
  ws.onerror = () => setAppStatus('Voice connection error');
  ws.onclose = () => {
    stopMic(); sessionReady = false; $('muteBtn').disabled = true; setAppStatus('Disconnected'); ws = null; refresh();
  };
}

function startMic() {
  const src = audioCtx.createMediaStreamSource(mediaStream);
  processor = audioCtx.createScriptProcessor(4096,1,1);
  processor.onaudioprocess = (e) => {
    if (!sessionReady || muted || !ws || ws.readyState !== 1) return;
    const input = e.inputBuffer.getChannelData(0), pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) { const s = Math.max(-1,Math.min(1,input[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    ws.send(JSON.stringify({type:'input.audio',audio:floatToPcmBase64(pcm.buffer)}));
  };
  src.connect(processor); processor.connect(audioCtx.destination);
}

function stopMic() {
  try { processor?.disconnect(); } catch {}
  try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
  processor = null; mediaStream = null;
}

function disconnect() {
  try { ws?.send(JSON.stringify({type:'session.end'})); } catch {}
  try { ws?.close(); } catch {}
  stopMic(); stopAudio(); setAppStatus('Disconnected'); $('muteBtn').disabled = true; sessionReady = false; ws = null;
}

function loadPrompt(prompt) {
  selectedPrompt = prompt;
  $('voiceHint').textContent = `Try saying: ${prompt}`;
  document.querySelectorAll('.example-chip').forEach(b => b.classList.toggle('selected', b.dataset.prompt === prompt));
  $('voiceStage').scrollIntoView({behavior:'smooth',block:'center'});
}

async function runWalkthrough() {
  if (ws) disconnect();
  if (demoTimer) clearTimeout(demoTimer);
  demoMode = true;
  sessionId = `demo-${crypto.randomUUID()}`;
  userTurns = [];
  latestUserText = '';
  pendingTools = [];
  currentItems = [];
  currentZone = 'Westlands';
  lastOrderId = null;
  $('completionCard').hidden = true;
  $('demoConfirmBtn').hidden = false;
  $('demoConfirmBtn').disabled = true;
  $('voiceButtonText').textContent = 'Walkthrough';
  $('voiceButtonSub').textContent = 'Watch the gate move';
  $('voiceHeadline').textContent = 'See the decision, step by step.';
  $('sessionLabel').textContent = 'Demo mode';
  $('miniStatus').textContent = 'Guided flow · no microphone needed';
  $('conversationBadge').textContent = 'Demo';
  scrollToWorkspace();

  const reset = await post('/api/reset',{});
  await refresh();
  await sleep(350);

  setStage('say');
  addBubble('user','I need three SunGold Cooking Oil 3L. Deliver to Westlands.');
  userTurns.push('I need three SunGold Cooking Oil 3L. Deliver to Westlands.');
  $('turnCount').textContent = '1 turn';
  await post('/api/voice-events',{sessionId,type:'user',text:userTurns[0]}).catch(()=>{});
  await sleep(550);

  setStage('check');
  addTool('Resolving product against live catalog…');
  const search = await post('/api/tools',{name:'search_products',arguments:{query:'SunGold Cooking Oil 3L',sessionId}});
  renderResolution(search.result || [], 'SunGold Cooking Oil 3L');
  updateReality('catalog','Exact match','good');
  await sleep(550);

  addTool('Checking live stock…');
  const stock = await post('/api/tools',{name:'check_inventory',arguments:{productId:'SKU-SG-3L',quantity:3,sessionId}});
  updateReality('stock',stock.result?.ok ? `${stock.result.available} available` : 'Unavailable',stock.result?.ok ? 'good':'blocked');
  await sleep(450);

  addTool('Calculating current total + delivery…');
  const cart = await post('/api/tools',{name:'calculate_cart',arguments:{items:[{productId:'SKU-SG-3L',quantity:3}],zone:'Westlands',sessionId}});
  currentItems = cart.result.items;
  updateCart(cart.result.items,'Westlands',cart.result);
  updateReality('price',cart.result.total,'good');
  updateReality('delivery','Westlands','good');
  updateGate([
    {label:'Product',ok:true},{label:'Variant',ok:true},{label:'Quantity',ok:true},{label:'Destination',ok:true},{label:'Authorization',ok:false}
  ],`Current total is ${cart.result.total}. Nothing has been placed yet.`,'locked');
  addBubble('agent',`I found SunGold 3L, three units, to Westlands. Total ${cart.result.total}. Shall I place the order?`);
  await sleep(500);
  $('demoConfirmBtn').disabled = false;
  $('confirmationStatus').textContent = 'The facts are verified. Your confirmation is the only missing input.';
  $('proofText').textContent = 'Product, variant, quantity and destination are verified from the conversation and live merchant state.';
}

async function confirmWalkthrough() {
  if (!demoMode || $('demoConfirmBtn').disabled) return;
  $('demoConfirmBtn').disabled = true;
  setStage('confirm');
  addBubble('user','Yes, place the order.');
  userTurns.push('Yes, place the order.');
  latestUserText = 'Yes, place the order.';
  await post('/api/voice-events',{sessionId,type:'user',text:latestUserText});
  addTool('Evidence gate received explicit authorization…');
  await sleep(350);
  const evidence = {
    latestUserText,
    conversationUserText:userTurns.join(' '),
    records:[
      {field:'product',value:'SunGold Cooking Oil 3L',quote:userTurns[0],productId:'SKU-SG-3L'},
      {field:'quantity',value:3,quote:userTurns[0]},
      {field:'zone',value:'Westlands',quote:userTurns[0]}
    ]
  };
  const created = await post('/api/tools',{name:'create_order',arguments:{items:[{productId:'SKU-SG-3L',quantity:3}],zone:'Westlands',idempotencyKey:`${sessionId}-order`,sessionId,evidence}});
  showOrderCreated(created.result.order);
  await refresh();
  await sleep(250);
  const payment = await post('/api/tools',{name:'request_payment',arguments:{orderId:created.result.order.id,sessionId}});
  $('previewState').textContent = 'Payment pending';
  $('gateMsg').textContent = 'Sandbox payment request created · no real money moved.';
  $('completionMessage').textContent = `Order ${created.result.order.id} is created. Payment request ${payment.result.reference} is sandbox-only and remains a separate trust boundary.`;
  addBubble('agent',`Done. ${created.result.order.id} is created and payment is pending in sandbox mode.`);
  await refresh();
}

async function resetDemo() {
  if (demoTimer) clearTimeout(demoTimer);
  demoMode = false;
  $('demoConfirmBtn').hidden = true;
  $('demoConfirmBtn').disabled = true;
  disconnect();
  await post('/api/reset',{});
  currentItems = [];
  currentZone = '';
  lastOrderId = null;
  userTurns = [];
  latestUserText = '';
  $('completionCard').hidden = true;
  $('voiceHint').textContent = 'Try: “Three SunGold 3L to Westlands.”';
  $('voiceHeadline').textContent = 'Tell me what to buy.';
  $('sessionLabel').textContent = 'Ready';
  $('voiceButtonText').textContent = 'Tap to talk';
  $('voiceButtonSub').textContent = 'Speak naturally';
  $('miniStatus').textContent = 'Mic off · Your turn starts the conversation';
  $('conversationBadge').textContent = 'Idle';
  $('transcript').innerHTML = '<div class="transcript-empty"><div class="empty-orb">◎</div><strong>Your voice will appear here.</strong><span>Use the mic or run the walkthrough to see the full transaction flow.</span></div>';
  $('turnCount').textContent = '0 turns';
  $('resolutionPanel').className = 'resolution-panel resolution-empty';
  $('resolutionPanel').innerHTML = '<div class="resolution-icon">◌</div><strong>Nothing resolved yet</strong><span>When you speak, product matches and live checks show up here.</span>';
  ['catalog','stock','price','delivery'].forEach(k => updateReality(k,'Waiting','good'));
  updateCart([]);
  updateGate([{label:'Product',ok:false},{label:'Variant',ok:false},{label:'Quantity',ok:false},{label:'Destination',ok:false},{label:'Authorization',ok:false}], 'DukaFlow will show the exact transaction and ask for an explicit confirmation before creating the order.', 'locked');
  setStage('say');
  await refresh();
}

$('connectBtn').onclick = () => connect().catch(e => { setAppStatus(e.message); addBubble('agent',e.message); });
$('heroTalkBtn').onclick = () => { scrollToWorkspace(); setTimeout(() => $('connectBtn').click(), 250); };
$('demoBtn').onclick = () => runWalkthrough().catch(e => addBubble('agent',`Walkthrough error: ${e.message}`));
$('demoConfirmBtn').onclick = () => confirmWalkthrough().catch(e => addBubble('agent',`Confirmation error: ${e.message}`));
$('muteBtn').onclick = () => { muted = !muted; $('muteBtn').textContent = muted ? 'Unmute' : 'Mute'; if (muted) stopAudio(); };
$('resetBtn').onclick = () => resetDemo().catch(e => addBubble('agent',`Reset failed: ${e.message}`));
document.querySelectorAll('.example-chip').forEach(b => b.addEventListener('click', () => loadPrompt(b.dataset.prompt)));

testAndInit();

async function testAndInit() {
  setStage('say');
  updateGate([{label:'Product',ok:false},{label:'Variant',ok:false},{label:'Quantity',ok:false},{label:'Destination',ok:false},{label:'Authorization',ok:false}], 'DukaFlow will show the exact transaction and ask for an explicit confirmation before creating the order.', 'locked');
  await refresh();
}
