import { buildApp } from './app';
import { llm } from './ai/providers';
import { config } from './config';

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
app.log.info(`IA: ${llm ? `${llm.name} / ${llm.model}` : 'desativada (modo regras)'}`);
