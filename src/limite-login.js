/* ============================================================================
   Limite de tentativas de login (força bruta)

   POR QUE NO BANCO, e não em memória: no Vercel cada requisição pode cair numa
   instância diferente da função, e a instância morre entre requisições. Um
   contador em variável seria zerado a cada tentativa — ou seja, não contaria
   nada. A tabela é o único lugar que as instâncias compartilham.

   DUAS CHAVES, com tetos diferentes:

     e-mail  5 falhas em 15 min  -> bloqueia aquele e-mail por 15 min.
     IP     20 falhas em 15 min  -> bloqueia a origem por 15 min.

   O teto do IP é mais alto de propósito: o time interno sai todo pelo mesmo IP
   da empresa, e cinco erros de senha de colegas diferentes não podem travar o
   escritório inteiro. Já o teto por e-mail é o que realmente segura a força
   bruta, porque o atacante precisa acertar a senha DE ALGUÉM.

   A JANELA DESLIZA: passados 15 minutos sem falha, a contagem recomeça do zero
   em vez de somar para sempre. Quem erra a senha três vezes hoje e duas amanhã
   não deve acabar bloqueado.

   O acerto da senha limpa as chaves — inclusive a do IP, para não penalizar o
   colega que entrou certo depois de outro errar.
   ========================================================================== */

const db = require('./db');

const JANELA_MINUTOS = 15;
const BLOQUEIO_MINUTOS = 15;

const REGRAS = {
  email: { prefixo: 'login:email:', max: 5 },
  ip: { prefixo: 'login:ip:', max: 20 },
};

/**
 * Mesma expressão de data do resto do banco, deslocada no tempo.
 *
 * db.AGORA_SQL é `to_char(now() AT TIME ZONE '<fuso>', 'YYYY-MM-DD HH24:MI:SS')`.
 * Trocar o `now()` por `now() + interval` preserva o fuso E o formato — e é o
 * formato que faz a comparação de texto ordenar certo.
 */
function agoraMais(minutos) {
  return db.AGORA_SQL.replace('now()', `(now() + interval '${Number(minutos)} minutes')`);
}

const AGORA = db.AGORA_SQL;
const INICIO_DA_JANELA = agoraMais(-JANELA_MINUTOS);
const FIM_DO_BLOQUEIO = agoraMais(BLOQUEIO_MINUTOS);

/** As chaves que uma tentativa de login movimenta, cada uma com seu teto. */
function chavesDoLogin(email, ip) {
  const chaves = [];
  const e = String(email || '').trim().toLowerCase();
  if (e) chaves.push({ chave: REGRAS.email.prefixo + e, max: REGRAS.email.max });
  if (ip) chaves.push({ chave: REGRAS.ip.prefixo + String(ip), max: REGRAS.ip.max });
  return chaves;
}

/**
 * Alguma das chaves está bloqueada agora?
 *
 * @returns {{ bloqueado: boolean, segundos: number }} segundos que faltam
 */
async function verificar(chaves) {
  if (!chaves.length) return { bloqueado: false, segundos: 0 };

  const marcadores = chaves.map(() => '?').join(', ');
  const linha = await db
    .prepare(
      `SELECT max(bloqueado_ate) AS ate
         FROM login_tentativas
        WHERE chave IN (${marcadores})
          AND bloqueado_ate IS NOT NULL
          AND bloqueado_ate > ${AGORA}`
    )
    .get(...chaves.map((c) => c.chave));

  if (!linha || !linha.ate) return { bloqueado: false, segundos: 0 };

  // O texto está no fuso do banco; a diferença é calculada lá para não
  // depender do relógio nem do fuso de quem roda o Node.
  const r = await db
    .prepare(
      `SELECT greatest(0, ceil(extract(epoch FROM (to_timestamp(?, 'YYYY-MM-DD HH24:MI:SS')
                                                  - to_timestamp(${AGORA}, 'YYYY-MM-DD HH24:MI:SS')))))::int AS s`
    )
    .get(linha.ate);

  return { bloqueado: true, segundos: (r && r.s) || BLOQUEIO_MINUTOS * 60 };
}

/**
 * Conta uma falha em cada chave e bloqueia quem passou do teto.
 *
 * Tudo num único INSERT ... ON CONFLICT porque duas tentativas simultâneas
 * (duas instâncias da função) senão sobrescreveriam a contagem uma da outra —
 * e o jeito de burlar o limite seria justamente disparar em paralelo.
 */
async function registrarFalha(chaves) {
  for (const { chave, max } of chaves) {
    const novaContagem = `CASE WHEN login_tentativas.janela_em < ${INICIO_DA_JANELA}
                               THEN 1 ELSE login_tentativas.tentativas + 1 END`;

    await db
      .prepare(
        `INSERT INTO login_tentativas (chave, tentativas, janela_em, bloqueado_ate)
              VALUES (?, 1, ${AGORA}, NULL)
         ON CONFLICT (chave) DO UPDATE SET
              tentativas    = ${novaContagem},
              janela_em     = CASE WHEN login_tentativas.janela_em < ${INICIO_DA_JANELA}
                                   THEN ${AGORA} ELSE login_tentativas.janela_em END,
              bloqueado_ate = CASE WHEN (${novaContagem}) >= ${Number(max)}
                                   THEN ${FIM_DO_BLOQUEIO} ELSE NULL END`
      )
      .run(chave);
  }
}

/** Login certo: zera as chaves e aproveita para varrer o que ficou velho. */
async function limpar(chaves) {
  if (chaves.length) {
    const marcadores = chaves.map(() => '?').join(', ');
    await db
      .prepare(`DELETE FROM login_tentativas WHERE chave IN (${marcadores})`)
      .run(...chaves.map((c) => c.chave));
  }

  // Linha de tentativa não é histórico: depois de um dia sem falha e sem
  // bloqueio em pé, não serve para nada.
  await db
    .prepare(
      `DELETE FROM login_tentativas
        WHERE janela_em < ${agoraMais(-60 * 24)}
          AND (bloqueado_ate IS NULL OR bloqueado_ate < ${AGORA})`
    )
    .run();
}

/**
 * Chave para qualquer outra coisa que precise de freio (não só login).
 *
 * Usada pela consulta por CPF/placa da renovação: é o mesmo mecanismo —
 * contar em janela e bloquear quem passa do teto — e duplicar o SQL de
 * contagem simultânea em outro módulo só criaria dois lugares para errar.
 */
function chaveDe(nome, valor, max) {
  return [{ chave: `${nome}:${valor}`, max }];
}

module.exports = {
  chavesDoLogin,
  chaveDe,
  verificar,
  registrarFalha,
  // Fora do login não existe "falha": conta-se o uso. Mesmo código, outro nome,
  // para a rota que chama ler direito.
  contar: registrarFalha,
  limpar,
  JANELA_MINUTOS,
  BLOQUEIO_MINUTOS,
};
