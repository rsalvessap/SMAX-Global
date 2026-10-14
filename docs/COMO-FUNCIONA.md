# SMAX Painel de Globais — como funciona por dentro

Notas de manutenção do script. Para instalar e usar o painel, veja o [README](../README.md).

```
SMAX/SMAX Global - TJSP.user.js   # o script
test/harness.html                 # harness local de desenvolvimento
test/server.js                    # servidor local que finge ser a API do SMAX
```

## Abertura por molde

O SMAX exige um punhado de campos para criar um `Request` (serviço, oferta, solicitante, grupo
designado, campos customizados `_c`…) e esses campos variam por instalação. Em vez de adivinhar
quais são, o script **aprende observando**: intercepta os corpos das requisições que a própria UI
do SMAX enviaria e guarda como molde. Na abertura, clona o molde, sobrescreve título, descrição e
urgência, descarta os campos de identidade do chamado antigo e reenvia no mesmo endpoint.

No replay do passo 2 o script só troca o `Id` pelo do chamado recém-criado — o campo que marca
"É Global" viaja junto no molde, então não é preciso saber o nome dele.

O escopo aqui é **uma equipe só**, então um molde basta.

### Modo seco

O interceptador decide **antes** de a requisição sair: se o corpo serve como molde, ele é guardado
e a requisição é **cancelada** — nada chega ao servidor.

O cancelamento é local: o XHR recebe um evento `error` (status 0) e o `fetch` rejeita com
`TypeError`, exatamente como numa queda de rede. Não dá para forjar `readyState`, então se alguma
tela ficar girando em vez de acusar erro, é só recarregar — a captura fica guardada.

Se em alguma tela o modo seco não funcionar, dá para desligá-lo e aprender abrindo um chamado de
verdade (o comportamento das versões anteriores). O painel pede confirmação antes.

O modo aprender e as capturas ficam em `GM_setValue`, não em memória: o SMAX recarrega a página ao
navegar até a tela de abertura, e um estado só em memória se perderia no meio do fluxo.

### O que o molde carrega

| Campo | Origem |
|---|---|
| `DisplayLabel` | você digita |
| `Description` | você digita (editor rich-text) |
| `Urgency` + `ImpactScope` | preset Baixa / Média / Alta / Crítica |
| `RequestedForPerson` | vem do molde; dá para trocar no painel |
| `Id`, `CreateTime`, `LastUpdateTime`, `UpdateTime`, `Comments` | **descartados** |
| todo o resto | replicado do molde |

O corpo inteiro da requisição é clonado — não só `properties` — para que qualquer campo irmão que
o SMAX espere viaje junto no replay.

### Solicitado para

A escolha **não persiste** — ao reabrir o painel o campo volta ao padrão do molde. Trocar é
exceção; se ficasse gravado, uma troca pontual viraria o padrão silencioso da próxima abertura.

A entidade `Person` do SMAX rejeita `LIKE`/`%`, então a busca é por range de prefixo
(`Name >= 'TERMO' and Name < 'TERMP'`). O molde guarda só o `Id` do solicitante, então o nome
exibido vem de um cache `Id → Nome` em `GM_setValue` — sem ele o painel mostraria um número a cada
recarga de página.

## Monitoramento dos globais

Duas perguntas, e só duas: mudou algo num global que eu acompanho, e apareceram filhos novos.
Vigiar os chamados novos do SMAX seria outro produto.

### A rodada é em duas etapas

Primeiro uma **sondagem barata** — `size=1&meta=totalCount`, uma requisição por global, payload
quase zero. Só nos globais que mexeram vem a **leitura completa**. O motivo é medido: um global
com 2.614 filhos custa 11 requisições de 250 registros para enumerar os filhos. Num ciclo
automático isso é carga demais, e a pergunta da sondagem ("o número mudou?") não precisa deles.

A contagem da sondagem mora num campo próprio (`filhosSonda`) e é comparada sempre contra ela
mesma — marca d'água, não informação. Ela conta o próprio global quando ele tem `GlobalId_c`
apontando para si mesmo, e a enumeração desconta essa autorreferência; as duas podem diferir em 1.
Quem a tela mostra é a enumeração. Comparar métricas diferentes faria o primeiro ciclo anunciar
"+1 filho" em todo global autorreferente.

### O que o aviso diz

| Tipo | Texto |
|---|---|
| **Filhos** | `3 filho(s) novo(s) — de 12 para 15` — queda também é notícia |
| **Status** | `Em andamento / Aguardando → Concluído / —`, com `(encerrado — dá para arquivar)` |
| **Fase** | `Log_InProgress → Log_Complete` |
| **Grupo** | GSE anterior → GSE atual |
| **Título** | título anterior → título atual |
| **Atualizado** | `alguma alteração no chamado — a leitura enxuta não diz qual` |

