// Transforma a seção "## Pendências" de um PR mergeado em issues e comentários.
// Formato de cada item (linhas do corpo indentadas abaixo do item):
//   - [ ] Título | AFK, enhancement | Medium   -> cria issue
//   - [ ] #3                                   -> comenta na issue #3
// Itens marcados ([x]) são ignorados.

export type Priority = 'High' | 'Medium' | 'Low';

export type Pendencia =
  | { kind: 'issue'; title: string; labels: string[]; priority: Priority | null; body: string }
  | { kind: 'comment'; issue: number; body: string };

const PRIORITIES: Record<string, Priority> = { high: 'High', medium: 'Medium', low: 'Low' };
const LINEAR_PRIORITY: Record<Priority, number> = { High: 2, Medium: 3, Low: 4 };
const LINEAR_PRIORITY_NAME = ['sem prioridade', 'Urgent', 'High', 'Medium', 'Low'];

export function parsePendencias(prBody: string): Pendencia[] {
  const lines = prBody.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const start = lines.findIndex((l) => /^##\s+pend[êe]ncias\s*$/i.test(l.trim()));
  if (start < 0) return [];

  const items: { head: string; body: string[] }[] = [];
  let current: { head: string; body: string[] } | null = null;
  for (const line of lines.slice(start + 1)) {
    // Título de seção com até 1 espaço encerra; com 2 ou mais, a linha é corpo do item.
    if (/^ ?#{1,2}\s/.test(line)) break;
    const item = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (item) {
      current = item[1] === ' ' ? { head: item[2].trim(), body: [] } : null;
      if (current) items.push(current);
    } else if (/^\S/.test(line)) {
      current = null;
    } else if (current) {
      current.body.push(line);
    }
  }
  return items.map(toPendencia).filter((p): p is Pendencia => p !== null);
}

function toPendencia({ head, body }: { head: string; body: string[] }): Pendencia | null {
  const text = dedent(body).trim();
  const [title = '', labels = '', priority = ''] = head.split('|').map((s) => s.trim());
  const ref = /^#(\d+)$/.exec(title);
  if (ref) return text ? { kind: 'comment', issue: Number(ref[1]), body: text } : null;
  if (!title) return null;
  return {
    kind: 'issue',
    title,
    labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
    priority: PRIORITIES[priority.toLowerCase()] ?? null,
    body: text,
  };
}

function dedent(lines: string[]): string {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

export const marker = (pr: number) => `<!-- pendencia-do-pr: ${pr} -->`;

// Identidade de uma issue criada pelo workflow: PR de origem + título pedido no PR.
// Fica no corpo da issue, então sobrevive a uma mudança de título.
export const itemMarker = (pr: number, title: string) =>
  `<!-- pendencia-do-pr: ${pr} item: ${new Bun.CryptoHasher('sha256').update(title.trim().toLowerCase()).digest('hex').slice(0, 16)} -->`;

type Issue = {
  number: number;
  title: string;
  state: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  pull_request?: unknown;
};
type Comment = { body: string | null; user: { login: string } | null };

// Marcadores ficam em texto editável. Só valem em issues e comentários criados por este workflow,
// para que ninguém consiga plantar um marcador e desviar a deduplicação ou o update do Linear.
const BOT = 'github-actions[bot]';
const byBot = (x: { user: { login: string } | null }) => x.user?.login === BOT;

function github(token: string, repository: string, apiUrl: string) {
  const base = `${apiUrl}/repos/${repository}`;
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(base + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
  async function all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await call<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  }
  const post = <T>(path: string, data: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(data) });
  return {
    labels: async () => (await all<{ name: string }>('/labels')).map((l) => l.name),
    issues: async () => (await all<Issue>('/issues?state=all')).filter((i) => !i.pull_request),
    comments: (n: number) => all<Comment>(`/issues/${n}/comments`),
    createIssue: (data: { title: string; body: string; labels: string[] }) =>
      post<{ number: number; html_url: string }>('/issues', data),
    comment: (n: number, body: string) => post<unknown>(`/issues/${n}/comments`, { body }),
  };
}

// O sync do Linear cria o item em Backlog e sem prioridade; aqui ele vai para Todo com a prioridade do PR.
// Item que já saiu desse estado (execução anterior ou mudança manual) não é alterado.
// Devolve o identificador e a prioridade que o item tem no Linear depois da chamada.
async function updateLinear(apiKey: string, issueUrl: string, priority: Priority | null): Promise<string> {
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const res = await fetch(process.env.LINEAR_API_URL ?? 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || json.errors) throw new Error(json.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`);
    return json.data as T;
  };
  type Found = {
    attachmentsForURL: {
      nodes: {
        issue: {
          id: string;
          identifier: string;
          priority: number;
          state: { type: string };
          team: { states: { nodes: { id: string }[] } };
        } | null;
      }[];
    };
  };
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await gql<Found>(
      `query($url: String!) { attachmentsForURL(url: $url) { nodes { issue { id identifier priority state { type }
        team { states(filter: { name: { eq: "Todo" } }) { nodes { id } } } } } } }`,
      { url: issueUrl },
    );
    const issue = found.attachmentsForURL.nodes.find((n) => n.issue)?.issue;
    if (issue) {
      const current = `${issue.identifier}, ${LINEAR_PRIORITY_NAME[issue.priority] ?? issue.priority}`;
      if (issue.state.type !== 'backlog' || issue.priority !== 0) return current;
      // Sem Todo, não aplica nem a prioridade: o item continua intocado e a reexecução tenta de novo.
      const stateId = issue.team.states.nodes[0]?.id;
      if (!stateId) throw new Error('o time do item no Linear não tem o estado Todo');
      const input: Record<string, unknown> = { stateId };
      if (priority) input.priority = LINEAR_PRIORITY[priority];
      type Updated = { issueUpdate: { success: boolean; issue: { priority: number } | null } };
      const { issueUpdate } = await gql<Updated>(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { priority } } }`,
        { id: issue.id, input },
      );
      if (!issueUpdate.success || !issueUpdate.issue) throw new Error('o Linear recusou a atualização');
      // Mostra a prioridade que o Linear devolveu, não a pedida.
      return `${issue.identifier}, ${LINEAR_PRIORITY_NAME[issueUpdate.issue.priority] ?? issueUpdate.issue.priority}`;
    }
    await Bun.sleep(5000);
  }
  throw new Error('o item não apareceu no Linear em 60s');
}

