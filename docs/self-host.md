# Self-host

O `docker-compose.yml` da raiz sobe o Wayboo inteiro numa máquina sua: API, roteamento, busca e mapa. Depois do preparo inicial, nada sai para serviço externo, exceto o clima (Open-Meteo), que é opcional.

| Serviço | Imagem | Função |
| --- | --- | --- |
| `api` | `apps/api/Dockerfile` | API do Wayboo (SQLite no volume `api`) |
| `valhalla` | `ghcr.io/valhalla/valhalla-scripted` | Rotas, a partir do extrato OSM |
| `photon` | `rtuszik/photon-docker` | Busca de endereços e POIs, com índice pronto por região |
| `tiles` | `protomaps/go-pmtiles` | Tiles vetoriais do arquivo PMTiles |
| `gateway` | `caddy` | Porta única para o app |
| `osm-extract` | `alpine` | Preparo: baixa o extrato `.osm.pbf` |
| `tiles-build` | `ghcr.io/onthegomap/planetiler` | Preparo: gera o PMTiles a partir do extrato |
| `map-assets` | mesma imagem da API | Preparo: baixa estilos, fontes e sprites do OpenFreeMap e reescreve os estilos com `PUBLIC_URL` |

Os serviços de preparo rodam até terminar e só refazem o trabalho quando algo muda. Trocar `OSM_EXTRACT_URL` baixa o novo extrato e refaz o grafo do Valhalla e os tiles (ver [Atualizar os dados](#atualizar-os-dados)). Trocar `PUBLIC_URL` regrava os estilos.

O gateway expõe tudo numa porta (padrão `8080`):

| Caminho | Destino |
| --- | --- |
| `/tiles/region/{z}/{x}/{y}.mvt` | `tiles` |
| `/map/styles/light.json`, `/map/styles/dark.json` | estilos do mapa |
| `/map/fonts/...`, `/map/sprites/...` | fontes e ícones do mapa |
| qualquer outro | `api` |

## Requisitos

Os números abaixo dependem do tamanho do extrato. Referências: o extrato do Brasil na Geofabrik tem cerca de 2,1 GB e o da América do Sul, 4,2 GB (novembro de 2026).

| Parte | Disco | Memória |
| --- | --- | --- |
| Extrato OSM | o tamanho do `.pbf` | não se aplica |
| Planetiler (só no preparo) | 1 GB + 5 a 10 vezes o `.pbf`, mais cerca de 1,3 GB de dados auxiliares (água, lagos e Natural Earth) baixados uma vez | metade do tamanho do `.pbf`, no mínimo (`PLANETILER_MEMORY`) |
| PMTiles gerado | menor que o `.pbf` | o `go-pmtiles` usa um cache de 64 MB |
| Valhalla | grafo, tabelas de fuso e de limites administrativos | o build do grafo é a fase mais pesada; reduza `VALHALLA_THREADS` se o processo for encerrado por falta de memória |
| Photon | índice da região: `south-america` tem cerca de 14 GB compactado, e o índice extraído é maior | ajuste `PHOTON_MEMORY` ao tamanho do índice |
| Fontes e sprites | cerca de 100 MB | não se aplica |

Os números do Planetiler vêm do README do projeto, e os do Photon, do README do `photon-docker`. O `photon-docker` confere o espaço livre antes de baixar o índice. Para o Valhalla não há número oficial: meça com o seu extrato.

Medido: API, Valhalla, Photon e gateway com Andorra rodam numa máquina com 8 GB de RAM. Estimativa, sem medição: para o Brasil, planeje SSD e pelo menos 16 GB de RAM, por causa do índice `south-america` do Photon e do build do Valhalla.

Precisa também de Docker com o Compose v2 e de acesso à internet durante o preparo.

## Instalação

1. Copie a configuração e ajuste:

   ```sh
   cp .env.example .env
   ```

   - `PUBLIC_URL`: a URL com que o celular chega ao gateway, por exemplo `http://192.168.0.10:8080`. Ela vai dentro dos estilos do mapa, então `localhost` só funciona no navegador da própria máquina.
   - `OSM_EXTRACT_URL`: o `.osm.pbf` da região. A Geofabrik tem extratos por país e por região do Brasil, por exemplo `https://download.geofabrik.de/south-america/brazil/sudeste-latest.osm.pbf`.
   - `PHOTON_REGION`: a região do índice de busca. O `photon-docker` só tem índice pronto para algumas regiões; o Brasil está dentro de `south-america`. A lista fica no README do [`photon-docker`](https://github.com/rtuszik/photon-docker#available-regions).

2. Suba a stack:

   ```sh
   docker compose up -d --build
   ```

   A primeira subida baixa o extrato, gera os tiles, constrói o grafo do Valhalla e baixa o índice do Photon. Com um extrato estadual isso leva de minutos a horas. Acompanhe com:

   ```sh
   docker compose logs -f tiles-build valhalla photon
   ```

3. Confira:

   ```sh
   curl http://localhost:8080/health
   ```

   A resposta traz `map` com as URLs dos estilos. Busca e rotas ficam disponíveis quando `photon` e `valhalla` aparecem como `healthy` em `docker compose ps`.

4. No app, abra Ajustes, troque a URL do servidor pela `PUBLIC_URL` e toque em testar. O status mostra "Mapa do próprio servidor". O app lê os estilos em `/health` e os guarda, então o mapa já abre pelo servidor próprio no próximo início.

## HTTPS

Por padrão o gateway serve HTTP. Nesse modo, o token do aparelho e as rotas passam em texto claro, e qualquer um na mesma rede pode lê-los. Use HTTP só numa rede em que você confia, ou por uma VPN como Tailscale ou WireGuard.

Com um domínio que aponta para a máquina e as portas 80 e 443 abertas na internet, o Caddy emite e renova o certificado sozinho (Let's Encrypt):

```sh
GATEWAY_ADDRESS=wayboo.example.com
GATEWAY_PORT=80
GATEWAY_HTTPS_PORT=443
PUBLIC_URL=https://wayboo.example.com
```

A renovação do certificado é uma chamada externa periódica. Os certificados ficam no volume `caddy`.

Se outro proxy já termina o TLS, deixe `GATEWAY_ADDRESS=:80` e publique o gateway só para esse proxy com `GATEWAY_BIND=127.0.0.1`. Assim ninguém na rede chega ao HTTP direto.

## O que ainda chama serviço externo

- Clima: a API consulta o Open-Meteo (`OPEN_METEO_URL`). Sem acesso, o ETA segue sem o fator clima.
- IA: só se o `.env` configurar um provedor remoto. `AI_PROVIDER=ollama` com um Ollama na rede local mantém tudo dentro.
- Preparo: extrato (Geofabrik ou a URL configurada), dados auxiliares do Planetiler, índice do Photon, estilos, fontes e sprites do OpenFreeMap e a tabela de velocidades padrão do Valhalla. Tudo isso é baixado uma vez e fica nos volumes.

O índice do Photon não se atualiza sozinho (`UPDATE_STRATEGY=DISABLED`), porque a atualização baixaria o índice de novo de um espelho externo. Para atualizar, apague o volume e suba de novo:

```sh
docker compose rm -sf photon && docker volume rm wayboo_photon && docker compose up -d
```

## Atualizar os dados

- Mapa e rotas: o mesmo `OSM_EXTRACT_URL` não baixa de novo. Para buscar um extrato mais novo, apague o arquivo. Para trocar de região, mude `OSM_EXTRACT_URL` no `.env`. Nos dois casos, suba de novo e reinicie `valhalla` e `tiles`:

  ```sh
  docker compose run --rm osm-extract rm /custom_files/region.osm.pbf   # só para atualizar a mesma URL
  docker compose up -d
  docker compose restart valhalla tiles
  ```

  O `osm-extract` grava o sha256 do extrato. Se o conteúdo mudou, ele apaga o grafo e o banco de limites do Valhalla, e o `tiles-build` gera um novo PMTiles. O `docker compose up -d` não reinicia contêineres que já estão rodando. Por isso o `restart` é necessário: ao iniciar sem grafo, o Valhalla o reconstrói, e o `go-pmtiles` passa a ler o arquivo novo. Se o conteúdo não mudou, nada é refeito. A geração dos tiles grava em `build/` e só troca o arquivo no fim, então uma interrupção mantém o mapa anterior.

- Estilos do mapa: apague `upstream/` no volume `map` para baixar os estilos atuais do OpenFreeMap:

  ```sh
  docker compose run --rm map-assets sh -c 'rm -rf /srv/map/upstream'
  docker compose up -d
  ```

## Volumes

| Volume | Conteúdo |
| --- | --- |
| `osm` | extrato `.pbf` e grafo do Valhalla |
| `tiles` | `region.pmtiles` e dados auxiliares do Planetiler |
| `map` | estilos, fontes e sprites |
| `photon` | índice do Photon |
| `api` | banco SQLite da API |
| `caddy` | certificados do HTTPS |

`docker compose down -v` apaga todos, inclusive o banco da API.
