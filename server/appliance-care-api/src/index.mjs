import { startApplianceCareHttpServer } from './http-server.mjs';
import { OpenAIResponsesClient } from './openai-responses-client.mjs';
import { createDefaultDependencies } from './service.mjs';

const ai = new OpenAIResponsesClient();
const server = startApplianceCareHttpServer({
  dependencies: createDefaultDependencies({ ai }),
  aiConfigured: ai.isConfigured,
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
server.on('listening', () => {
  process.stdout.write('Appliance-care API listening on ' + host + ':' + port
    + ' (OpenAI configured: ' + String(ai.isConfigured) + ')\n');
});
server.on('error', () => {
  process.stderr.write('Appliance-care API failed to start. Check HOST and PORT.\n');
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
