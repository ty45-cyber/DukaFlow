import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKeyterms, calculateCart, checkInventory, createOrder, metrics, requestPayment, searchProducts, simulatePayment, releaseOrder } from './domain.mjs';
import { readStore, resetStore, withStore } from './store.mjs';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(path.join(ROOT, '..', 'public'));
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8'};
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
const BODY_LIMIT = 64 * 1024; // 64 KB

// Rate limiter: max requests per window per IP
const rateLimits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = { '/api/voice-token': 10, '/api/tools': 120, default: 300 };
function checkRate(ip, pathname) {
  const max = RATE_MAX[pathname] ?? RATE_MAX.default;
  const key = `${ip}:${pathname}`;
  const now = Date.now();
  const entry = rateLimits.get(key) ?? { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_WINDOW_MS; }
  entry.count++;
  rateLimits.set(key, entry);
  return entry.count <= max;
}
// Prune stale rate-limit entries every 5 minutes
setInterval(() => { const now = Date.now(); for (const [k, v] of rateLimits) if (now > v.reset) rateLimits.delete(k); }, 300_000).unref();

const log = { info: (msg, meta={}) => console.log(JSON.stringify({level:'info',msg,...meta,time:new Date().toISOString()})), warn: (msg, meta={}) => console.warn(JSON.stringify({level:'warn',msg,...meta,time:new Date().toISOString()})), error: (msg, meta={}) => console.error(JSON.stringify({level:'error',msg,...meta,time:new Date().toISOString()})) };

function securityHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' wss://agents.assemblyai.com"
  };
}

function send(res, status, data, contentType='application/json; charset=utf-8', origin='') {
  res.writeHead(status, {'Content-Type':contentType,'Cache-Control':'no-store',...securityHeaders(origin)});
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
function jsonError(res, status, message, code='BAD_REQUEST', details=null, origin='') { send(res,status,{error:{code,message,details}},undefined,origin); }
async function body(req) {
  const chunks=[]; let total=0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_LIMIT) throw Object.assign(new Error('Request body too large.'),{code:'PAYLOAD_TOO_LARGE'});
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON.'),{code:'INVALID_JSON'}); }
}
async function token() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw Object.assign(new Error('ASSEMBLYAI_API_KEY is not configured on the server.'), {code:'ASSEMBLYAI_NOT_CONFIGURED'});
  // Fetch only from the known AssemblyAI endpoint — no user-supplied URL
  const r = await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=300',{headers:{Authorization:`Bearer ${key}`}});
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`AssemblyAI token request failed: ${r.status}`),{code:'ASSEMBLYAI_TOKEN_FAILED'});
  return JSON.parse(text);
}

