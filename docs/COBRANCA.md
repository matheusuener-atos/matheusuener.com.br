# Atos Cobrança

A Atos é a única que cobra. O Mercado Pago é só da Atos: uma conta, um app, um webhook. Os produtos (o PAVLVS e os que ainda vierem) não falam com o Mercado Pago, não guardam cartão e não emitem nota. Eles fazem três coisas:
1. mandam a pessoa ao checkout da Atos;
2. recebem da Atos os eventos do que mudou;
3. perguntam à Atos o que a pessoa tem direito de usar.

É o mesmo arranjo de uma empresa que usa o Stripe, com a Atos no lugar do Stripe e dos produtos ao mesmo tempo.

Decisão do dono, 09/10/2026: "criar tudo no Mercado Pago exclusivo Atos, e os sistemas, na hora de cobrar, fazem a orquestração. Isso vale pra todos que ainda serão criados."

## Decisões do dono (09/10/2026)

- **Mercado Pago**: um app novo, "Atos", na conta do Mercado Pago que o dono já tem. Credenciais e webhook só desse app. O app antigo ("PAULUS Apoio") sai de uso quando a Atos cobrar.
- **NFS-e**: o prestador é o cadastro de hoje (o certificado A1 que já está no emissor do PAVLVS). O emissor passa a ser da Atos, com o mesmo prestador.
- **A etapa provisória sai**: o motor copiado do PAVLVS (worker/pavlvs/) foi tirado da Atos. A cobrança da Atos é construída como está aqui, e não como cópia.

## O que é de quem

| | Atos | Produto (ex.: PAVLVS) |
|---|---|---|
| Quem é a pessoa | a Conta Atos (`sub`) | só recebe o `sub` e o e-mail pelo "Entrar com Atos" |
| Dados fiscais (CPF/CNPJ, endereço) | uma vez por pessoa, valem para todos os produtos | não guarda |
| Catálogo (planos, preços, recargas) | sim, por produto, com versões | define o que cada plano libera, como metadados do plano |
| Assinatura (plano, período, ciclo pago, próxima cobrança, cancelamento) | fonte de verdade | só reflete o que a Atos avisa |
| Cartão, Pix, cobrança, devolução | sim (Mercado Pago) | nunca |
| Faturas e NFS-e | sim, uma nota por pagamento, com a Atos de prestador | não |
| Uso e cota (tokens, créditos gastos) | não | sim (no PAVLVS, o ContaIA) |

## As peças

1. **Catálogo** (`/api/cobranca/v1/produtos/{produto}/precos`). Cada preço tem:
   - `id` estável (ex.: `pavlvs.escritorio.mensal`), nome, valor em centavos e período (`mes`, `ano` ou `avulso`);
   - `metadados`, que o produto lê (no PAVLVS: tokens do ciclo, pessoas, modelo);
   - a versão.

   Preço que muda vira versão nova: quem assinou antes continua no valor dele até a Atos aplicar a mudança, com aviso.
2. **Cliente**: a Conta Atos com os dados fiscais. São pedidos no primeiro pagamento e reaproveitados nos seguintes.
3. **Checkout hospedado**: `atos.dev.br/{produto}/assinar?preco=...&volta=...`.
   - A pessoa entra com a Conta Atos, confirma os dados e paga com cartão (assinatura recorrente) ou Pix (mês ou ano avulso).
   - No fim, volta ao produto.
   - O produto nunca vê o cartão.
4. **Assinaturas**: uma por cliente e produto. Os estados são `pendente`, `ativa`, `em_atraso`, `cancelada` (vale até o fim do ciclo pago) e `encerrada`. O ciclo pago (`inicio`, `fim`) é o que dá direito.
5. **Pagamentos e faturas**: cada cobrança do Mercado Pago (mensalidade, anual, Pix, recarga) vira uma fatura, com a NFS-e dela e a devolução quando houver. A pessoa vê tudo em `atos.dev.br/conta` (Assinaturas, Faturamento, Carteira), de todos os produtos.
6. **Mercado Pago**: só aqui.
   - O webhook é `https://atos.dev.br/api/mp/aviso`, com a assinatura conferida.
   - O aviso nunca é a verdade: a Atos busca o pagamento no Mercado Pago antes de mudar qualquer coisa.
   - Cada evento é processado uma vez (idempotência pelo id do Mercado Pago).
