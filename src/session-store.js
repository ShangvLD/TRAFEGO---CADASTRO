/* ============================================================================
   Session store sobre o SQLite embutido (node:sqlite)

   Substitui pacotes que exigem compilação nativa. Implementa o mínimo da
   interface de Store do express-session (get / set / destroy / touch),
   guardando as sessões na tabela "sessoes" e limpando as expiradas.
   ========================================================================== */

const db = require('./db');

module.exports = function (session) {
  const Store = session.Store;

  class SqliteStore extends Store {
    constructor(opts = {}) {
      super(opts);
      // Prepara as consultas uma vez só.
      this._get = db.prepare('SELECT dados, expira_em FROM sessoes WHERE sid = ?');
      this._set = db.prepare(
        `INSERT INTO sessoes (sid, dados, expira_em) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET dados = excluded.dados, expira_em = excluded.expira_em`
      );
      this._del = db.prepare('DELETE FROM sessoes WHERE sid = ?');
      this._touch = db.prepare('UPDATE sessoes SET expira_em = ? WHERE sid = ?');
      this._limpar = db.prepare('DELETE FROM sessoes WHERE expira_em < ?');

      // Limpa sessões expiradas periodicamente (a cada 15 min).
      const intervalo = setInterval(() => this._limparExpiradas(), 15 * 60 * 1000);
      if (intervalo.unref) intervalo.unref(); // não segura o processo aberto
    }

    _limparExpiradas() {
      try {
        this._limpar.run(Date.now());
      } catch (_) {
        /* silencioso: limpeza é best-effort */
      }
    }

    // Quando expira a sessão (usa o maxAge do cookie, ou 1 dia por padrão).
    _validadeEm(sess) {
      const maxAge = sess?.cookie?.maxAge;
      const ms = typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000;
      return Date.now() + ms;
    }

    get(sid, cb) {
      try {
        const linha = this._get.get(sid);
        if (!linha) return cb(null, null);
        if (linha.expira_em < Date.now()) {
          this._del.run(sid);
          return cb(null, null);
        }
        return cb(null, JSON.parse(linha.dados));
      } catch (err) {
        return cb(err);
      }
    }

    set(sid, sess, cb) {
      try {
        this._set.run(sid, JSON.stringify(sess), this._validadeEm(sess));
        return cb && cb(null);
      } catch (err) {
        return cb && cb(err);
      }
    }

    destroy(sid, cb) {
      try {
        this._del.run(sid);
        return cb && cb(null);
      } catch (err) {
        return cb && cb(err);
      }
    }

    touch(sid, sess, cb) {
      try {
        this._touch.run(this._validadeEm(sess), sid);
        return cb && cb(null);
      } catch (err) {
        return cb && cb(err);
      }
    }
  }

  return SqliteStore;
};