async function route(req,res) {
  const origin = req.headers.origin || '';
  const ip = req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url, `http://localhost`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, securityHeaders(origin));
      return res.end();
    }
    if (!checkRate(ip, url.pathname)) return jsonError(res,429,'Too many requests.','RATE_LIMITED',null,origin);
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res,200,{ok:true,service:'dukaflow',time:new Date().toISOString(),assemblyaiConfigured:Boolean(process.env.ASSEMBLYAI_API_KEY)},undefined,origin);
    if (req.method === 'GET' && url.pathname === '/api/business') { const s=await readStore(); return send(res,200,s.business,undefined,origin); }
    if (req.method === 'GET' && url.pathname === '/api/products') { const s=await readStore(); return send(res,200,s.products.map(p=>({...p,price:`KSh ${(p.priceMinor/100).toLocaleString('en-KE',{minimumFractionDigits:2})}`})),undefined,origin); }
    if (req.method === 'GET' && url.pathname === '/api/orders') { const s=await readStore(); return send(res,200,s.orders.slice().reverse(),undefined,origin); }
    if (req.method === 'GET' && url.pathname === '/api/metrics') { const s=await readStore(); return send(res,200,metrics(s),undefined,origin); }
    if (req.method === 'GET' && url.pathname === '/api/events') { const s=await readStore(); return send(res,200,s.events.slice(-60).reverse(),undefined,origin); }
    if (req.method === 'GET' && url.pathname === '/api/keyterms') { const s=await readStore(); return send(res,200,{keyterms:buildKeyterms(s)},undefined,origin); }
    if (req.method === 'GET' && url.pathname === '/api/voice-token') { return send(res,200,await token(),undefined,origin); }
    if (req.method === 'POST' && url.pathname === '/api/reset') { await resetStore(); return send(res,200,{ok:true},undefined,origin); }
    if (req.method === 'POST' && url.pathname === '/api/voice-events') {
      const b=await body(req);
      const sessionId = typeof b.sessionId === 'string' ? b.sessionId.slice(0,128) : null;
      const type = typeof b.type === 'string' ? b.type : null;
      if(!sessionId||!type) return jsonError(res,400,'sessionId and type are required.',undefined,null,origin);
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return jsonError(res,400,'Invalid sessionId.',undefined,null,origin);
      await withStore(async s=>{ if(!s.voiceSessions[sessionId]) s.voiceSessions[sessionId]={user:[],agent:[],createdAt:new Date().toISOString()}; if(['user','agent'].includes(type)&&b.text) s.voiceSessions[sessionId][type].push({text:String(b.text).slice(0,2000),at:new Date().toISOString()}); s.events.push({type:`VOICE_${type.toUpperCase()}`,sessionId,text:String(b.text??'').slice(0,2000),at:new Date().toISOString()}); });
      return send(res,200,{ok:true},undefined,origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/tools') {
      const b=await body(req);
      const tool = typeof b.name === 'string' ? b.name : null;
      if (!tool) return jsonError(res,400,'Tool name is required.',undefined,null,origin);
      const ALLOWED_TOOLS = new Set(['search_products','check_inventory','calculate_cart','create_order','request_payment','simulate_payment','cancel_order','get_order_status']);
      if (!ALLOWED_TOOLS.has(tool)) return jsonError(res,400,`Unknown tool: ${tool}`,'UNKNOWN_TOOL',null,origin);
      const args = b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments) ? b.arguments : {};
      let out;
      try {
        await withStore(async s=>{
          if(tool==='search_products') out=searchProducts(s,String(args.query||'').slice(0,200));
          else if(tool==='check_inventory') out=checkInventory(s,String(args.productId||''),Number(args.quantity));
          else if(tool==='calculate_cart') out=calculateCart(s,args.items,args.zone);
          else if(tool==='create_order') {
            const sid = typeof args.sessionId === 'string' ? args.sessionId.slice(0,128) : null;
            let session = sid ? s.voiceSessions[sid] : null;
            const latestUser=(session?.user??[]).at(-1)?.text ?? String(args.latestUserText || args.evidence?.latestUserText || '');
            let evidence=args.evidence && typeof args.evidence === 'object' ? {...args.evidence} : {};
            evidence.latestUserText=latestUser;
            evidence.conversationUserText = (session?.user ?? []).map(x => x.text).join(' ');
            const result=createOrder(s,{...args,evidence,sessionId:sid}); out=result;
            if(result.order && sid) s.voiceSessions[sid] ||= {user:[],agent:[],createdAt:new Date().toISOString()};
          } else if(tool==='request_payment') out=requestPayment(s,String(args.orderId||''));
          else if(tool==='simulate_payment') out=simulatePayment(s,String(args.orderId||''));
          else if(tool==='cancel_order') out=releaseOrder(s,String(args.orderId||''));
          else if(tool==='get_order_status') { const o=s.orders.find(x=>x.id===String(args.orderId||'')); if(!o) throw new Error('Order not found.'); out=o; }
          s.events.push({type:'TOOL_EXECUTED',tool,success:true,at:new Date().toISOString()});
        });
      } catch (err) {
        log.warn('tool_error', {tool, code:err.code, message:err.message});
        try {
          await withStore(async s=>{
            const event={type:err.code === 'EVIDENCE_GATE_BLOCKED' ? 'EVIDENCE_GATE_BLOCKED' : 'TOOL_FAILED',tool,success:false,message:err.message,sessionId:typeof args.sessionId === 'string' ? args.sessionId : null,at:new Date().toISOString()};
            if (err.details) event.details=err.details;
            s.events.push(event);
          });
        } catch {}
        throw err;
      }
      return send(res,200,{ok:true,result:out},undefined,origin);
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(PUBLIC, '.' + path.normalize('/' + rel.replace(/^\//,'')));
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return jsonError(res,403,'Forbidden.','FORBIDDEN',null,origin);
    const ext = path.extname(file);
    if (!MIME[ext]) return jsonError(res,404,'Not found.','NOT_FOUND',null,origin);
    try {
      const data=await fs.readFile(file);
      const ct = MIME[ext];
      // Static assets: allow longer cache for JS/CSS, no-store for HTML
      const cc = ext === '.html' ? 'no-store' : 'public, max-age=3600';
      res.writeHead(200, {'Content-Type':ct,'Cache-Control':cc,...securityHeaders(origin)});
      return res.end(data);
    } catch { return jsonError(res,404,'Not found.','NOT_FOUND',null,origin); }
  } catch (err) {
    log.error('request_error', {method:req.method, path:url.pathname, code:err.code, message:err.message});
    const status = err.code === 'EVIDENCE_GATE_BLOCKED' ? 422 : err.code === 'ASSEMBLYAI_NOT_CONFIGURED' ? 503 : err.code === 'RATE_LIMITED' ? 429 : err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    return jsonError(res,status,err.message,err.code||'BAD_REQUEST',err.details||null,origin);
  }
}

http.createServer(route).listen(PORT,()=>log.info('server_started',{port:PORT,url:`http://localhost:${PORT}`}));