7. **Eventos para o produto** (a orquestração).
   - A Atos manda `POST` ao endpoint do produto com um evento assinado (HMAC-SHA256, com o segredo do produto e o carimbo de tempo).
   - Tipos: `assinatura.ativada`, `assinatura.renovada`, `assinatura.plano_trocado`, `assinatura.cancelada`, `assinatura.encerrada`, `assinatura.reembolsada`, `compra.paga` (recarga), `compra.reembolsada`.
   - Cada evento tem `id` único, e o produto ignora o que já viu.
   - Se o produto não responder 2xx, a Atos tenta de novo (1 min, 5 min, 30 min, 2 h, 12 h) e mostra no painel o que ficou parado.
   - Entre Workers da mesma conta Cloudflare, a entrega vai por service binding, com a mesma assinatura.
8. **Direitos** (`GET /api/cobranca/v1/direitos?produto=&sub=`, autenticado pelo produto).
   - Responde o que vale agora: o plano, o ciclo pago, os metadados e as compras avulsas.
   - É a resposta de reserva quando um evento se perde, e o que o produto consulta ao abrir.
9. **Painel da Atos**: clientes, assinaturas, faturas, devoluções, notas, eventos que falharam, catálogo e campanhas. É um painel só, para todos os produtos.

## O PAVLVS como cliente da Atos

- O "Assinar" do site e do programa leva a `atos.dev.br/pavlvs/assinar?preco=...`.
- A Minha conta do `paulus.ia.br` dá lugar a `atos.dev.br/conta`.
- O PAVLVS recebe os eventos em `POST /api/atos/eventos`:
  - renovou, abre o ciclo com os tokens do plano;
  - recarga paga, credita;
  - cancelou ou foi reembolsada, fecha.

  São as operações que o ContaIA já faz (`assinatura`, `renovar`, `creditar`, `desistiu`...), mas comandadas pelos eventos da Atos, e não mais pelo Mercado Pago.
- O que sai do Worker do PAVLVS:
  - o Mercado Pago, o webhook e o cron do Pix;
  - o cadastro fiscal, as notas e a Minha conta;
  - o painel de cobrança.
- O que fica: o medidor (cota, reservas e uso), o proxy da IA e o que cada plano libera.
- O programa instalado continua chamando `paulus.ia.br/api/ia/*`. Nas rotas de cobrança, o PAVLVS passa a responder com o que a Atos diz (direitos) e a mandar ao checkout da Atos, até uma versão nova falar direto.

## Ordem

1. **Desenho aprovado** (feito). **O app "Atos" no Mercado Pago** (o dono): credenciais de produção e de teste, e o webhook `https://atos.dev.br/api/mp/aviso` com os eventos de pagamentos, assinaturas (preapproval e authorized_payment) e orders.
2. **Núcleo na Atos**: catálogo, cliente, assinatura, faturas, Mercado Pago (cartão recorrente, Pix e devolução), webhook e eventos com reentrega. Testes de cada transição.
3. **Checkout e portal**: `/{produto}/assinar` e as seções Assinaturas, Faturamento e Carteira de `/conta` com dados reais.
4. **NFS-e na Atos**: o emissor e o certificado passam a ser da Atos, que é a prestadora.
5. **PAVLVS cliente**: `/api/atos/eventos`, direitos e o site levando à Atos. Sai a cobrança do Worker do PAVLVS.
6. **Painel da Atos**, e a versão do programa que fala direto.

### Onde está (09/10/2026)

