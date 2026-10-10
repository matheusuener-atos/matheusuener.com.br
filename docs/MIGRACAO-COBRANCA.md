# A cobrança do PAVLVS vai para a Atos

Decisão do dono (09/10/2026): os pagamentos e as faturas do PAVLVS passam a ser da Atos. Isso inclui as telas e o motor.

Ficam em atos.dev.br:
- assinar e pagar (cartão e Pix);
- trocar plano e cartão, recarga e cancelar;
- as ofertas, o arrependimento, o Pix do mês e o aviso do Mercado Pago;
- as notas fiscais.

O "Assinar" do PAVLVS leva a `atos.dev.br/pavlvs/assinar`. A página de planos continua em paulus.ia.br, porque é o site do produto.

## O que amarra (o mapa de 09/10/2026)

- **Assinatura e medidor são o mesmo registro.** Cada conta é um Durable Object `ContaIA` do Worker "paulus", com uma chave só (`"conta"`). Ela guarda junto a assinatura, os ciclos, os créditos, as faturas (`pagamentos[]`) e o uso da IA. O proxy da IA consulta esse registro a cada pedido (`resumo`, `reservar`, `liquidar`). Separar os dois quebraria a cota. Por isso o registro continua um só, e a Atos o usa por binding (`script_name: "paulus"`) até a etapa 6.
- **O KV já é o mesmo.** O APOIOS do PAVLVS é o `CONTAS` da Atos. As chaves da cobrança (`conta:*`, `admin:*`, `nfse:*`) não colidem com as da Atos (`atos:*`, `id:*`).
- **O PAULUS instalado** chama em paulus.ia.br estas rotas:
  - `/api/ia/assinar`, `/plano`, `/assinatura`, `/assinatura/cancelar`, `/recarga`, `/desistir`, `/nfse`;
  - `/api/ia/site/situacao`;
  - `/api/ia/minha-conta/link`. O programa exige que o link comece com `https://paulus.ia.br/minha-conta/`.

  Essas rotas continuam respondendo em paulus.ia.br, repassadas à Atos, até uma versão nova do programa falar direto com a Atos.
- **O aviso do Mercado Pago** está cadastrado no painel do app MP como `https://paulus.ia.br/api/mp/aviso`. Até o dono trocar para `https://atos.dev.br/api/mp/aviso`, o PAVLVS repassa o aviso inteiro, com os cabeçalhos da assinatura.
- **A NFS-e** é emitida pelo Durable Object `EmissorNFSe` (Worker "paulus"). O certificado chega à Sefin pelo Worker auxiliar `paulus-nfse-mtls`. A emissão depois de um pagamento sai de `anotarPagamento` → `emitirAutomatico`.

## As etapas

1. **A Atos liga no motor.**
   - Bindings no Worker atos: DO `CONTAS_IA` e `EMISSOR_NFSE` (`script_name: "paulus"`) e o serviço `SEFIN_MTLS`.
   - Segredos (o dono grava): `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `NFSE_CHAVE_MESTRA`.
   - Vars: `MP_PUBLIC_KEY`, `IA_CORTESIA` e `CF_ACCOUNT_ID`.
2. **O código da cobrança passa para a Atos** (`worker/pavlvs/`):
   - planos, assinar, pagar, Pix, recarga, cartão, trocar plano, cancelar, ofertas, arrependimento e devolução;
   - o aviso do MP (`/api/mp/aviso`) e o cron do Pix do mês;
   - a API da Minha conta, com a sessão da Atos no lugar do `pv_conta`, e a API do assinar;
   - as faturas, notas e arquivos.

   Os testes vão junto.
3. **O PAVLVS repassa à Atos** (service binding `ATOS`): `/api/ia/{assinar,plano,assinatura*,recarga*,desistir,site/*,nfse*}`, `/api/conta/*` e `/api/mp/aviso`. O código antigo da cobrança sai do Worker do PAVLVS. O cron do Pix do mês passa a rodar só na Atos.
4. **As telas.**
   - `atos.dev.br/conta` passa a ter a Minha conta inteira.
   - `atos.dev.br/pavlvs/assinar` reúne a conta, os dados e o pagamento.
   - paulus.ia.br `/cadastro`, `/cadastro/pagamento` e `/minha-conta` levam a elas.
   - Os `back_urls` do MP passam a apontar para atos.dev.br.
   - Os e-mails da cobrança saem de pagamentos@atos.dev.br.
5. **O dono troca a URL do aviso no painel do Mercado Pago.** Daí em diante o repasse do PAVLVS fica só de reserva.
6. **Depois:**
   - transferir as classes `ContaIA` e `EmissorNFSe` para o Worker atos (migração `transferred_classes`), e o PAVLVS passa a ligar nelas;
   - levar o painel de cobrança (contas, reembolso, renovações, campanhas, NFS-e) para a Atos;
   - publicar uma versão do programa que fale direto com a Atos;
   - tirar os repasses.

Nenhuma etapa para a cobrança. Cada uma vai ao ar com os testes da anterior passando, e o PAVLVS continua respondendo às rotas antigas.

## Em aberto

- O nome na fatura do cartão (`statement_descriptor`, hoje "PAULUS") e o nome do app no Mercado Pago. Eles mudam no painel do MP e no código, quando o dono decidir.
- O emissor da NFS-e (prestador) continua o mesmo cadastro.
