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

// Chamados fake. Os dois primeiros sao globais de verdade; o resto existe para
// forcar cada desfecho possivel da conferencia e da leitura em lote.
//   pai = valor de GlobalId_c. `relOnly` manda o campo so em related_properties,
//   que e como o SMAX devolve em parte dos casos.
const ID_ERRO_LEITURA = '82170044';   // responde 500 sempre
const ID_TETO = '82190066';           // faz a consulta em lote ser recusada pelo teto

const REQUESTS = [
  { Id: '82133910', IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — eproc 1o grau fora do ar', Status: 'InProgress', StatusSCCDSMAX_c: 'EmAtendimento_c', grupo: 'SUPORTE EPROC', CreateTime: 1757000000000, LastUpdateTime: 1758900000000 },
  // GlobalId_c apontando para si mesmo, e so em related_properties: o SMAX faz
  // isso em global de verdade, e nem a conferencia nem a contagem podem ler como filho.
  { Id: '82140011', IsGlobal_c: true, DisplayLabel: 'GLOBAL — custas indevidas', Status: 'Ready', StatusSCCDSMAX_c: 'Aguardando_c', grupo: 'SUPORTE CUSTAS', CreateTime: 1757100000000, LastUpdateTime: 1758910000000, pai: '82140011', relOnly: true },
  { Id: '82150022', IsGlobal_c: 'false', DisplayLabel: 'Chamado comum de usuario', Status: 'Ready', grupo: 'ATENDIMENTO', CreateTime: 1757200000000, LastUpdateTime: 1758920000000 },
  { Id: '82160033', IsGlobal_c: 'false', DisplayLabel: 'Filho do global', Status: 'Ready', grupo: 'ATENDIMENTO', CreateTime: 1757300000000, LastUpdateTime: 1758930000000, pai: '82133910', relOnly: true },
  // Mais filhos, para a contagem dar numero diferente por pai (3 e 1).
  { Id: '82160034', IsGlobal_c: 'false', DisplayLabel: 'Filho 2', Status: 'Ready', grupo: 'ATENDIMENTO', pai: '82133910' },
  { Id: '82160035', IsGlobal_c: 'false', DisplayLabel: 'Filho 3', Status: 'Ready', grupo: 'ATENDIMENTO', pai: '82133910', relOnly: true },
  { Id: '82160036', IsGlobal_c: 'false', DisplayLabel: 'Filho de outro global', Status: 'Ready', grupo: 'ATENDIMENTO', pai: '82140011' },
  // Marcado no painel mas desmarcado no SMAX: o painel tem de avisar.
  { Id: '82200077', IsGlobal_c: 'false', DisplayLabel: 'Era global e alguem desmarcou', Status: 'Complete', StatusSCCDSMAX_c: 'Concluido_c', grupo: 'SUPORTE EPROC', CreateTime: 1757400000000, LastUpdateTime: 1758940000000 },
  // Global valido na leitura individual (da para incluir), mas qualquer consulta
  // em lote que o cite e recusada pelo teto de 10.000 — e assim que se testa o
  // bloco que fica sem leitura no painel.
  { Id: ID_TETO, IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — consulta estoura o teto', Status: 'InProgress', grupo: 'SUPORTE EPROC', CreateTime: 1757600000000, LastUpdateTime: 1758960000000 }
];

// Um global com 600 filhos: passa da pagina de 250 do script e por isso exercita
// o laco de paginacao. Sem ele, um lote truncado passaria batido no teste.
const ID_MUITOS = '82210088';
REQUESTS.push({ Id: ID_MUITOS, IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — migracao de base (muitos filhos)', Status: 'InProgress', StatusSCCDSMAX_c: 'EmAtendimento_c', grupo: 'SUPORTE MIGRACAO', CreateTime: 1757500000000, LastUpdateTime: 1758950000000 });
for (let i = 0; i < 600; i++) {
  REQUESTS.push({
    Id: String(83000000 + i), IsGlobal_c: 'false', DisplayLabel: `Filho em massa ${i + 1}`,
    Status: 'Ready', grupo: 'ATENDIMENTO', pai: ID_MUITOS, relOnly: i % 2 === 0
  });
}

const entidadeDe = (r) => {
  const props = {
    Id: r.Id, DisplayLabel: r.DisplayLabel, IsGlobal_c: r.IsGlobal_c,
    Status: r.Status || '', StatusSCCDSMAX_c: r.StatusSCCDSMAX_c || '',
    PhaseId: r.PhaseId || '', AssignedToGroup: r.grupo ? '44444' : '',
    CreateTime: r.CreateTime || 0, LastUpdateTime: r.LastUpdateTime || 0
  };
  const rel = {};
  if (r.grupo) rel.AssignedToGroup = { Id: '44444', Name: r.grupo };
  if (r.pai) {
    if (r.relOnly) rel.GlobalId_c = { Id: r.pai };
    else props.GlobalId_c = { Id: r.pai };
  }
  return { entity_type: 'Request', properties: props, related_properties: rel };
};

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
    if (id === ID_ERRO_LEITURA) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"meta":{"completion_status":"FAILED"}}'); return; }
    const reg = REQUESTS.find(r => r.Id === id);
    if (!reg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"meta":{"completion_status":"FAILED"},"error":{"message":"not found"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ meta: { completion_status: 'OK' }, entities: [entidadeDe(reg)] }));
    return;
  }

  // Consulta em lote: estado dos globais (filter por Id) e contagem de filhos
  // (filter por GlobalId_c). Honra skip/size para exercitar a paginacao — sem
  // ela um lote truncado viraria um numero menor exibido como se fosse fato.
  if (/^\/rest\/\d+\/ems\/Request$/i.test(url) && req.method === 'GET') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const filter = qs.get('filter') || '';
    const size = Math.max(1, Number(qs.get('size')) || 100);
    const skip = Math.max(0, Number(qs.get('skip')) || 0);

    // Atalho do harness: se a cadeia contem o id de teto, responde como o SMAX
    // responde ao passar de 10.000 entidades.
    if (filter.includes(ID_TETO)) {
      console.log('[mock] GET ems/Request → recusado por teto de 10.000');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meta: { completion_status: 'FAILED' }, error: { messageKey: 'query.num.of.entities.exceeded', message: 'too many' } }));
      return;
    }
    if (filter.includes(ID_ERRO_LEITURA)) {
      console.log('[mock] GET ems/Request → 500 proposital');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"meta":{"completion_status":"FAILED"}}');
      return;
    }

    const valores = (campo) => {
      const re = new RegExp(`${campo}\\s*=\\s*'([^']*)'`, 'g');
      const out = [];
      let m;
      while ((m = re.exec(filter))) out.push(m[1]);
      return out;
    };
    // "GlobalId_c" nao casa com o padrao de "Id" porque depois de Id vem "_c".
    const porId = valores('Id');
    const porPai = valores('GlobalId_c');

    let hits = [];
    if (porPai.length) hits = REQUESTS.filter(r => r.pai && porPai.includes(r.pai));
    else if (porId.length) hits = REQUESTS.filter(r => porId.includes(r.Id));

    const pagina = hits.slice(skip, skip + size);
    console.log(`[mock] GET ems/Request ids=${porId.length} pais=${porPai.length} skip=${skip} size=${size} → ${pagina.length}/${hits.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK', total_count: hits.length },
      entities: pagina.map(entidadeDe)
    }));
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
