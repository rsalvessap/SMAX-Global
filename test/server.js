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

// GitHub falso. Guarda UM arquivo em memoria e responde como a Contents API:
// GET devolve { sha, content } em base64, PUT exige o sha quando o arquivo ja
// existe. E o suficiente para exercitar a trava otimista por _version sem tocar
// num repositorio de verdade.
let ghFile = null;   // { sha, content }  content = texto, nao base64

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // Lido pela importacao (equivale ao raw.githubusercontent.com)
  if (url === '/gh/raw') {
    if (!ghFile) { res.writeHead(404); res.end('not found'); return; }
    console.log('[gh] GET raw');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(ghFile.content);
    return;
  }

  // Lido e gravado pela publicacao (equivale a api.github.com/.../contents/...)
  if (url === '/gh/contents') {
    if (req.method === 'GET') {
      if (!ghFile) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"message":"Not Found"}'); return; }
      console.log('[gh] GET contents');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sha: ghFile.sha, content: Buffer.from(ghFile.content, 'utf8').toString('base64') }));
      return;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const content = Buffer.from(String(body?.content || ''), 'base64').toString('utf8');
      if (ghFile && body?.sha !== ghFile.sha) {
        console.log('[gh] PUT recusado — sha divergente');
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end('{"message":"sha does not match"}');
        return;
      }
      ghFile = { sha: 'sha' + Date.now(), content };
      let v = '?';
      try { v = JSON.parse(content)._version; } catch { }
      console.log(`[gh] PUT aceito — _version=${v}, ${content.length} chars`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: { sha: ghFile.sha } }));
      return;
    }
  }

  // Atalhos do harness para forcar os cenarios de borda da fase 1.
  if (url === '/gh/zerar') {
    ghFile = null;
    console.log('[gh] arquivo apagado');
    res.writeHead(200); res.end('ok');
    return;
  }
  if (url === '/gh/bumpversion') {
    if (!ghFile) { res.writeHead(404); res.end('sem arquivo'); return; }
    const obj = JSON.parse(ghFile.content);
    obj._version = (Number(obj._version) || 0) + 5;
    ghFile = { sha: 'sha' + Date.now(), content: JSON.stringify(obj, null, 2) };
    console.log(`[gh] _version forcada para ${obj._version}`);
    res.writeHead(200); res.end(String(obj._version));
    return;
  }

  // Leitura de um Request so, usada pela conferencia da tela "Incluir global".
  // Cada fixture existe para forcar um dos estados possiveis; o 500 esta aqui de
  // proposito, porque falha de leitura tem de aparecer diferente de "nao existe".
  const umRequest = /^\/rest\/\d+\/ems\/Request\/(\d+)$/i.exec(url);
  if (umRequest && req.method === 'GET') {
    const id = umRequest[1];
    console.log(`[mock] GET ems/Request/${id}`);
    const resp = (props, rel) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        meta: { completion_status: 'OK' },
        entities: [{ entity_type: 'Request', properties: props, related_properties: rel || {} }]
      }));
    };
    if (id === '82133910') return resp({ Id: id, IsGlobal_c: 'true', GlobalId_c: null, DisplayLabel: 'GLOBAL — eproc 1o grau fora do ar' });
    // GlobalId_c apontando para si mesmo, e so em related_properties: o SMAX faz
    // isso em global de verdade, e o script nao pode ler como "e filho".
    if (id === '82140011') return resp({ Id: id, IsGlobal_c: true, DisplayLabel: 'GLOBAL — custas indevidas' }, { GlobalId_c: { Id: id } });
    if (id === '82150022') return resp({ Id: id, IsGlobal_c: 'false', DisplayLabel: 'Chamado comum de usuario' });
    if (id === '82160033') return resp({ Id: id, IsGlobal_c: 'false', DisplayLabel: 'Filho do global' }, { GlobalId_c: { Id: '82133910' } });
    if (id === '82170044') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"meta":{"completion_status":"FAILED"}}'); return; }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"meta":{"completion_status":"FAILED"},"error":{"message":"not found"}}');
    return;
  }

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