async function main() {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`falta ${name}`);
    return value;
  };
  const event = JSON.parse(await Bun.file(env('GITHUB_EVENT_PATH')).text());
  const pr: { number: number; body: string | null } = event.pull_request;
  const items = parsePendencias(pr.body ?? '');
  if (!items.length) {
    console.log('PR sem pendências.');
    return;
  }

  const gh = github(env('GITHUB_TOKEN'), env('GITHUB_REPOSITORY'), process.env.GITHUB_API_URL ?? 'https://api.github.com');
  const linearKey = process.env.LINEAR_API_KEY;
  const tag = marker(pr.number);
  const known = new Set(await gh.labels());
  const issues = await gh.issues();
  const done: string[] = [];
  const warnings: string[] = [];

  for (const item of items) {
    if (item.kind === 'comment') {
      const body = `${item.body}\n\nRegistrado no merge do #${pr.number}.\n${tag}`;
      const existing = await gh.comments(item.issue);
      if (!existing.some((c) => byBot(c) && c.body === body)) await gh.comment(item.issue, body);
      done.push(`- comentário em #${item.issue}`);
      continue;
    }

    const title = item.title.toLowerCase();
    const sameTitle = issues.filter((i) => i.title.toLowerCase() === title);
    const labels = item.labels.filter((l) => known.has(l));
    const unknown = item.labels.filter((l) => !known.has(l));
    if (unknown.length) warnings.push(`- "${item.title}": labels inexistentes ignoradas: ${unknown.join(', ')}.`);

    // Numa reexecução, a issue já tem o marcador deste PR: não cria outra e só retoma o Linear.
    const itemTag = itemMarker(pr.number, item.title);
    let issue = issues.find((i) => byBot(i) && i.body?.includes(itemTag));
    if (!issue) {
      const dup = sameTitle.find((i) => i.state === 'open');
      if (dup) {
        warnings.push(`- "${item.title}" já existe em #${dup.number}; não criei outra.`);
        continue;
      }
      const body = `${item.body}\n\n---\nRegistrada no merge do #${pr.number}.\n${itemTag}`;
      const created = await gh.createIssue({ title: item.title, body, labels });
      issue = { number: created.number, title: item.title, state: 'open', body, html_url: created.html_url, user: { login: BOT } };
      issues.push(issue);
    }

    let linear = '';
    if (linearKey) {
      try {
        linear = ` (${await updateLinear(linearKey, issue.html_url, item.priority)})`;
      } catch (e) {
        warnings.push(`- #${issue.number}: não atualizei o Linear: ${(e as Error).message}.`);
      }
    } else if (item.priority) {
      warnings.push(`- #${issue.number}: sem \`LINEAR_API_KEY\`, a prioridade ${item.priority} não foi aplicada.`);
    }
    done.push(`- #${issue.number} ${item.title}${linear}`);
  }

  if (!done.length && !warnings.length) return;
  const summary = [
    'Pendências registradas no merge:',
    ...(done.length ? done : ['- nenhuma']),
    ...(warnings.length ? ['', 'Avisos:', ...warnings] : []),
  ].join('\n');
  console.log(summary);
  // O resumo é refeito a cada execução; só publica se o PR ainda não tiver um idêntico.
  if ((await gh.comments(pr.number)).some((c) => byBot(c) && c.body === summary)) return;
  await gh.comment(pr.number, summary);
}

if (import.meta.main) await main();
