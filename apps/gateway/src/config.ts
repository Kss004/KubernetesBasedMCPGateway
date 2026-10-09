// Gateway config: everything from env, no defaults for secrets.
export interface Config {
  port: number;
  pg: { host: string; port: number; user: string; password: string; database: string };
  credKey: Buffer; // 32-byte AES-GCM key from Secret
}

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

export function loadConfig(): Config {
  const credRaw = required('CRED_KEY');
  if (credRaw.length !== 32) throw new Error('CRED_KEY must be 32 chars');
  const credKey = Buffer.from(credRaw, 'utf8');
  return {
    port: Number(process.env.PORT ?? 3000),
    pg: {
      host: process.env.PGHOST ?? 'gateway-postgres',
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'gateway',
      password: required('PGPASSWORD'),
      database: process.env.PGDATABASE ?? 'gateway',
    },
    credKey,
  };
}
