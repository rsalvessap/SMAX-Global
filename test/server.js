// Servidor do harness: serve os arquivos e finge ser a API do SMAX.
// Precisa responder POST para dar pra exercitar o replay de verdade — criacao
// e marcacao "E Global" — sem tocar em producao.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8899;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

let nextId = 4567890;

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
});

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (/^\/rest\/\d+\//.test(url)) {
    const body = await readBody(req);
    const op = String(body?.operation || '').toUpperCase();
    const props = body?.entities?.[0]?.properties || {};
    console.log(`[mock] ${req.method} ${url} op=${op} Id=${props.Id ?? '(novo)'}`);

    const id = op === 'CREATE' ? String(nextId++) : String(props.Id || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK' },
      entity_result_list: [{
        entity: { entity_type: 'Request', properties: { Id: id } },
        completion_status: 'OK'
      }]
    }));
    return;
  }

  const file = path.join(ROOT, decodeURIComponent(url));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}/test/harness.html`));
