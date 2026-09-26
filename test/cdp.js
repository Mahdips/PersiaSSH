// Minimal CDP client over raw WebSocket (no external deps) — grabs renderer state + console errors
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

function getTargets(){
  return new Promise((res,rej)=>{
    http.get('http://127.0.0.1:9223/json/list', r=>{
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d)));
    }).on('error',rej);
  });
}

class WS extends EventEmitter {
  constructor(url){
    super();
    const u = new URL(url);
    this.buf = Buffer.alloc(0);
    this.sock = net.connect(+u.port, u.hostname);
    const key = crypto.randomBytes(16).toString('base64');
    this.sock.on('connect',()=>{
      const req = `GET ${u.pathname}${u.search||''} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      this.sock.write(req);
    });
    this.sock.on('data', d=>{
      this.buf = Buffer.concat([this.buf, d]);
      if(!this.handshook){
        const idx = this.buf.indexOf('\r\n\r\n');
        if(idx < 0) return;
        this.handshook = true;
        this.buf = this.buf.slice(idx+4);
        this.emit('open');
      }
      this._drain();
    });
    this.sock.on('end',()=>this.emit('close'));
  }
  _drain(){
    for(;;){
      const b = this.buf;
      if(b.length < 2) return;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if(len === 126){ if(b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if(len === 127){ if(b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if(b.length < off + len) return;
      const payload = b.slice(off, off+len);
      this.buf = b.slice(off+len);
      if(op === 1) this.emit('message', payload.toString('utf8'));
      else if(op === 8){ this.emit('close'); return; }
    }
  }
  send(str){
    const payload = Buffer.from(str, 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if(payload.length < 126){ head = Buffer.from([0x81, 0x80 | payload.length]); }
    else if(payload.length < 65536){ head = Buffer.alloc(4); head[0]=0x81; head[1]=0xFE; head.writeUInt16BE(payload.length,2); }
    else { head = Buffer.alloc(10); head[0]=0x81; head[1]=0xFF; head.writeBigUInt64BE(BigInt(payload.length),2); }
    const masked = Buffer.alloc(payload.length);
    for(let i=0;i<payload.length;i++) masked[i] = payload[i] ^ mask[i%4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  close(){ try{ this.sock.end(); }catch(e){} }
}

(async()=>{
  const targets = await getTargets();
  const page = targets.find(t=>t.type==='page');
  if(!page){ console.log('NO PAGE TARGET'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl);
  let id=0; const pending=new Map();
  const send=(method,params={})=>new Promise((res)=>{
    const mid=++id; pending.set(mid,res);
    ws.send(JSON.stringify({id:mid,method,params}));
  });
  const logs=[];
  ws.on('message',m=>{
    const msg=JSON.parse(m);
    if(msg.id && pending.has(msg.id)){ pending.get(msg.id)(msg.result||msg); pending.delete(msg.id); return; }
    if(msg.method==='Runtime.consoleAPICalled'){
      const txt=(msg.params.args||[]).map(a=>a.value!==undefined?a.value:a.description||'').join(' ');
      logs.push(`[console.${msg.params.type}] ${txt}`);
    }
    if(msg.method==='Runtime.exceptionThrown'){
      const d=msg.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${d.text} :: ${d.exception? (d.exception.description||d.exception.value) : ''}`);
    }
  });
  await new Promise(r=>ws.on('open',r));
  await send('Runtime.enable');
  await send('Log.enable');

  const state = await send('Runtime.evaluate',{expression:`(()=>{ try{
    return JSON.stringify({
      hasApi: !!window.api,
      apiKeys: window.api? Object.keys(window.api) : null,
      hasXterm: typeof window.xterm,
      hasTerminalClass: typeof window.Terminal,
      hasFitAddon: typeof window.FitAddon,
      serverItems: document.querySelectorAll('.server-item').length,
      serverListChildren: document.getElementById('serverList')? document.getElementById('serverList').children.length : 'no#serverList',
      bodyChildren: document.body? document.body.children.length : 0,
      readyState: document.readyState,
      title: document.title
    }); }catch(e){ return 'EVAL-ERR '+e.message; } })()`, returnByValue:true});
  console.log('STATE:', JSON.stringify(state.result? state.result.value : state));
  await new Promise(r=>setTimeout(r,2500));
  console.log('LOGS('+logs.length+'):');
  logs.slice(0,30).forEach(l=>console.log('  ',l));
  ws.close(); process.exit(0);
})().catch(e=>{console.log('FATAL',e.message); process.exit(1)});
