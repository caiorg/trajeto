import { describe, expect, test } from 'bun:test';
import { itemMarker, parsePendencias } from './pendencias';

const body = `Resumo do PR.

## Pendências
<!-- viram issues no merge; apague o que não quiser -->
- [ ] Limitar taxa em \`POST /auth/device\` | AFK, enhancement | Medium
  ### Contexto
  Qualquer cliente cria aparelhos sem limite.

  ### Critério de aceite
  - acima do limite responde 429
- [x] Já registrada | AFK | Low
  ignorada
- [ ] #3
  Validar o fluxo no aparelho.
- [ ] Sem labels nem prioridade
  corpo

## Testes
- [ ] Não é pendência | AFK | High
`;

describe('parsePendencias', () => {
  test('lê issues, comentários e ignora itens marcados e outras seções', () => {
    expect(parsePendencias(body)).toEqual([
      {
        kind: 'issue',
        title: 'Limitar taxa em `POST /auth/device`',
        labels: ['AFK', 'enhancement'],
        priority: 'Medium',
        body: '### Contexto\nQualquer cliente cria aparelhos sem limite.\n\n### Critério de aceite\n- acima do limite responde 429',
      },
      { kind: 'comment', issue: 3, body: 'Validar o fluxo no aparelho.' },
      { kind: 'issue', title: 'Sem labels nem prioridade', labels: [], priority: null, body: 'corpo' },
    ]);
  });

  test('PR sem a seção não gera nada', () => {
    expect(parsePendencias('## Resumo\n- [ ] tarefa | AFK | High')).toEqual([]);
  });

  test('seção com texto livre e sem itens não gera nada', () => {
    expect(parsePendencias('## Pendências\nNenhuma.')).toEqual([]);
  });

  test('aceita CRLF, "Pendencias" sem acento e prioridade em minúsculas', () => {
    expect(parsePendencias('## Pendencias\r\n- [ ] Item | HITL | high\r\n  corpo\r\n')).toEqual([
      { kind: 'issue', title: 'Item', labels: ['HITL'], priority: 'High', body: 'corpo' },
    ]);
  });

  test('comentário sem corpo é descartado', () => {
    expect(parsePendencias('## Pendências\n- [ ] #3\n')).toEqual([]);
  });

  test('título de seção com 1 espaço de recuo encerra a seção', () => {
    expect(parsePendencias(' ## Pendências\n- [ ] A | AFK\n  corpo\n ## Testes\n- [ ] B | AFK\n  corpo')).toEqual([
      { kind: 'issue', title: 'A', labels: ['AFK'], priority: null, body: 'corpo' },
    ]);
  });

  test('linha sem indentação encerra o item', () => {
    expect(parsePendencias('## Pendências\n- [ ] Item | AFK\n  corpo\nTexto solto.\n  não entra')).toEqual([
      { kind: 'issue', title: 'Item', labels: ['AFK'], priority: null, body: 'corpo' },
    ]);
  });

  test('ignora a seção mostrada como exemplo em bloco de código', () => {
    const pr = '## Resumo\n```\n## Pendências\n- [ ] Exemplo | AFK | Low\n  corpo\n```\n\n## Pendências\n- [ ] Real | AFK | Low\n  ~~~sh\n  ## não encerra\n  - [ ] não é item\n  ~~~\n';
    expect(parsePendencias(pr)).toEqual([
      { kind: 'issue', title: 'Real', labels: ['AFK'], priority: 'Low', body: '~~~sh\n## não encerra\n- [ ] não é item\n~~~' },
    ]);
  });
});

describe('itemMarker', () => {
  test('identifica o item pelo PR e pelo título pedido, sem diferenciar maiúsculas', () => {
    expect(itemMarker(7, 'Item A')).toBe(itemMarker(7, ' item a '));
    expect(itemMarker(7, 'Item A')).not.toBe(itemMarker(7, 'Item B'));
    expect(itemMarker(77, 'Item A')).not.toContain(itemMarker(7, 'Item A').slice(0, -4));
  });
});