- **Etapa 1 feita**: o app "Atos Cobranca" no Mercado Pago (ID 6924335552095997, Checkout Transparente pela Orders API, MLB), com as credenciais de produção no Worker (`MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` como segredos, `MP_PUBLIC_KEY` como var). Falta, do dono, cadastrar o webhook `https://atos.dev.br/api/mp/aviso` no app (tópicos Order, Planos e assinaturas, Pagamentos).
- **Etapas 2 e 3 feitas, fechadas** (`PRODUTOS_ABERTOS` vazio: nada cobra):
  - **o núcleo** (`worker/cobranca/`): `catalogo.js` (os preços do PAVLVS em centavos, `resolveOffer`), `cliente.js` (o Durable Object `ClienteCobranca`), `mp.js` (a API REST, `X-Idempotency-Key` na Orders API) e `api.js`;
  - **o checkout** `/pavlvs/assinar/`: o mês no cartão é assinatura (`/preapproval`, sem plano, `authorized`); o ano vai no cartão ou no Pix, e o mês e a recarga no Pix, pela Orders API;
  - **o aviso** `/api/mp/aviso`: confere o HMAC, busca no Mercado Pago e aplica uma vez só;
  - **a assinatura**: `GET /api/subscriptions/:id`, com pausar, reativar e cancelar;
  - **nunca cobrar em dobro**:
    - com assinatura viva, só a recarga (`ja_assina`);
    - com o período pago, a assinatura só começa depois do vencimento (`pago_ate`);
    - mais tempo só no mesmo plano (`troca_de_plano`);
  - **os eventos** (`eventos.js`), em fila por cliente, entregues pelo alarme do objeto, em ordem:
    - `direito.atualizado` leva o retrato versionado, com plano, metadados, até quando, o período que pagou e a assinatura;
    - `credito.adicionado` leva a recarga;
    - assinatura `Atos-Assinatura: t=,v1=` (HMAC com `EVENTOS_SEGREDO_<PRODUTO>`);
    - reentrega em 1 min, 5 min, 30 min, 2 h e 12 h; esgotadas, "falhou";
  - **a reserva** `GET /api/cobranca/v1/direitos`, com Bearer do mesmo segredo;
  - **o mês**: a mesma conta do PAVLVS (`maisUmMes`, 31/01 → 28/02, um mês de cada vez), para o "pago até" e o fim do ciclo do produto caírem no mesmo dia;
  - **os testes**: 53, em `worker/cobranca/teste.mjs`.
- **Etapa 4 feita no coryphaeus** (`worker/atos.js`, `node worker/teste-atos.mjs`, 45 ok):
  - **`POST /api/atos/eventos`**: confere a assinatura e aplica no ContaIA:
    - `atos_direito`, só versão maior;
    - `atos_credito`, uma vez por pagamento;
  - **a conta passa a ser cobrada pela Atos** (`cobrador: "atos"`): os ciclos rolam até o "pago até"; o tempo que o PAVLVS já tinha cobrado fica; a assinatura antiga do Mercado Pago do PAVLVS é cancelada;
  - **as rotas de dinheiro do PAVLVS** (site, PAULUS instalado, Minha conta, painel) recusam a conta da Atos com 409 `cobranca_na_atos`, que manda a `atos.dev.br/conta`;
  - **a conta fora de dia pergunta à Atos** (a reserva), no máximo a cada 10 minutos.
- **Falta, nesta ordem:**
  1. **do dono:** o mesmo segredo `EVENTOS_SEGREDO_PAVLVS` nos dois Workers (`npx wrangler secret put EVENTOS_SEGREDO_PAVLVS` em C:\atos e em C:\coryphaeus), o deploy dos dois e o webhook no app;
  2. **o teste de ponta a ponta** com as credenciais de teste do app (aba Teste) e um comprador de teste;
  3. **abrir o PAVLVS** (`PRODUTOS_ABERTOS=pavlvs`) e juntar o branch `pavlvs-checkout-atos` do coryphaeus (o "Assinar" dos planos levando a esta tela);
  4. **as seções da `/conta`** lendo daqui (o plano, as faturas, pausar e cancelar; hoje a Minha conta do PAVLVS só diz que é na Atos);
  5. **a devolução no painel**;
  6. **a NFS-e.**

Cada etapa vai ao ar com os testes passando e sem quebrar a anterior. Não há assinante real hoje (uma conta só, a do dono), então não há assinatura antiga do Mercado Pago para carregar.
