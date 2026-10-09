// As paginas da Atos seguem o tema do sistema: a home nova nao tem mais o botao
// de tema, entao a escolha guardada pelo botao antigo e esquecida, para ninguem
// ficar preso nela. Arquivo, e nao script na pagina, porque a CSP so deixa
// rodar os do proprio site.
document.documentElement.classList.add("js");
try { localStorage.removeItem("atos-tema"); } catch (e) {}
