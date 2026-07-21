/* ============================================================================
   Session store sobre o libSQL/Turso (assíncrono)

   Implementa o mínimo da interface de Store do express-session
   (get / set / destroy / touch), guardando as sessões na tabela "sessoes".

   Como o cliente do banco agora é assíncrono, cada método faz a consulta e
   chama o callback do express-session ao terminar. Não há mais o setInterval
   de limpeza (não faz sentido em ambiente serverless, onde o processo é
   efêmero): as sessões expiradas são removidas quando lidas, e podem ser
   varridas por um script/cron se um dia for necessário.
   ========================================================================== */

const db = require('./db');

module.exports = function (session) {
  const Store = session.Store;

  class SqliteStore extends Store {
    // Quando expira a sessão (usa o maxAge do cookie, ou 1 dia por padrão).
    _validadeEm(sess) {
      const maxAge = sess?.cookie?.maxAge;
      const ms = typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000;
      return Date.now() + ms;
    }

    get(sid, cb) {
      (async () => {
        const linha = await db
          .prepare('SELECT dados, expira_em FROM sessoes WHERE sid = ?')
          .get(sid);
        if (!linha) return cb(null, null);
        if (linha.expira_em < Date.now()) {
          await db.prepare('DELETE FROM sessoes WHERE sid = ?').run(sid);
          return cb(null, null);
        }
        return cb(null, JSON.parse(linha.dados));
      })().catch((err) => cb(err));
    }

    set(sid, sess, cb) {
      (async () => {
        await db
          .prepare(
            `INSERT INTO sessoes (sid, dados, expira_em) VALUES (?, ?, ?)
             ON CONFLICT(sid) DO UPDATE SET dados = excluded.dados, expira_em = excluded.expira_em`
          )
          .run(sid, JSON.stringify(sess), this._validadeEm(sess));
        return cb && cb(null);
      })().catch((err) => cb && cb(err));
    }

    destroy(sid, cb) {
      (async () => {
        await db.prepare('DELETE FROM sessoes WHERE sid = ?').run(sid);
        return cb && cb(null);
      })().catch((err) => cb && cb(err));
    }

    touch(sid, sess, cb) {
      (async () => {
        await db
          .prepare('UPDATE sessoes SET expira_em = ? WHERE sid = ?')
          .run(this._validadeEm(sess), sid);
        return cb && cb(null);
      })().catch((err) => cb && cb(err));
    }
  }

  return SqliteStore;
};
