import { isIPv6 } from 'node:net';

/**
 * Chave do limite por IP. IPv4 entra inteiro. IPv6 entra pelo /64, porque um cliente costuma receber o /64 inteiro e
 * trocar de endereço dentro dele sem custo.
 */
export function ipKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.split('%')[0]!.split('::');
  // Grupos de 16 bits; o IPv4 embutido no fim (`::ffff:1.2.3.4`) vira dois.
  const groups = (s: string) =>
    (s ? s.split(':') : []).flatMap((g) => {
      if (!g.includes('.')) return [parseInt(g, 16)];
      const [a, b, c, d] = g.split('.').map(Number);
      return [(a! << 8) | b!, (c! << 8) | d!];
    });
  const h = groups(head);
  const t = groups(tail);
  const full = [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
  // IPv4 mapeado (`::ffff:0:0/96`) em qualquer grafia conta como o IPv4.
  if (full.slice(0, 5).every((g) => g === 0) && full[5] === 0xffff) {
    return [full[6]! >> 8, full[6]! & 255, full[7]! >> 8, full[7]! & 255].join('.');
  }
  return `${full
    .slice(0, 4)
    .map((g) => g.toString(16))
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
