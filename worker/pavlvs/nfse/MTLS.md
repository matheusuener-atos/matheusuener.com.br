# mTLS da NFS-e no Worker (os passos à mão; o painel automatiza desde a fase 4, seção 6)

O Sistema Nacional (Sefin/ADN) exige o A1 do emitente no TLS. No Worker, o
`fetch` global não apresenta certificado de cliente; quem apresenta é o
`fetch()` de um **binding `mtls_certificate`**. Conferido em 03/10/2026 em:

- https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/
- https://developers.cloudflare.com/api/resources/mtls_certificates/methods/create/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
- https://developers.cloudflare.com/workers/platform/limits/

Pontos da documentação que mudam o desenho:

- "mTLS for Workers cannot be used for requests made to a service that is a
  proxied zone on Cloudflare" (dá 520). A Sefin não está atrás da Cloudflare:
  `sefin.producaorestrita.nfse.gov.br` responde `Server: Microsoft-IIS/10.0`,
  sem `cf-ray` (conferido em 03/10/2026).
- O binding é fixo no deploy: **um certificado por binding**. Vários
  escritórios = vários bindings (ou um Worker auxiliar por certificado),
  e cada certificado novo pede um novo upload do script.
- A chave do mTLS fica no cofre de certificados da Cloudflare e não volta para
  o código. A **assinatura da DPS** precisa da chave também: ela vai à parte
  (PKCS#8, cifrada, num segredo/KV), que é o que `pfx.js`/`assinatura.js` usam.

## 1. Tirar PEM do .pfx (fora do Worker)

```sh
openssl pkcs12 -in a1.pfx -clcerts -nokeys -out cert.pem          # certificado do titular
openssl pkcs12 -in a1.pfx -cacerts -nokeys -out cadeia.pem        # AC intermediária (opcional)
openssl pkcs12 -in a1.pfx -nocerts -nodes -out chave.pem          # chave em claro: apagar logo depois
cat cert.pem cadeia.pem > cert-e-cadeia.pem
```

(Ou o próprio `lerPfx` do PAULUS da casa, que já devolve `certPem`, `cadeiaPem`
e `chavePkcs8`.)

## 2. Subir o certificado (mTLS certificate)

Wrangler (pede o escopo "SSL and Certificates Edit"):

```sh
npx wrangler mtls-certificate upload --cert cert-e-cadeia.pem --key chave.pem --name nfse-11222333000181
npx wrangler mtls-certificate list     # mostra o certificate_id
```

API equivalente — `POST /accounts/{account_id}/mtls_certificates`
(permissão "Account: SSL and Certificates Write"):

```sh
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/mtls_certificates \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile c cert-e-cadeia.pem --rawfile k chave.pem \
        '{ca:false, certificates:$c, private_key:$k, name:"nfse-11222333000181"}')"
# resposta: result.id = o certificate_id
```

`ca:false` = certificado folha (de cliente), com a chave. (`ca:true`, sem
chave, é para subir uma AC.)

## 3. Publicar o Worker auxiliar `paulus-nfse-mtls` com o binding

`PUT /accounts/{account_id}/workers/scripts/{script_name}` (multipart;
permissão "Workers Scripts Write"):

```sh
cat > metadata.json <<'JSON'
{
  "main_module": "index.js",
  "compatibility_date": "2026-09-25",
  "bindings": [
    { "type": "mtls_certificate", "name": "SEFIN", "certificate_id": "<CERTIFICATE_ID>" }
  ]
}
JSON
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/paulus-nfse-mtls" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata=@metadata.json;type=application/json" \
  -F "index.js=@index.js;type=application/javascript+module"
```

`index.js` do auxiliar (pequeno: só repassa à Sefin, sem rota pública —
`workers_dev` desligado e nenhuma rota; quem chama é o Worker principal por
service binding):

```js
const HOSTS = ["sefin.producaorestrita.nfse.gov.br", "adn.producaorestrita.nfse.gov.br",
               "sefin.nfse.gov.br", "adn.nfse.gov.br"];
export default {
  async fetch(req, env) {
    const alvo = new URL(req.headers.get("x-nfse-url") || "");
    if (alvo.protocol !== "https:" || !HOSTS.includes(alvo.hostname)) return new Response("destino recusado", { status: 400 });
    return env.SEFIN.fetch(alvo, { method: req.method, headers: { "content-type": "application/json", accept: "application/json" },
                                   body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body });
  },
};
```

No Worker principal (wrangler.jsonc), o service binding:

```jsonc
"services": [ { "binding": "SEFIN_MTLS", "service": "paulus-nfse-mtls" } ]
```

e a chamada: `env.SEFIN_MTLS.fetch("https://interno/", { method: "POST", headers: { "x-nfse-url": url }, body })`.

Pela API, desligar o `*.workers.dev` do auxiliar:
`POST /accounts/{account_id}/workers/scripts/paulus-nfse-mtls/subdomain` com `{"enabled": false}`
(este endpoint NÃO foi conferido na documentação nesta prova).

## 4. API token mínimo

Token de conta (Account API Token ou User API Token restrito à conta), só:

| Permissão | Para quê |
|---|---|
| Account › SSL and Certificates › Edit | `POST /mtls_certificates` (e `DELETE` para trocar o A1 vencido) |
| Account › Workers Scripts › Edit | `PUT /workers/scripts/paulus-nfse-mtls` e o `subdomain` |

Nenhuma permissão de zona é necessária (o auxiliar não tem rota).

## 5. Como o emissor usa (fase 2)

`worker/nfse/sefin.js`, `fetchPeloMtls(env)`: todo pedido à Sefin/ADN sai por
`env.SEFIN_MTLS.fetch("https://interno/", {method, headers: {..., "x-nfse-url": url}, body})`.
Qualquer erro do `fetch` (tempo esgotado, conexão caída) é tratado como
"sem resposta": o emissor CONSULTA a DPS antes de qualquer reenvio. O
auxiliar pode responder `x-nfse-nao-chegou: 1` quando recusa o destino sem
abrir conexão (aí o pedido certamente não chegou e a nota vai para a fila).
O binding `SEFIN_MTLS` está no wrangler.jsonc desde a fase 4 (03/10/2026):
o auxiliar precisa existir ANTES do deploy (veja a nota no topo do
wrangler.jsonc).

## 6. Pelo painel (fase 4)

Os passos 2 e 3 não são mais à mão: em `/admin` › Notas fiscais, o .pfx é
aberto no navegador e o Worker (`worker/nfse/mtls.js`, `instalarMtls`) faz o
POST do certificado, o PUT do auxiliar (o script é `worker/nfse-mtls/index.js`)
e o DELETE do mTLS anterior, com o token de API colado em Parâmetros (cifrado
no KV). O dono só cria o auxiliar uma vez, antes do primeiro deploy:

```sh
cd worker/nfse-mtls
npx wrangler deploy index.js --name paulus-nfse-mtls --compatibility-date 2026-09-25 --no-bundle
# e desliga o *.workers.dev (Workers & Pages › paulus-nfse-mtls › Settings › Domains & Routes)
```

(Sem o binding `SEFIN` o auxiliar responde 503 com `x-nfse-nao-chegou: 1`, e a
nota vai para a fila; o primeiro certificado instalado pelo painel liga o binding.)
