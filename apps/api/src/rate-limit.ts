import { isIPv6 } from 'node:net';

/**
 * Chave do limite por IP. IPv4 entra inteiro. IPv6 entra pelo /64, porque um cliente costuma receber o /64 inteiro e
 * trocar de endereço dentro dele sem custo.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.split('%')[0]!.split('::');
  const groups = (s: string) => (s ? s.split(':') : []);
  // IPv4 embutido no fim ocupa dois grupos.
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const t = groups(tail);
  const full = [...h, ...Array<string>(8 - width(h) - width(t)).fill('0'), ...t];
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Janela fixa em memória: até `max` chamadas por chave a cada `windowMs`. Devolve `null` se a chamada passa, ou os
 * segundos até a janela virar. As janelas vencidas são apagadas uma vez por janela, então a memória acompanha o número
 * de chaves vistas numa janela.
 */
export function fixedWindowLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let sweepAt = 0;
  return (key: string): number | null => {
    const now = Date.now();
    if (now >= sweepAt) {
      for (const [k, h] of hits) if (h.resetAt <= now) hits.delete(k);
      sweepAt = now + windowMs;
    }
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(key, h);
    }
    h.count++;
    return h.count <= max ? null : Math.ceil((h.resetAt - now) / 1000);
  };
}
