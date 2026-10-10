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

- **Etapa 1 feita**: app "Atos Cobranca" criado no Mercado Pago (ID 6924335552095997, Checkout Transparente pela Orders API, MLB). Faltam, do dono: `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` (segredos), `MP_PUBLIC_KEY` (var) e o webhook cadastrado no app.
- **Etapas 2 e 3 em parte, no ar e fechadas** (`PRODUTOS_ABERTOS` vazio: nada cobra). Já existem:
  - **o núcleo** (`worker/cobranca/`): `catalogo.js` (preços do PAVLVS em centavos, `resolveOffer`), `cliente.js` (Durable Object `ClienteCobranca`: dados fiscais, assinaturas, compras, direitos, avisos vistos), `mp.js` (a API REST, `X-Idempotency-Key` na Orders API) e `api.js`;
  - **o checkout** `/pavlvs/assinar/`: mensal no cartão como assinatura (`/preapproval`, sem plano, `authorized`); o ano no cartão ou no Pix, o mês no Pix e a recarga no Pix pela Orders API;
  - **o aviso** `/api/mp/aviso`, com HMAC, que busca no Mercado Pago e aplica uma vez só;
  - **a assinatura**: `GET /api/subscriptions/:id` e pausar, reativar e cancelar;
  - **o direito** por produto (até quando está pago, e os créditos da recarga);
  - **os testes**: 37, em `worker/cobranca/teste.mjs`;
  - **os validadores do Mercado Pago**: passam o da tela e o das assinaturas.
- **Falta, nesta ordem:**
  1. eventos assinados para o produto, com reentrega, e `GET /api/cobranca/v1/direitos` para o produto;
  2. o PAVLVS consumir os eventos (`/api/atos/eventos` → ContaIA);
  3. abrir o PAVLVS (`PRODUTOS_ABERTOS=pavlvs`) e juntar o branch `pavlvs-checkout-atos` do coryphaeus (o "Assinar" dos planos levando a esta tela);
  4. as seções da `/conta` lendo daqui;
  5. a devolução no painel;
  6. a NFS-e.

Cada etapa vai ao ar com os testes passando e sem quebrar a anterior. Não há assinante real hoje (uma conta só, a do dono), então não há assinatura antiga do Mercado Pago para carregar.