A **fase** vai com o valor cru do SMAX: não há mapa de rótulo de `PhaseId` aqui, e um nome
amigável inventado seria pior que um valor técnico verdadeiro. Ela só sai **quando o item de
Status não saiu** — no SMAX a fase acompanha o status na maioria das gravações, e as duas linhas
descreveriam a mesma mudança. **Título** não tem essa condição: editar o texto não mexe em mais
nada, então nunca é a mesma notícia que outro item.

O item genérico **Atualizado** sai só quando nenhum dos específicos saiu, e de propósito não diz o
quê: `LastUpdateTime` cresce em toda gravação, e a leitura em lote não traz comentário nem
descrição. Comentário novo, troca de pessoa designada e edição de descrição ainda caem aqui.

Para fechar essa lacuna existe o endpoint de auditoria
`audit/ems-history-service/Request?changeType=ALL&entityId={id}`, que devolve
`results[].changeProperties[campo].oldValue/.newValue` — o nome do campo e o de/para. Ele está em
uso em produção por outros scripts da família, mas **ainda não é usado aqui**: falta confirmar
quais campos aparecem no `changeProperties` (os consumidores conhecidos leem só `AssignedToGroup`
e `ExpertGroup`) e se cada entrada tem carimbo de hora — sem ele o aviso repetiria a história
inteira do chamado em vez do que mudou desde a última leitura.

### Duas regras que não se negociam

**Comparação só acontece quando existe valor anterior.** Campo nunca lido vale `undefined` e
significa "não sei", nunca zero. Sem esse sentinela a primeira rodada anunciaria "+2.614 filhos"
em cada global da lista.

**Nunca inventar zero.** Bloco de consulta recusado pelo SMAX tira a chave em vez de gravar 0 — a
tela mostra *não lido*. Um global com o teto de 10.000 estourado tem muitos filhos, não nenhum.

## Desenvolvimento

Sem build, sem dependências — o `.user.js` é o artefato final.

```bash
node --check "SMAX/SMAX Global - TJSP.user.js"
```

`enableRealWrites` em `GM_setValue('smax_global_prefs')` desliga as escritas reais — útil para
exercitar a tela de abertura em produção sem criar chamado.

### Harness local

Testa o script fora do SMAX, incluindo o caminho real de captura. O harness remove o guard de
hostname só na hora de carregar; o arquivo publicado não é alterado.

```bash
node test/server.js        # http://localhost:8899/test/harness.html
```

O servidor também finge ser a API do SMAX: responde `POST /rest/{tenant}/...` com um ID novo a
cada `CREATE`. Isso permite exercitar o replay inteiro — criação **e** marcação "É Global" — sem
tocar em produção. O log do servidor mostra cada chamada, e é ali que se confirma que o `CREATE`
foi sem `Id` e que o `UPDATE` seguinte usou o ID recém-criado.

O mock também serve `GET ems/Person`, reproduzindo o range de prefixo, com quatro pessoas
`GLOBAL EPROC` e duas fora do grupo — as duas existem para provar que o filtro exclui mesmo.

Os botões do harness disparam XHR/fetch imitando o SMAX: criação, marcação "É Global" e ruído. O
botão de ruído confirma que GET e `UPDATE` de outras entidades **não** viram candidato a molde.

O harness persiste o GM storage em `localStorage` e recarrega a página sob demanda — de propósito:
com stub em memória, o bug de perder o modo aprender no reload ficava invisível.

### Convívio com os outros scripts SMAX

SMAX Respostas e SMAX Triagem rodam nas mesmas páginas e usam os mesmos nomes de token `--sp-*` e
o atributo `data-smax-theme` no `<html>`. Para não brigarem, aqui os tokens ficam escopados em
`.smax-gl-root` e o tema nunca toca `<html>`/`<body>`. O botão flutuante fica em `bottom:60px`
para não colidir com o de configurações dos outros scripts.

Não há uma única caixa de marcar no script: o CSS do SMAX zera a aparência de
`input[type=checkbox]` e escopar numa classe raiz não resolve controle de formulário. Onde
caberia uma caixa, existe um chip.

## Versionamento

`@version` no cabeçalho e `SMAX_GLOBAL_VERSION` no topo do IIFE precisam andar juntos. Push no
`master` publica para todos os usuários via `@downloadURL`/`@updateURL`.
