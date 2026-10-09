// Gera a chave que assina os id_token do "Entrar com Atos" (ES256, P-256).
//   node tools/gerar-chave.mjs > chave.json
//   npx wrangler secret put ATOS_CHAVE < chave.json   (e apague o chave.json)
// A parte publica sai no stderr: e ela que vai na var ATOS_JWKS do Worker do
// PAVLVS (paulus.ia.br), que confere os tokens sem perguntar a atos.dev.br.
// Trocar a chave: a publica antiga vai para ATOS_CHAVES_ANTIGAS por 1 hora (a
// vida de um id_token) e continua na ATOS_JWKS do PAVLVS ate la.
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const priv = await crypto.subtle.exportKey("jwk", par.privateKey);
const kid = "atos-" + new Date().toISOString().slice(0, 10);
process.stdout.write(JSON.stringify({ kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d, kid }));
process.stderr.write("\nPublica (ATOS_JWKS do PAVLVS):\n" + JSON.stringify([{ kty: "EC", crv: "P-256", x: priv.x, y: priv.y, kid, alg: "ES256", use: "sig" }]) + "\n");
