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

// Pessoas fake. Os quatro "GLOBAL EPROC" existem para exercitar o seed do picker;
// os outros dois so provam que a busca por prefixo filtra mesmo.
const PEOPLE = [
  { Id: '51000001', Name: 'GLOBAL EPROC 1 GRAU E COLEGIO RECURSAL', Upn: 'global.eproc1@tjsp.jus.br' },
  { Id: '51000002', Name: 'GLOBAL EPROC 2 GRAU',                    Upn: 'global.eproc2@tjsp.jus.br' },
  { Id: '51000003', Name: 'GLOBAL EPROC ENTIDADE CONVENIADA',       Upn: 'global.eproc3@tjsp.jus.br' },
  { Id: '51000004', Name: 'GLOBAL EPROC PUBLICO EXTERNO',           Upn: 'global.eproc4@tjsp.jus.br' },
  { Id: '11111',    Name: 'FULANO DE TAL',                          Upn: 'fulano@tjsp.jus.br' },
  { Id: '22222',    Name: 'BELTRANO DA SILVA',                      Upn: 'beltrano@tjsp.jus.br' },
];

// Reproduz o range de prefixo que o script usa (o SMAX nao aceita LIKE em Person).
const queryPeople = (filter) => {
  const byId = /Id\s*=\s*'([^']*)'/.exec(filter || '');
  if (byId) return PEOPLE.filter(p => p.Id === byId[1]);
  const range = /Name\s*>=\s*'([^']*)'\s+and\s+Name\s*<\s*'([^']*)'/.exec(filter || '');
  if (!range) return PEOPLE;
  return PEOPLE.filter(p => p.Name >= range[1] && p.Name < range[2]);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
});

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (/^\/rest\/\d+\/ems\/Person$/i.test(url)) {
    const filter = new URL(req.url, 'http://x').searchParams.get('filter') || '';
    const hits = queryPeople(filter);
    console.log(`[mock] GET ems/Person filter=${filter} → ${hits.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK', total_count: hits.length },
      entities: hits.map(p => ({ entity_type: 'Person', properties: p }))
    }));
    return;
  }

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
